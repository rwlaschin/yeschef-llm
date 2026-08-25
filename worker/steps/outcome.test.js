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
    { status: "PASS", reason: "", thinking: "", clean: "Here is the answer." }
  );
});

test("splitOutcome: FAIL carries the reason (single-colon separator)", () => {
  assert.deepEqual(
    splitOutcome("Some output.\n@@::FAIL:missing sodium limits::@@"),
    { status: "FAIL", reason: "missing sodium limits", thinking: "", clean: "Some output." }
  );
});

test("splitOutcome: a bare FAIL (no reason) is surfaced, not stored empty", () => {
  assert.deepEqual(
    splitOutcome("Some output.\n@@::FAIL::@@"),
    { status: "FAIL", reason: "no reason given", thinking: "", clean: "Some output." }
  );
});

test("splitOutcome: PASS still needs no reason", () => {
  assert.deepEqual(
    splitOutcome("Answer.\n@@::PASS::@@"),
    { status: "PASS", reason: "", thinking: "", clean: "Answer." }
  );
});

test("splitOutcome: case-insensitive status, normalized to upper-case", () => {
  assert.equal(splitOutcome("x@@::pass::@@").status, "PASS");
  assert.equal(splitOutcome("x@@::Fail:Bad::@@").status, "FAIL");
  assert.equal(splitOutcome("x@@::Fail:Bad::@@").reason, "Bad");
});

test("splitOutcome: ordinary '@@' / '::' / '@@::' prose does NOT false-trigger", () => {
  const t = "email a@@b, key::value, and a @@::section label here";
  assert.deepEqual(splitOutcome(t), { status: null, reason: "", thinking: "", clean: t });
});

test("splitOutcome: no block → status null, response unchanged", () => {
  assert.deepEqual(splitOutcome("just a normal answer"), { status: null, reason: "", thinking: "", clean: "just a normal answer" });
});

test("splitOutcome: opening but dropped close → still pulled out (eat to end)", () => {
  assert.equal(splitOutcome("body\n@@::PASS").status, "PASS");           // no closing ::@@
  assert.deepEqual(
    { s: splitOutcome("body\n@@::FAIL:why").status, r: splitOutcome("body\n@@::FAIL:why").reason },
    { s: "FAIL", r: "why" }
  );
});

// --- splitOutcome: dual status-token contract ---

test("splitOutcome: new PASS token returns the legacy result shape", () => {
  assert.deepEqual(
    splitOutcome("Here is the answer.\n\n@@::PASS;:&@"),
    { status: "PASS", reason: "", thinking: "", clean: "Here is the answer." }
  );
});

test("splitOutcome: new FAIL token returns its generated reason", () => {
  assert.deepEqual(
    splitOutcome("Some output.\n@@::FAIL:components column is empty;:&@"),
    { status: "FAIL", reason: "components column is empty", thinking: "", clean: "Some output." }
  );
});

test("splitOutcome: new status tokens are case-insensitive", () => {
  assert.deepEqual(
    splitOutcome("Answer.\n@@::fAiL:Wrong Diet;:&@"),
    { status: "FAIL", reason: "Wrong Diet", thinking: "", clean: "Answer." }
  );
});

test("splitOutcome: a bare new FAIL reports that no reason was given", () => {
  assert.deepEqual(
    splitOutcome("Some output.\n@@::FAIL;:&@"),
    { status: "FAIL", reason: "no reason given", thinking: "", clean: "Some output." }
  );
});

test("splitOutcome: new PASS with a dropped closing at-sign still uses fallback without inventing a reason", () => {
  assert.deepEqual(
    splitOutcome("Answer.\n@@::PASS;:&"),
    { status: "PASS", reason: "", thinking: "", clean: "Answer." }
  );
});

test("splitOutcome: new FAIL with its close dropped still uses fallback and keeps the reason", () => {
  assert.deepEqual(
    splitOutcome("Some output.\n@@::FAIL:wrong number of rows"),
    { status: "FAIL", reason: "wrong number of rows", thinking: "", clean: "Some output." }
  );
});

test("splitOutcome: ordinary new closing characters without a status are not a marker", () => {
  const raw = "Use ;:&@ as an example delimiter, but do not report a status.";
  assert.deepEqual(
    splitOutcome(raw),
    { status: null, reason: "", thinking: "", clean: raw }
  );
});

test("splitOutcome: the first complete marker wins when new PASS precedes legacy FAIL", () => {
  assert.deepEqual(
    splitOutcome("Answer.\n@@::PASS;:&@\n@@::FAIL:later legacy marker::@@"),
    { status: "PASS", reason: "", thinking: "", clean: "Answer." }
  );
});

test("splitOutcome: the first complete marker wins when legacy FAIL precedes new PASS", () => {
  assert.deepEqual(
    splitOutcome("Answer.\n@@::FAIL:first legacy marker::@@\n@@::PASS;:&@"),
    { status: "FAIL", reason: "first legacy marker", thinking: "", clean: "Answer." }
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
  assert.deepEqual(splitOutcome(full), { status: "PASS", reason: "", thinking: "", clean: "The answer is 42." });
});

test("streaming sim: chunked new PASS never reveals marker bytes", () => {
  const chunks = ["The ", "answer is 42.", "\n\n@", "@:", ":PA", "SS;", ":&", "@"];
  let full = "";
  for (const chunk of chunks) {
    full += chunk;
    const visible = visibleResponse(full);
    assert.ok(!visible.includes("@@"), `leaked '@@' in: ${JSON.stringify(visible)}`);
    assert.ok(!visible.includes(";:&@"), `leaked new close in: ${JSON.stringify(visible)}`);
    assert.ok(!/@$/.test(visible), `leaked trailing '@' in: ${JSON.stringify(visible)}`);
  }
  assert.deepEqual(
    splitOutcome(full),
    { status: "PASS", reason: "", thinking: "", clean: "The answer is 42." }
  );
});

test("streaming sim: chunked new FAIL never reveals marker bytes", () => {
  const chunks = ["Invalid table.", "\n@", "@::F", "AIL:", "empty components", ";:", "&@"];
  let full = "";
  for (const chunk of chunks) {
    full += chunk;
    const visible = visibleResponse(full);
    assert.ok(!visible.includes("@@"), `leaked '@@' in: ${JSON.stringify(visible)}`);
    assert.ok(!visible.includes(";:&@"), `leaked new close in: ${JSON.stringify(visible)}`);
    assert.ok(!/@$/.test(visible), `leaked trailing '@' in: ${JSON.stringify(visible)}`);
  }
  assert.deepEqual(
    splitOutcome(full),
    { status: "FAIL", reason: "empty components", thinking: "", clean: "Invalid table." }
  );
});

// --- the THINKING block: working, not deliverable ---
// A step may be told to show its counting between markers before the deliverable. That region is
// working — it must never reach the stored response, the next step's context, or the live stream.

test("splitOutcome: a complete thinking block is removed from clean", () => {
  const r = splitOutcome(
    "--- THINKING START ---\nAlpha 1 of 2: x\n--- THINKING END ---\nDay | Dish\n1 | Soup\n@@::PASS::@@"
  );
  assert.equal(r.status, "PASS");
  assert.equal(r.clean, "Day | Dish\n1 | Soup");
});

test("splitOutcome: response with no thinking block is unchanged", () => {
  assert.equal(splitOutcome("Day | Dish\n@@::PASS::@@").clean, "Day | Dish");
});

// The dangerous case. If the model opens the block and never closes it, removing "to end of string"
// would delete the deliverable — and because the status block is parsed first, a PASS would already
// have been extracted, so the run would be stored empty AND marked success.
test("splitOutcome: an UNTERMINATED block is left intact, never eaten to end", () => {
  const raw = "--- THINKING START ---\nAlpha 1 of 2: x\nDay | Dish\n1 | Soup\n@@::PASS::@@";
  const r = splitOutcome(raw);
  assert.equal(r.status, "PASS");
  assert.ok(r.clean.includes("Day | Dish"), "deliverable must survive an unterminated block");
  assert.ok(r.clean.includes("THINKING START"), "the unclosed marker stays so the defect is visible");
});

test("splitOutcome: several blocks are all removed", () => {
  const r = splitOutcome(
    "--- THINKING START ---\na\n--- THINKING END ---\nrow1\n--- THINKING START ---\nb\n--- THINKING END ---\nrow2\n@@::PASS::@@"
  );
  assert.equal(r.clean, "row1\nrow2");
});

test("visibleResponse: withholds the block while it streams", () => {
  assert.equal(visibleResponse("Day | Dish\n--- THINKING START ---\nAlpha 1 of"), "Day | Dish");
});

test("visibleResponse: keeps showing the deliverable after a block closes", () => {
  assert.equal(
    visibleResponse("--- THINKING START ---\na\n--- THINKING END ---\nDay | Dish"),
    "Day | Dish"
  );
});

test("visibleResponse: a partial opening marker is withheld, not flashed", () => {
  assert.equal(visibleResponse("Day | Dish\n--- THINKING ST"), "Day | Dish");
});

test("visibleResponse: text with no block is untouched", () => {
  assert.equal(visibleResponse("Day | Dish\n1 | Soup"), "Day | Dish\n1 | Soup");
});

// The working is kept, not discarded: separated from the deliverable, still on the record.

test("splitOutcome: the thinking block is RETURNED, not thrown away", () => {
  const r = splitOutcome(
    "--- THINKING START ---\nAlpha 1 of 2: x\n--- THINKING END ---\nDay | Dish\n@@::PASS::@@"
  );
  assert.equal(r.clean, "Day | Dish");
  assert.equal(r.thinking, "Alpha 1 of 2: x");
});

test("splitOutcome: several blocks are all kept, in order", () => {
  const r = splitOutcome(
    "--- THINKING START ---\na\n--- THINKING END ---\nrow1\n--- THINKING START ---\nb\n--- THINKING END ---\nrow2\n@@::PASS::@@"
  );
  assert.equal(r.clean, "row1\nrow2");
  assert.equal(r.thinking, "a\n\nb");
});

test("splitOutcome: no block → thinking is empty, never undefined", () => {
  assert.equal(splitOutcome("Day | Dish\n@@::PASS::@@").thinking, "");
});

test("splitOutcome: an unterminated block captures nothing — it was never well-formed", () => {
  const r = splitOutcome("--- THINKING START ---\nAlpha\nDay | Dish\n@@::PASS::@@");
  assert.equal(r.thinking, "");
  assert.ok(r.clean.includes("Day | Dish"));
});
