// Tests for the normalize_ingredients tool math. Run: node --test "worker/**/*.test.js"
// Built around the real shape: step prompt gives residents + diet distribution; context gives the
// day's menu; the model copies them into the tool args; the TOOL does the math.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, servingCount, processDay, parseAmount } from "./inventory.js";

test("parseAmount: decimals, fractions, mixed, unicode, jammed units", () => {
  assert.equal(parseAmount(0.5), 0.5);
  assert.equal(parseAmount(".25"), 0.25);
  assert.equal(parseAmount("1/4"), 0.25);     // ← the case that used to → 0
  assert.equal(parseAmount("3/2"), 1.5);
  assert.equal(parseAmount("1 1/2"), 1.5);    // mixed number
  assert.equal(parseAmount("½"), 0.5);
  assert.equal(parseAmount("1½"), 1.5);
  assert.equal(parseAmount("2 cups"), 2);     // takes the number, ignores the unit text
  assert.equal(parseAmount("1-2 cups"), 2);   // range → BIGGER number
  assert.equal(parseAmount("1 to 2"), 2);
  assert.equal(parseAmount("10–12 oz"), 12);  // en-dash range
  assert.equal(parseAmount(""), 0);
  assert.equal(parseAmount("a bunch"), 0);    // unparseable → 0
});

test("diet matches on the passed-in keyword; residents + fraction amount tolerant", () => {
  // recipe and distribution both use the keyword "no-sodium" (passed through the pipeline) → 120 servings
  const rows = processDay({ residents: "300 residents", diets: [{ diet: "no-sodium", pct: 40 }], recipes: [{ diet: "no-sodium", items: [{ name: "banana", amount: "1/2", unit: "each" }] }] });
  assert.equal(rows[0].servings, 120);
  assert.equal(rows[0].servingQuantity, 60); // 0.5 × 120
});

test("normalize: merges case/whitespace/plural but NEVER strips modifiers", () => {
  assert.equal(normalize("Blueberries"), "blueberry");
  assert.notEqual(normalize("white toast"), normalize("toast"));
  assert.notEqual(normalize("whole-wheat toast"), normalize("toast"));
  assert.equal(normalize("molasses"), "molasses");
});

test("servingCount = ceil(residents × diet%), robust to number/string/%-sign", () => {
  assert.equal(servingCount(300, 2), 6);        // renal 2%  → 6
  assert.equal(servingCount(300, 40), 120);     // no-sodium 40% → 120
  assert.equal(servingCount(300, 58), 174);     // regular 58% → 174
  assert.equal(servingCount(300, "58"), 174);   // numeric string
  assert.equal(servingCount(300, "58%"), 174);  // string WITH the % sign (used to → 0)
  assert.equal(servingCount(300, "2 %"), 6);    // stray space
  assert.equal(servingCount(300, 1), 3);        // literal 1% → 3 (old heuristic wrongly gave 300)
  assert.equal(servingCount(300, "garbage"), 0);// unparseable → 0
});

test("processDay: day 1, 300 residents, renal 2% / no-sodium 40% / regular 58% — TOOL does the math", () => {
  // The model copies residents + the distribution from the step prompt, and the recipes (by diet)
  // from the menu context, into these args. It computes nothing.
  const args = {
    residents: 300,
    diets: [{ diet: "renal", pct: 2 }, { diet: "no-sodium", pct: "40%" }, { diet: "regular", pct: "58" }], // mixed: number, "40%", "58"
    recipes: [
      { diet: "renal", items: [
        { name: "blueberries", amount: 0.5, unit: "cup" },     // 0.5 × 6  = 3
        { name: "white toast", amount: 1, unit: "slice" },     // 1   × 6  = 6
      ] },
      { diet: "no-sodium", items: [
        { name: "banana", amount: 1, unit: "each" },           // 1   × 120 = 120
      ] },
      { diet: "regular", items: [
        { name: "eggs", amount: 2, unit: "each" },             // 2   × 174 = 348
        { name: "whole-wheat toast", amount: 1, unit: "slice" }, // 1 × 174 = 174
      ] },
    ],
  };
  const rows = processDay(args);

  assert.equal(rows.length, 5);
  const q = (ing, diet) => rows.find((r) => r.ingredient === ing && r.diet === diet)?.servingQuantity;
  assert.equal(q("blueberry", "renal"), 3);
  assert.equal(q("white-toast", "renal"), 6);
  assert.equal(q("banana", "no-sodium"), 120);
  assert.equal(q("egg", "regular"), 348);
  assert.equal(q("whole-wheat-toast", "regular"), 174);
  // toast variants stay distinct (no over-merge); id is locally unique (recipe:line)
  assert.equal(rows[0].id, "0:0");
});

test("processDay: a diet with no pct → 0 servings (surfaced, never guessed)", () => {
  const rows = processDay({ residents: 300, diets: [{ diet: "regular", pct: 58 }], recipes: [{ diet: "vegan", items: [{ name: "tofu", amount: 1, unit: "block" }] }] });
  assert.equal(rows[0].servingQuantity, 0);
});
