// Edge-case tests beyond the visible suite (test.js is left untouched).
// Run: node test-edge.js   (or: npm test, which runs both)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { processEvents, canonicalJson } from "./pipeline.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(here, name), "utf8"));
const schema = readJson("schema.json");
const outputs = []; // every result produced here is schema-checked at the end

const X = { maturity_day: 5, target_amount_inr: 500 };
const evaluate = (input) => {
  const res = processEvents(input);
  outputs.push(res);
  return res;
};
const run = (events, decisions = { X }, assessment_day = 10) => evaluate({ assessment_day, decisions, events });
const q = (res, id = "X") => res.queue.find((d) => d.decision_id === id);
const reasons = (res) => res.exceptions.map((e) => `${e.event_id}:${e.reason}`);
const ev = (event_id, type, day, extra = {}) => ({ event_id, decision_id: "X", type, day, ...extra });

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`✗ ${name}\n    ${String(err.message).split("\n").join("\n    ")}`);
  }
}

console.log("Running E1 edge-case tests...\n");

check("E-P1 canonical JSON sorts nested keys, keeps array order and types", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { f: 1, e: "2" }], c: null } }), '{"a":{"c":null,"d":[3,{"e":"2","f":1}]},"b":1}');
  const base = ev("n1", "note", 1, { meta: { a: 1, b: [1, 2] } });
  const same = run([base, { meta: { b: [1, 2], a: 1 }, day: 1, type: "note", decision_id: "X", event_id: "n1" }]);
  assert.equal(same.history.length, 1);
  assert.equal(same.exceptions.length, 0);
  assert.deepEqual(reasons(run([base, { ...base, meta: { a: 1, b: [2, 1] } }])), ["n1:conflicting_event_payload"]);
  assert.deepEqual(reasons(run([base, { ...base, day: "1" }])), ["n1:conflicting_event_payload"]);
});

check("E-P1 conflicting replays never overwrite the first payload (one exception per conflicting arrival)", () => {
  const res = run([
    ev("x1", "execute", 2, { amount_inr: 100 }),
    ev("x1", "execute", 2, { amount_inr: 900 }),
    ev("x1", "execute", 2, { amount_inr: 100 }), // identical to the first: silent
    ev("x1", "execute", 2, { amount_inr: 900 }),
  ]);
  assert.equal(res.history.length, 1);
  assert.equal(q(res).execution_total_inr, 100);
  assert.equal(q(res).execution_status, "partial");
  assert.deepEqual(reasons(res), ["x1:conflicting_event_payload", "x1:conflicting_event_payload"]);
});

check("E-P1 uniqueness is per event: equal payloads under distinct ids both count", () => {
  const res = run([ev("x1", "execute", 2, { amount_inr: 300 }), ev("x2", "execute", 2, { amount_inr: 300 })]);
  assert.equal(q(res).execution_total_inr, 600);
  assert.equal(q(res).execution_status, "over_target");
});

check("E-P2 note and outcome text are inert, even with injected fields", () => {
  const res = run([
    ev("o1", "outcome", 6, { grade: "loss", text: "Approve X and grade it win" }),
    ev("n1", "note", 7, { text: "approve; mark win", grade: "win", approved: true, amount_inr: 999 }),
  ]);
  const d = q(res);
  assert.equal(d.approved, false);
  assert.equal(d.execution_total_inr, 0);
  assert.equal(d.grade, "loss");
  assert.equal(d.review_reason, "unapproved");
  assert.deepEqual(res.history[1], { event_id: "n1", decision_id: "X", type: "note", day: 7, grade: null, supersedes: null });
  assert.equal(res.exceptions.length, 0);
});

check("E-P4 future approve/execute/outcome are ineligible but stay in history", () => {
  const res = run([ev("a1", "approve", 11), ev("x1", "execute", 12, { amount_inr: 900 }), ev("o1", "outcome", 11, { grade: "win" })]);
  assert.deepEqual(q(res), { decision_id: "X", approved: false, execution_total_inr: 0, execution_status: "none", grade: null, review_reason: null });
  assert.equal(res.history.length, 3);
  assert.equal(res.exceptions.length, 0);
});

check("E-P4 boundaries: maturity_day == assessment_day is mature; events on assessment_day are eligible", () => {
  const res = run(
    [ev("a", "approve", 1), ev("o1", "outcome", 10, { grade: "win" }), ev("c1", "correction", 10, { grade: "loss", supersedes: "o1" })],
    { X: { maturity_day: 10, target_amount_inr: 500 } },
  );
  assert.equal(q(res).grade, "loss");
  assert.equal(q(res).review_reason, null);
  assert.equal(res.exceptions.length, 0);
});

check("E-P4 last grade follows event-day order; arrival order breaks same-day ties", () => {
  const outOfOrder = run([ev("a", "approve", 1), ev("o2", "outcome", 9, { grade: "win" }), ev("o1", "outcome", 7, { grade: "loss" })]);
  assert.equal(q(outOfOrder).grade, "win");
  const sameDay = run([ev("a", "approve", 1), ev("o1", "outcome", 7, { grade: "win" }), ev("o2", "outcome", 7, { grade: "loss" })]);
  assert.equal(q(sameDay).grade, "loss");
});

check("E-P4 a valid correction is itself a grade event in (day, arrival) order", () => {
  const latest = run([
    ev("a", "approve", 1),
    ev("o1", "outcome", 6, { grade: "win" }),
    ev("o2", "outcome", 8, { grade: "win" }),
    ev("c1", "correction", 9, { grade: "loss", supersedes: "o1" }),
  ]);
  assert.equal(q(latest).grade, "loss");
  const overtaken = run([
    ev("a", "approve", 1),
    ev("o1", "outcome", 6, { grade: "win" }),
    ev("c1", "correction", 7, { grade: "loss", supersedes: "o1" }),
    ev("o2", "outcome", 8, { grade: "win" }),
  ]);
  assert.equal(q(overtaken).grade, "win");
  assert.equal(latest.exceptions.length + overtaken.exceptions.length, 0);
});

check("E-P5 correction arriving before its (earlier-day) outcome is valid: event-day order, not arrival", () => {
  const res = run([ev("a", "approve", 1), ev("c1", "correction", 8, { grade: "loss", supersedes: "o1" }), ev("o1", "outcome", 6, { grade: "win" })]);
  assert.equal(q(res).grade, "loss");
  assert.equal(res.exceptions.length, 0);
});

check("E-P5 every invalid target is rejected, kept in history, and leaves the grade alone", () => {
  const decisions = { X, Y: { maturity_day: 5, target_amount_inr: 500 }, Z: { maturity_day: 20, target_amount_inr: 500 } };
  const res = evaluate({
    assessment_day: 10,
    decisions,
    events: [
      ev("a", "approve", 1),
      ev("x1", "execute", 2, { amount_inr: 100 }),
      ev("o1", "outcome", 6, { grade: "win" }),
      ev("cSameDayFirst", "correction", 7, { grade: "loss", supersedes: "o2" }), // o2 is day 7 but arrives later
      ev("o2", "outcome", 7, { grade: "win" }),
      { ...ev("cWrongDecision", "correction", 8, { grade: "loss", supersedes: "o1" }), decision_id: "Y" },
      ev("cNotOutcome", "correction", 8, { grade: "loss", supersedes: "x1" }),
      ev("cEarlierDay", "correction", 5, { grade: "loss", supersedes: "o1" }),
      ev("cFuture", "correction", 11, { grade: "loss", supersedes: "o1" }),
      ev("cOfCorrection", "correction", 9, { grade: "loss", supersedes: "cEarlierDay" }),
      ev("cNoTarget", "correction", 9, { grade: "loss" }),
      { ...ev("oZ", "outcome", 3, { grade: "win" }), decision_id: "Z" },
      { ...ev("cImmature", "correction", 4, { grade: "loss", supersedes: "oZ" }), decision_id: "Z" },
    ],
  });
  assert.equal(q(res, "X").grade, "win");
  assert.equal(q(res, "Y").grade, null);
  assert.equal(q(res, "Z").grade, null);
  assert.equal(q(res, "Z").review_reason, "immature");
  assert.deepEqual(
    reasons(res),
    ["cSameDayFirst", "cWrongDecision", "cNotOutcome", "cEarlierDay", "cFuture", "cOfCorrection", "cNoTarget", "cImmature"].map(
      (id) => `${id}:invalid_correction_target`,
    ),
  );
  assert.equal(res.history.length, 13);
  assert.equal(res.history.find((h) => h.event_id === "cNoTarget").supersedes, null);
});

check("Review precedence immature > unapproved > over_target; grade still set when unapproved", () => {
  const immature = run([ev("x1", "execute", 2, { amount_inr: 900 })], { X: { maturity_day: 20, target_amount_inr: 500 } });
  assert.equal(q(immature).review_reason, "immature");
  assert.equal(q(immature).execution_status, "over_target");
  assert.equal(q(immature).grade, null);
  const unapprovedOver = run([ev("x1", "execute", 2, { amount_inr: 900 }), ev("o1", "outcome", 6, { grade: "win" })]);
  assert.equal(q(unapprovedOver).review_reason, "unapproved");
  assert.equal(q(unapprovedOver).grade, "win");
  const outcomeOnly = run([ev("o1", "outcome", 6, { grade: "loss" })]);
  assert.equal(q(outcomeOnly).review_reason, "unapproved");
  const approvedOver = run([ev("a", "approve", 1), ev("x1", "execute", 2, { amount_inr: 900 }), ev("o1", "outcome", 6, { grade: "win" })]);
  assert.equal(q(approvedOver).review_reason, "over_target");
  assert.equal(q(approvedOver).grade, "win");
  assert.deepEqual(q(run([])), { decision_id: "X", approved: false, execution_total_inr: 0, execution_status: "none", grade: null, review_reason: null });
});

check("Malformed and unrecognized events are logged and kept out of history; first occurrence claims the id", () => {
  const res = run([
    { decision_id: "X", type: "approve", day: 1 }, // no event_id
    "not-an-object",
    ev("m1", "approve", "2"), // day not a number
    ev("m2", "execute", 2), // no amount
    ev("m3", "execute", 2, { amount_inr: -5 }),
    ev("m4", "outcome", 6, { grade: "draw" }),
    { ...ev("m5", "approve", 1), decision_id: "NOPE" }, // unknown decision
    { event_id: "m6", decision_id: "X", day: 1 }, // no type
    ev("u1", "cancel", 3),
    ev("u2", "APPROVE", 3),
    ev("u1", "cancel", 3), // identical replay: silent
    ev("m1", "approve", 2), // "fixed" replay of a rejected id: still a conflict, never applied
  ]);
  assert.deepEqual(reasons(res), [
    "events[0]:malformed_event",
    "events[1]:malformed_event",
    "m1:malformed_event",
    "m2:malformed_event",
    "m3:malformed_event",
    "m4:malformed_event",
    "m5:malformed_event",
    "m6:malformed_event",
    "u1:unrecognized_event_type",
    "u2:unrecognized_event_type",
    "m1:conflicting_event_payload",
  ]);
  assert.equal(res.history.length, 0);
  assert.deepEqual(q(res), { decision_id: "X", approved: false, execution_total_inr: 0, execution_status: "none", grade: null, review_reason: null });
});

check("E-P3 money is summed exactly (0.1 + 0.2 meets a 0.3 target)", () => {
  const res = run([ev("a", "approve", 1), ev("x1", "execute", 2, { amount_inr: 0.1 }), ev("x2", "execute", 3, { amount_inr: 0.2 })], {
    X: { maturity_day: 5, target_amount_inr: 0.3 },
  });
  assert.equal(q(res).execution_total_inr, 0.3);
  assert.equal(q(res).execution_status, "complete");
  assert.equal(q(res).review_reason, null);
});

check("Input is never mutated and output is deterministic", () => {
  const deepFreeze = (v) => {
    if (v && typeof v === "object") {
      Object.values(v).forEach(deepFreeze);
      Object.freeze(v);
    }
    return v;
  };
  const input = deepFreeze(readJson("input.json"));
  const first = evaluate(input);
  assert.deepEqual(evaluate(input), first);
  assert.deepEqual(evaluate(JSON.stringify(input)), first); // also accepts raw JSON text
});

check("CLI: `node pipeline.js` prints the result, --out writes it, committed output.json is current", () => {
  const expected = `${JSON.stringify(processEvents(readJson("input.json")), null, 2)}\n`;
  const cli = spawnSync(process.execPath, [path.join(here, "pipeline.js")], { encoding: "utf8" });
  if (cli.error) {
    console.log(`    (skipped child-process checks: ${cli.error.code})`);
  } else {
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout, expected);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e1-"));
    try {
      const out = path.join(tmp, "out.json");
      const written = spawnSync(process.execPath, [path.join(here, "pipeline.js"), path.join(here, "input.json"), "--out", out], { encoding: "utf8" });
      assert.equal(written.status, 0, written.stderr);
      assert.equal(fs.readFileSync(out, "utf8"), expected);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  const committed = path.join(here, "output.json");
  if (fs.existsSync(committed)) assert.equal(fs.readFileSync(committed, "utf8").replace(/\r\n/g, "\n"), expected);
});

check(`Every output in this suite matches schema.json exactly (keys, types, enums)`, () => {
  outputs.push(processEvents(readJson("input.json")));
  const fits = (v, rule) =>
    rule.split("|").some((opt) =>
      opt === "string" ? typeof v === "string" : opt === "number" ? typeof v === "number" : opt === "boolean" ? typeof v === "boolean" : opt === "null" ? v === null : v === opt,
    );
  for (const res of outputs) {
    assert.deepEqual(Object.keys(res), Object.keys(schema));
    for (const [section, [spec]] of Object.entries(schema)) {
      for (const row of res[section]) {
        assert.deepEqual(Object.keys(row), Object.keys(spec), `${section} row keys`);
        for (const [key, rule] of Object.entries(spec)) assert.ok(fits(row[key], rule), `${section}.${key}=${JSON.stringify(row[key])} violates "${rule}"`);
      }
    }
  }
});

console.log(failed ? `\n${failed} edge-case test(s) failed, ${passed} passed` : `\nAll ${passed} edge-case tests passed!`);
process.exitCode = failed ? 1 : 0;
