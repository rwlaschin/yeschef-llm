import { test } from "node:test";
import assert from "node:assert/strict";
import { DISH_FIXTURES } from "./dishFixtures.js";
import { validateRecipe, COURSE_KINDS } from "./recipeTemplate.js";

const DIET_KEYS = [
  "standard", "low-sodium", "gluten-free", "diabetic", "lactose-free",
  "low-fat", "vegan", "vegetarian", "renal",
];

test("there are 24 fixtures", () => {
  assert.equal(DISH_FIXTURES.length, 24);
});

test("every fixture is a valid standardized recipe", () => {
  const failures = DISH_FIXTURES.flatMap((d) => validateRecipe(d));
  assert.deepEqual(failures, []);
});

test("every course kind has at least 2 dishes", () => {
  for (const kind of COURSE_KINDS) {
    const n = DISH_FIXTURES.filter((d) => d.kind === kind).length;
    assert.ok(n >= 2, `kind "${kind}" has only ${n} dish(es)`);
  }
});

test("every diet key appears on at least one dish", () => {
  for (const diet of DIET_KEYS) {
    assert.ok(DISH_FIXTURES.some((d) => d.diets.includes(diet)), `no dish declares "${diet}"`);
  }
});

test("no two dishes share a name", () => {
  const names = DISH_FIXTURES.map((d) => d.name);
  assert.equal(new Set(names).size, names.length);
});

// A dish with nothing in seasonings[] is either an oversight or a deliberate call — it has to say
// which, or a low-sodium review cannot tell them apart.
test("every dish is seasoned or documents why it is not", () => {
  for (const d of DISH_FIXTURES) {
    const ok = (d.seasonings?.length ?? 0) > 0 || typeof d.seasoningsNote === "string";
    assert.ok(ok, `${d.name} has no seasonings and no seasoningsNote`);
  }
});
