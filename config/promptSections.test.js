// The vocabulary is a CONTRACT, not an implementation detail: `relatesTo` values are stored in
// Mongo, so renaming a section silently orphans every fragment already carrying the old name, and
// changing the layout changes what the model receives.
//
// Every other test on this feature is self-referential — it imports SECTIONS and checks the code
// agrees with itself, which passes happily against a wrong value. (Proven: a planted "MUTANT" in
// place of "conditions" left the mirror test and the seam test green.) These assertions are written
// out LONGHAND on purpose. If one fails, that is the point: a stored value is about to change and it
// needs a migration, not a greener test.
import test from "node:test";
import assert from "node:assert/strict";
import { SYSTEM, SECTIONS, RELATES_TO, MARKER, MARKER_PATTERN, withMarkers, normalizeRelatesTo, assembleFor } from "./promptSections.js";

test("the section names are exactly these, in this order", () => {
  assert.deepEqual(SECTIONS, ["leading", "trailing", "conditions", "pass", "fail"]);
  assert.equal(SYSTEM, "system");
  assert.deepEqual(RELATES_TO, ["leading", "trailing", "conditions", "pass", "fail", "system"]);
});

test("each marker is its section name in single braces", () => {
  assert.deepEqual(MARKER, {
    leading: "{leading}", trailing: "{trailing}", conditions: "{conditions}",
    pass: "{pass}", fail: "{fail}",
  });
  assert.equal(MARKER_PATTERN, "\\{(leading|trailing|conditions|pass|fail)\\}");
});

test("the layout is exactly this, byte for byte", () => {
  assert.equal(
    withMarkers("I", "P", "F"),
    "{leading}\nI\n{trailing}\n{conditions}\n\nPass: P\n{pass}\nFail: F\n{fail}",
  );
});

test("the `\\n\\nPass:` seam survives — callers split on it to isolate the instruction half", () => {
  assert.equal(withMarkers("BODY", "P", "F").split("\n\nPass:")[0], "{leading}\nBODY\n{trailing}\n{conditions}");
});

// SECTIONS and withMarkers are independent in this file: SECTIONS drives SUBSTITUTION (via
// MARKER_PATTERN) while withMarkers hardcodes what is EMITTED. Rename a section in one and not the
// other and the marker is emitted but never substituted — it reaches the model verbatim. Found by
// mutating "conditions" and watching the seam test fail while this file's layout assertion passed.
test("every section in SECTIONS is actually emitted by withMarkers, and nothing else is", () => {
  const emitted = withMarkers("I", "P", "F").match(/\{[a-z]+\}/g) || [];
  assert.deepEqual([...emitted].sort(), [...SECTIONS].map((s) => `{${s}}`).sort(),
    "SECTIONS and the withMarkers layout disagree — a marker would be emitted but never substituted");
});

// normalizeRelatesTo is what the two API handlers call, and they are the ONLY writers of the field.
// `dashboard/**` is not in the npm test glob, so before this the decision about what reaches Mongo
// was executed by no test at all.
test("normalizeRelatesTo accepts every real section and nothing else", () => {
  for (const s of ["leading", "trailing", "conditions", "pass", "fail", "system"]) {
    assert.equal(normalizeRelatesTo(s), s);
  }
  for (const junk of ["Pass", "SYSTEM", " pass", "conditionals", "", null, undefined, 0, 42, {}, ["pass"]]) {
    assert.equal(normalizeRelatesTo(junk), "system", `${JSON.stringify(junk)} should coerce to system`);
  }
});

// The writer and the reader must agree. If the handler stored a value assembly did not recognise,
// the fragment would sit in the database claiming a placement it never actually gets.
test("whatever the writer stores, assembly honours — writer and reader agree", () => {
  const marked = withMarkers("BODY", "P", "F");
  for (const input of ["pass", "PASS", "nonsense", undefined]) {
    const stored = normalizeRelatesTo(input);
    const frag = { mapping: { t: "a" }, content: "FRAGMENT", relatesTo: stored, active: true };
    const out = assembleFor([frag], "t", marked);
    const placedInSystem = out.system.includes("FRAGMENT");
    assert.equal(placedInSystem, stored === "system",
      `stored ${JSON.stringify(stored)}: system=${placedInSystem} disagrees with the stored placement`);
    assert.ok(placedInSystem || out.instructions.includes("FRAGMENT"), "the fragment went nowhere at all");
  }
});

test("empty parts render as empty, never as the string 'undefined'", () => {
  const out = withMarkers(undefined, null, "");
  assert.ok(!out.includes("undefined"));
  assert.ok(!out.includes("null"));
});
