// E1 engineering pipeline (fixed). Node >= 20, zero dependencies.
//   node pipeline.js [input.json] [--out output.json]
//
// Stages: 1) identity + structural dedup (E-P1)  2) validation  3) evaluation on
// assessment_day (E-P2..E-P5). Only typed fields are ever read from an event
// (amount_inr, grade, supersedes), so free text in notes or outcomes can never
// change business state.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EVENT_TYPES = new Set(["recommend", "approve", "execute", "outcome", "correction", "note"]);
const GRADES = new Set(["win", "loss"]);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isId = (v) => typeof v === "string" && v.length > 0;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Canonical JSON text: object keys sorted recursively; array order, value types and
 * JSON semantics (undefined members dropped, NaN -> null) preserved.
 * Two payloads are structurally equal iff their canonical texts are equal.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (typeof value.toJSON === "function") return canonicalJson(value.toJSON());
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v) ?? "null").join(",")}]`;
  const members = [];
  for (const key of Object.keys(value).sort()) {
    const text = canonicalJson(value[key]);
    if (text !== undefined) members.push(`${JSON.stringify(key)}:${text}`);
  }
  return `{${members.join(",")}}`;
}

/** Digits after the decimal point in the shortest round-trip form of n (0.25 -> 2, 1e-7 -> 7). */
function decimalPlaces(n) {
  const m = /^-?\d+(?:\.(\d+))?(?:e([+-]\d+))?$/i.exec(String(n));
  return m ? Math.max(0, (m[1]?.length ?? 0) - Number(m[2] ?? 0)) : 0;
}

/**
 * Exact money total + status (E-P3). Amounts are scaled to integers at the finest decimal
 * precision present, so 0.1 + 0.2 meets a 0.3 target exactly. Falls back to plain float
 * maths only if scaling would leave the safe-integer range.
 */
function summarizeExecution(amounts, target) {
  const places = Math.min(9, amounts.reduce((p, a) => Math.max(p, decimalPlaces(a)), decimalPlaces(target)));
  const scale = 10 ** places;
  const scaledTotal = amounts.reduce((sum, a) => sum + Math.round(a * scale), 0);
  const scaledTarget = Math.round(target * scale);
  const exact = Number.isSafeInteger(scaledTotal) && Number.isSafeInteger(scaledTarget);
  const total = exact ? scaledTotal : amounts.reduce((sum, a) => sum + a, 0);
  const goal = exact ? scaledTarget : target;
  const status = total === 0 ? "none" : total < goal ? "partial" : total === goal ? "complete" : "over_target";
  return { total: exact ? scaledTotal / scale : total, status };
}

// Decisions are configuration. Fail closed if malformed: never mature, zero budget.
function decisionConfig(raw) {
  const d = isObject(raw) ? raw : {};
  return {
    maturityDay: isNum(d.maturity_day) ? d.maturity_day : null,
    target: isNum(d.target_amount_inr) ? d.target_amount_inr : 0,
  };
}

/** Why a first-occurrence event cannot be applied, or null if it is well formed. */
function rejectionReason(ev, decisions) {
  if (!isId(ev.type)) return "malformed_event";
  if (!EVENT_TYPES.has(ev.type)) return "unrecognized_event_type";
  if (!isId(ev.decision_id) || !Object.hasOwn(decisions, ev.decision_id) || !isNum(ev.day)) return "malformed_event";
  if (ev.type === "execute" && !(isNum(ev.amount_inr) && ev.amount_inr >= 0)) return "malformed_event";
  if ((ev.type === "outcome" || ev.type === "correction") && !GRADES.has(ev.grade)) return "malformed_event";
  return null;
}

const fallbackId = (ev, index) => (isObject(ev) && isNum(ev.event_id) ? String(ev.event_id) : `events[${index}]`);

export function processEvents(input) {
  const src = typeof input === "string" ? JSON.parse(input.replace(/^﻿/, "")) : isObject(input) ? input : {};
  const asOf = isNum(src.assessment_day) ? src.assessment_day : Infinity;
  const decisions = isObject(src.decisions) ? src.decisions : {};
  const events = Array.isArray(src.events) ? src.events : [];

  const rejected = []; // { index, event_id, reason }
  const accepted = []; // { index, ev }: valid first occurrences, arrival order
  const firstPayload = new Map(); // event_id -> canonical JSON of its first occurrence

  // 1-2. Identity, structural dedup and validation, in arrival order (E-P1).
  events.forEach((ev, index) => {
    if (!isObject(ev) || !isId(ev.event_id)) {
      rejected.push({ index, event_id: fallbackId(ev, index), reason: "malformed_event" });
      return;
    }
    const reject = (reason) => rejected.push({ index, event_id: ev.event_id, reason });
    let payload;
    try {
      payload = canonicalJson(ev);
    } catch {
      reject("malformed_event"); // not JSON-representable (BigInt, cycle)
      return;
    }
    if (firstPayload.has(ev.event_id)) {
      // Identical replay: no row, no exception. Different payload: never applied.
      if (firstPayload.get(ev.event_id) !== payload) reject("conflicting_event_payload");
      return;
    }
    firstPayload.set(ev.event_id, payload); // the first occurrence claims the id, valid or not
    const reason = rejectionReason(ev, decisions);
    if (reason) reject(reason);
    else accepted.push({ index, ev });
  });

  // 3. Evaluate business state as of assessment_day.
  const config = new Map(Object.keys(decisions).map((id) => [id, decisionConfig(decisions[id])]));
  const isMature = (id) => {
    const { maturityDay } = config.get(id);
    return maturityDay !== null && asOf >= maturityDay; // immature iff assessment_day < maturity_day
  };
  const state = new Map([...config.keys()].map((id) => [id, { approved: false, amounts: [], outcomes: 0, grades: [] }]));
  const outcomesById = new Map(accepted.filter(({ ev }) => ev.type === "outcome").map((o) => [o.ev.event_id, o]));

  // E-P5: validated against the whole deduped stream, so arrival order only matters on the same day.
  const isValidCorrection = (ev, index) => {
    const target = outcomesById.get(ev.supersedes); // must name an accepted outcome...
    if (!target || target.ev.decision_id !== ev.decision_id) return false; // ...of the same decision
    const later = ev.day > target.ev.day || (ev.day === target.ev.day && index > target.index);
    return later && ev.day <= asOf && isMature(ev.decision_id);
  };

  for (const { index, ev } of accepted) {
    const s = state.get(ev.decision_id);
    const eligible = ev.day <= asOf; // day > assessment_day: future event, ineligible today
    if (ev.type === "approve") {
      if (eligible) s.approved = true;
    } else if (ev.type === "execute") {
      if (eligible) s.amounts.push(ev.amount_inr);
    } else if (ev.type === "outcome") {
      if (eligible) {
        s.outcomes += 1;
        s.grades.push({ day: ev.day, index, grade: ev.grade });
      }
    } else if (ev.type === "correction") {
      if (isValidCorrection(ev, index)) s.grades.push({ day: ev.day, index, grade: ev.grade });
      else rejected.push({ index, event_id: ev.event_id, reason: "invalid_correction_target" });
    }
    // recommend and note events are history only (E-P2).
  }

  const queue = [...config].map(([id, { target }]) => {
    const s = state.get(id);
    const { total, status } = summarizeExecution(s.amounts, target);
    const mature = isMature(id);
    // E-P4: last mature outcome or valid correction by event day, arrival order breaking ties.
    s.grades.sort((a, b) => a.day - b.day || a.index - b.index);
    const grade = mature && s.grades.length > 0 ? s.grades.at(-1).grade : null;
    let review_reason = null;
    if (!mature) review_reason = "immature";
    else if (!s.approved && (total > 0 || s.outcomes > 0)) review_reason = "unapproved";
    else if (s.approved && status === "over_target") review_reason = "over_target";
    return {
      decision_id: id,
      approved: s.approved,
      execution_total_inr: total,
      execution_status: status,
      grade,
      review_reason,
    };
  });

  const history = accepted.map(({ ev }) => ({
    event_id: ev.event_id,
    decision_id: ev.decision_id,
    type: ev.type,
    day: ev.day,
    grade: ev.type === "outcome" || ev.type === "correction" ? ev.grade : null,
    supersedes: ev.type === "correction" && typeof ev.supersedes === "string" ? ev.supersedes : null,
  }));

  const exceptions = rejected
    .sort((a, b) => a.index - b.index)
    .map(({ event_id, reason }) => ({ event_id, reason }));

  return { history, queue, exceptions };
}

export default processEvents;

/** True when run as `node pipeline.js`. The starter's `file://${argv[1]}` check never matches on Windows. */
function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const entry = fs.realpathSync(path.resolve(process.argv[1]));
    return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const args = process.argv.slice(2);
  const outFlag = args.indexOf("--out");
  const outPath = outFlag === -1 ? null : args[outFlag + 1];
  if (outFlag !== -1 && !outPath) {
    console.error("usage: node pipeline.js [input.json] [--out output.json]");
    process.exit(2);
  }
  const positional = outFlag === -1 ? args : args.filter((_, i) => i !== outFlag && i !== outFlag + 1);
  const inputPath = positional[0] ? path.resolve(positional[0]) : fileURLToPath(new URL("./input.json", import.meta.url));
  const text = `${JSON.stringify(processEvents(fs.readFileSync(inputPath, "utf8")), null, 2)}\n`;
  process.stdout.write(text);
  if (outPath) fs.writeFileSync(path.resolve(outPath), text);
}
