// Unit tests for the streaming status-block parser — pure, no mocks.
// Marker: @@::PASS::@@ / @@::FAIL:<reason>::@@  (no angle brackets — see outcome.js header)
// Run: node --test worker/steps/outcome.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleResponse, splitOutcome } from "./outcome.js";

// --- splitOutcome: the final separation ---

test("splitOutcome: PASS — status only, no reason, response cleaned", () => {
  assert.deepEqual(
    splitOutcome("Here is the answer.\n\n@@::PASS::@@"),
    { status: "PASS", reason: "", clean: "Here is the answer." }
  );
});

test("splitOutcome: FAIL carries the reason (single-colon separator)", () => {
  assert.deepEqual(
    splitOutcome("Some output.\n@@::FAIL:missing sodium limits::@@"),
    { status: "FAIL", reason: "missing sodium limits", clean: "Some output." }
  );
});

test("splitOutcome: a bare FAIL (no reason) is surfaced, not stored empty", () => {
  assert.deepEqual(
    splitOutcome("Some output.\n@@::FAIL::@@"),
    { status: "FAIL", reason: "no reason given", clean: "Some output." }
  );
});

test("splitOutcome: PASS still needs no reason", () => {
  assert.deepEqual(
    splitOutcome("Answer.\n@@::PASS::@@"),
    { status: "PASS", reason: "", clean: "Answer." }
  );
});

test("splitOutcome: case-insensitive status, normalized to upper-case", () => {
  assert.equal(splitOutcome("x@@::pass::@@").status, "PASS");
  assert.equal(splitOutcome("x@@::Fail:Bad::@@").status, "FAIL");
  assert.equal(splitOutcome("x@@::Fail:Bad::@@").reason, "Bad");
});

test("splitOutcome: ordinary '@@' / '::' / '@@::' prose does NOT false-trigger", () => {
  const t = "email a@@b, key::value, and a @@::section label here";
  assert.deepEqual(splitOutcome(t), { status: null, reason: "", clean: t });
});

test("splitOutcome: no block → status null, response unchanged", () => {
  assert.deepEqual(splitOutcome("just a normal answer"), { status: null, reason: "", clean: "just a normal answer" });
});

test("splitOutcome: opening but dropped close → still pulled out (eat to end)", () => {
  assert.equal(splitOutcome("body\n@@::PASS").status, "PASS");           // no closing ::@@
  assert.deepEqual(
    { s: splitOutcome("body\n@@::FAIL:why").status, r: splitOutcome("body\n@@::FAIL:why").reason },
    { s: "FAIL", r: "why" }
  );
});

// --- visibleResponse: the streaming guarantee (no half-block ever leaks) ---

test("visibleResponse: a buffer ending on a bare '@' withholds it", () => {
  assert.equal(visibleResponse("So we got the fish.\n\n@"), "So we got the fish.");
});

test("visibleResponse: withholds each forming-opening partial", () => {
  for (const tail of ["@", "@@", "@@:", "@@::", "@@::P", "@@::PASS", "@@::FA"]) {
    assert.equal(visibleResponse(`answer\n\n${tail}`), "answer", `tail=${tail}`);
  }
});

test("visibleResponse: a real '@' / '::' / '@@' that is NOT the block is shown", () => {
  assert.equal(visibleResponse("email me @ home"), "email me @ home");
  assert.equal(visibleResponse("key::value pair"), "key::value pair");
  assert.equal(visibleResponse("a@@b is not a marker"), "a@@b is not a marker");
});

test("visibleResponse: freezes at the opening once it is committed", () => {
  assert.equal(visibleResponse("answer here\n\n@@::FAIL::because"), "answer here");
});

test("streaming sim: feeding chunk-by-chunk never reveals any part of the block", () => {
  const chunks = ["The ", "answer is 42.", "\n\n@", "@:", ":PA", "SS:", ":@@"];
  let full = "";
  for (const c of chunks) {
    full += c;
    const v = visibleResponse(full);
    assert.ok(!v.includes("@@"), `leaked '@@' in: ${JSON.stringify(v)}`);
    assert.ok(!/@$/.test(v), `leaked trailing '@' in: ${JSON.stringify(v)}`);
  }
  assert.deepEqual(splitOutcome(full), { status: "PASS", reason: "", clean: "The answer is 42." });
});
