import test from "node:test";
import assert from "node:assert/strict";
import { assembleFor, fragmentsFor, MARKER, SECTIONS, RELATES_TO, SYSTEM } from "./assemble.js";

const f = (order, content, relatesTo) => ({ mapping: { recipes: order }, content, ...(relatesTo ? { relatesTo } : {}) });
const WITH_MARKERS = `{leading}\n# Instructions\ndo the thing\n{trailing}\n{conditions}\nPass: it worked\n{pass}\nFail: it did not\n{fail}`;

// A module-level /g regex advances lastIndex on .test(), so a stateful implementation returns the
// right answer on the first call and the WRONG one on the second — markers shipping to the model on
// every other request. Calling it repeatedly is the only way to see it.
test("repeated calls give the same answer — marker detection carries no state", () => {
  const marked = `{leading}\nBODY\n{trailing}\n{conditions}\n\nPass: P\n{pass}\nFail: F\n{fail}`;
  const first = assembleFor([f("a", "SYS")], "recipes", marked);
  for (let i = 0; i < 5; i++) {
    const again = assembleFor([f("a", "SYS")], "recipes", marked);
    assert.equal(again.instructions, first.instructions, `call ${i + 2} differs from call 1`);
    assert.ok(!again.instructions.includes("{"), `call ${i + 2} left a marker behind`);
  }
});

test("no markers → every fragment in the system prompt, instruction untouched (today's behaviour)", () => {
  const prompts = [f("a", "SYS ONE"), f("m", "SYS TWO", "pass")];
  const r = assembleFor(prompts, "recipes", "# Instructions\nplain old text");
  assert.equal(r.system, "SYS ONE\n\nSYS TWO");            // relatesTo ignored without markers
  assert.equal(r.instructions, "# Instructions\nplain old text");
});

test("markers → blank-relatesTo stays in system, anchored fragments land in their slot", () => {
  const prompts = [f("a", "SYSTEM TEXT"), f("m", "STATUS CONTRACT", "pass"), f("b", "LEAD IN", "leading")];
  const r = assembleFor(prompts, "recipes", WITH_MARKERS);
  assert.equal(r.system, "SYSTEM TEXT");
  assert.match(r.instructions, /^LEAD IN\n# Instructions/);
  assert.match(r.instructions, /Pass: it worked\nSTATUS CONTRACT\nFail: it did not/);
  assert.ok(!r.instructions.includes("{"), "every marker substituted");
});

test("an unclaimed section leaves no blank gap", () => {
  const r = assembleFor([f("a", "SYS")], "recipes", WITH_MARKERS);
  // Collapses to the same "\n\n" separation systemPromptFor uses — never a run of blank lines.
  assert.equal(r.instructions, "# Instructions\ndo the thing\n\nPass: it worked\n\nFail: it did not");
  assert.ok(!/\n{3}/.test(r.instructions));
});

test("two fragments in one slot keep order-key order", () => {
  const prompts = [f("z", "SECOND", "pass"), f("a", "FIRST", "pass")];
  const r = assembleFor(prompts, "recipes", WITH_MARKERS);
  assert.match(r.instructions, /FIRST\n\nSECOND/);
});

test("an unknown or unset relatesTo resolves to the system message rather than being dropped", () => {
  assert.equal(assembleFor([f("a", "MYSTERY", "somewhere-else")], "recipes", WITH_MARKERS).system, "MYSTERY");
  assert.equal(assembleFor([f("a", "UNSET")], "recipes", WITH_MARKERS).system, "UNSET");
  assert.equal(assembleFor([f("a", "EXPLICIT", "system")], "recipes", WITH_MARKERS).system, "EXPLICIT");
});

test("system and trailing are NOT the same place", () => {
  // `system` is a different MESSAGE; `trailing` trails the instruction inside the user message.
  const r = assembleFor([f("a", "IN SYSTEM", "system"), f("b", "AFTER INSTRUCTION", "trailing")], "recipes", WITH_MARKERS);
  assert.equal(r.system, "IN SYSTEM");
  assert.ok(!r.system.includes("AFTER INSTRUCTION"));
  assert.match(r.instructions, /do the thing\nAFTER INSTRUCTION/);
  assert.ok(r.instructions.indexOf("AFTER INSTRUCTION") < r.instructions.indexOf("Pass:"));
});

test("fragments for another subtype are not pulled in", () => {
  const other = { mapping: { courses: "a" }, content: "COURSES ONLY" };
  const r = assembleFor([other, f("a", "RECIPES ONLY")], "recipes", WITH_MARKERS);
  assert.equal(r.system, "RECIPES ONLY");
});

test("markdown escape stripping matches systemPromptFor", () => {
  const r = assembleFor([f("a", "a \\# heading and a \\- dash")], "recipes", "no markers");
  assert.equal(r.system, "a # heading and a - dash");
});

test("empty content is dropped, not joined as a blank section", () => {
  const r = assembleFor([f("a", "REAL"), f("b", "   ")], "recipes", "no markers");
  assert.equal(r.system, "REAL");
});

test("every SECTION has a marker and every marker maps back", () => {
  for (const s of SECTIONS) assert.ok(MARKER[s], `${s} has a marker`);
  assert.equal(Object.keys(MARKER).length, SECTIONS.length);
});

test("fragmentsFor reports the section it resolved", () => {
  const parts = fragmentsFor([f("a", "X", "pass"), f("b", "Y")], "recipes");
  assert.deepEqual(parts.map((p) => p.section), ["pass", SYSTEM]);
  assert.deepEqual(RELATES_TO, ["leading", "trailing", "conditions", "pass", "fail", "system"]);
});
