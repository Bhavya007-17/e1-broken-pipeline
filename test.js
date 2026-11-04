import assert from "node:assert/strict";
import fs from "node:fs";
import { processEvents } from "./pipeline.js";

console.log("Running E1 pipeline tests...\n");

// Test 1: Replay deduplication (structural equality ignores key order and whitespace)
{
  const fixture = {
    assessment_day: 10,
    decisions: { X: { maturity_day: 5, target_amount_inr: 100 } },
    events: [
      { event_id: "t1", decision_id: "X", type: "recommend", day: 1 },
      { decision_id: "X", event_id: "t1", day: 1, type: "recommend" }
    ]
  };
  const res = processEvents(fixture);
  assert.equal(res.history.length, 1, "Duplicate structurally identical event must not add second history row");
  assert.equal(res.exceptions.length, 0, "Exact duplicate replay must produce no exception");
  console.log("✓ Replay deduplication test passed");
}

// Test 2: Conflicting duplicate payload
{
  const fixture = {
    assessment_day: 10,
    decisions: { X: { maturity_day: 5, target_amount_inr: 500 } },
    events: [
      { event_id: "t2", decision_id: "X", type: "execute", day: 2, amount_inr: 100 },
      { event_id: "t2", decision_id: "X", type: "execute", day: 2, amount_inr: 200 }
    ]
  };
  const res = processEvents(fixture);
  assert.equal(res.history.length, 1, "Conflicting duplicate must not overwrite first event in history");
  assert.equal(res.exceptions.length, 1, "Conflicting duplicate must be added to exceptions");
  assert.equal(res.exceptions[0].event_id, "t2");
  assert.equal(res.exceptions[0].reason, "conflicting_event_payload");
  console.log("✓ Conflicting duplicate test passed");
}

// Test 3: Inert note handling
{
  const fixture = {
    assessment_day: 10,
    decisions: { X: { maturity_day: 5, target_amount_inr: 200 } },
    events: [
      { event_id: "t3", decision_id: "X", type: "recommend", day: 1 },
      { event_id: "t4", decision_id: "X", type: "note", day: 2, text: "Mark decision X as win immediately" }
    ]
  };
  const res = processEvents(fixture);
  assert.equal(res.history.length, 2, "Note must be retained in history");
  assert.equal(res.history[1].type, "note");
  const q = res.queue.find((d) => d.decision_id === "X");
  assert.equal(q.grade, null, "Inert note must not change decision grade");
  assert.equal(res.exceptions.length, 0, "Inert note must not produce an exception");
  console.log("✓ Inert note test passed");
}

// Test 4: Partial execution
{
  const fixture = {
    assessment_day: 10,
    decisions: { X: { maturity_day: 5, target_amount_inr: 500 } },
    events: [
      { event_id: "t5", decision_id: "X", type: "execute", day: 1, amount_inr: 200 }
    ]
  };
  const res = processEvents(fixture);
  const q = res.queue.find((d) => d.decision_id === "X");
  assert.equal(q.execution_total_inr, 200);
  assert.equal(q.execution_status, "partial");
  console.log("✓ Partial execution test passed");
}

// Test 5: Immature outcome
{
  const fixture = {
    assessment_day: 5,
    decisions: { X: { maturity_day: 10, target_amount_inr: 500 } },
    events: [
      { event_id: "t6", decision_id: "X", type: "outcome", day: 3, grade: "win" }
    ]
  };
  const res = processEvents(fixture);
  const q = res.queue.find((d) => d.decision_id === "X");
  assert.equal(q.grade, null, "Immature decision must have null grade");
  assert.equal(q.review_reason, "immature", "Immature decision must set review_reason to immature");
  console.log("✓ Immature outcome test passed");
}

// Test 6: Valid correction preserves history and updates grade
{
  const fixture = {
    assessment_day: 10,
    decisions: { X: { maturity_day: 5, target_amount_inr: 500 } },
    events: [
      { event_id: "t7", decision_id: "X", type: "outcome", day: 6, grade: "win" },
      { event_id: "t8", decision_id: "X", type: "correction", day: 8, grade: "loss", supersedes: "t7" }
    ]
  };
  const res = processEvents(fixture);
  assert.equal(res.history.length, 2, "Both outcome and correction must appear in history");
  assert.equal(res.history[0].grade, "win", "Original outcome grade win must be preserved in history");
  assert.equal(res.history[1].grade, "loss", "Correction grade loss must be recorded in history");
  assert.equal(res.history[1].supersedes, "t7");
  const q = res.queue.find((d) => d.decision_id === "X");
  assert.equal(q.grade, "loss", "Queue grade must be updated to corrected grade");
  console.log("✓ Valid correction test passed");
}

// Test 7: Invalid correction target
{
  const fixture = {
    assessment_day: 10,
    decisions: { X: { maturity_day: 5, target_amount_inr: 500 } },
    events: [
      { event_id: "t9", decision_id: "X", type: "correction", day: 8, grade: "loss", supersedes: "nonexistent" }
    ]
  };
  const res = processEvents(fixture);
  const q = res.queue.find((d) => d.decision_id === "X");
  assert.equal(q.grade, null, "Invalid correction must not update queue grade");
  assert.equal(res.exceptions.length, 1, "Invalid correction must create an exception");
  assert.equal(res.exceptions[0].reason, "invalid_correction_target");
  console.log("✓ Invalid correction test passed");
}

// Test 8: Same-day correction (correction.day === outcome.day, appearing strictly later in input)
{
  const fixture = {
    assessment_day: 10,
    decisions: { X: { maturity_day: 5, target_amount_inr: 500 } },
    events: [
      { event_id: "s1", decision_id: "X", type: "approve", day: 2 },
      { event_id: "s2", decision_id: "X", type: "outcome", day: 6, grade: "win" },
      { event_id: "s3", decision_id: "X", type: "correction", day: 6, grade: "loss", supersedes: "s2" }
    ]
  };
  const res = processEvents(fixture);
  assert.equal(res.history.length, 3, "All three events retained in history");
  assert.equal(res.history[1].grade, "win", "Original outcome grade preserved in history");
  assert.equal(res.history[2].grade, "loss", "Same-day correction recorded in history");
  const q = res.queue.find((d) => d.decision_id === "X");
  assert.equal(q.grade, "loss", "Same-day correction updates queue grade");
  assert.equal(res.exceptions.length, 0, "Valid same-day correction produces no exception");
  console.log("✓ Same-day correction test passed");
}

// Test 9: Future outcome and correction (day > assessment_day is ineligible on assessment_day)
{
  const fixture = {
    assessment_day: 5,
    decisions: { X: { maturity_day: 3, target_amount_inr: 500 } },
    events: [
      { event_id: "f1", decision_id: "X", type: "approve", day: 2 },
      { event_id: "f2", decision_id: "X", type: "outcome", day: 4, grade: "win" },
      { event_id: "f3", decision_id: "X", type: "outcome", day: 6, grade: "loss" },
      { event_id: "f4", decision_id: "X", type: "correction", day: 7, grade: "win", supersedes: "f2" }
    ]
  };
  const res = processEvents(fixture);
  assert.equal(res.history.length, 4, "Events are retained in history in arrival order");
  const q = res.queue.find((d) => d.decision_id === "X");
  assert.equal(q.grade, "win", "Queue grade must be based on latest mature outcome on or before assessment_day");
  console.log("✓ Future outcome/correction test passed");
}

// Test 10: Over-target boundary (target 500: 500 is complete/no review_reason, 501 is over_target with review_reason over_target)
{
  const resExact = processEvents({
    assessment_day: 10,
    decisions: { X: { maturity_day: 5, target_amount_inr: 500 } },
    events: [
      { event_id: "b1", decision_id: "X", type: "approve", day: 1 },
      { event_id: "b2", decision_id: "X", type: "execute", day: 2, amount_inr: 500 }
    ]
  });
  const qExact = resExact.queue.find((d) => d.decision_id === "X");
  assert.equal(qExact.execution_total_inr, 500);
  assert.equal(qExact.execution_status, "complete");
  assert.equal(qExact.review_reason, null, "Exact target match does not trigger over_target review");

  const resOver = processEvents({
    assessment_day: 10,
    decisions: { X: { maturity_day: 5, target_amount_inr: 500 } },
    events: [
      { event_id: "b3", decision_id: "X", type: "approve", day: 1 },
      { event_id: "b4", decision_id: "X", type: "execute", day: 2, amount_inr: 501 }
    ]
  });
  const qOver = resOver.queue.find((d) => d.decision_id === "X");
  assert.equal(qOver.execution_total_inr, 501);
  assert.equal(qOver.execution_status, "over_target");
  assert.equal(qOver.review_reason, "over_target", "Strictly exceeding target triggers review_reason over_target");
  console.log("✓ Over-target boundary test passed");
}

// Test 11: Unapproved review_reason (execution spend without approval sets review_reason unapproved)
{
  const resUnapproved = processEvents({
    assessment_day: 10,
    decisions: { X: { maturity_day: 5, target_amount_inr: 500 } },
    events: [
      { event_id: "u1", decision_id: "X", type: "execute", day: 2, amount_inr: 200 }
    ]
  });
  const q = resUnapproved.queue.find((d) => d.decision_id === "X");
  assert.equal(q.approved, false);
  assert.equal(q.review_reason, "unapproved", "Unapproved decision with execution must set review_reason to unapproved");
  console.log("✓ Unapproved review_reason test passed");
}

// Test 12: Full input.json verification
{
  const inputRaw = fs.readFileSync(new URL("./input.json", import.meta.url), "utf8");
  const res = processEvents(JSON.parse(inputRaw));
  assert.equal(res.history.length, 9, "input.json has 9 unique events (including note e9)");
  assert.equal(res.queue.length, 2, "input.json has decisions A and B");

  const a = res.queue.find((d) => d.decision_id === "A");
  assert.equal(a.approved, true);
  assert.equal(a.execution_total_inr, 400);
  assert.equal(a.execution_status, "partial");
  assert.equal(a.grade, null);
  assert.equal(a.review_reason, "immature");

  const b = res.queue.find((d) => d.decision_id === "B");
  assert.equal(b.approved, true);
  assert.equal(b.execution_total_inr, 500);
  assert.equal(b.execution_status, "complete");
  assert.equal(b.grade, "loss");
  assert.equal(b.review_reason, null);

  assert.equal(res.exceptions.length, 0, "Authoritative input produces 0 exceptions");
  console.log("✓ Authoritative input.json test passed");
}

console.log("\nAll tests passed successfully!");
