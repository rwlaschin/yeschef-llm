// The CONTRACT for a standardized recipe, written before the generator that has to satisfy it.
// Every assertion here is a property a cook or an auditor depends on: measured ingredients, a yield
// they can scale, ordered steps, and the times and temperatures that make the dish repeatable and
// make the HACCP record real.
import test from "node:test";
import assert from "node:assert/strict";
import { validateDish, validateIsSingleDish, validateRecipe, COURSE_KINDS, RECIPE_UNWRITABLE } from "./recipeTemplate.js";

// A dish that satisfies the whole contract — the reference every fixture is measured against.
const GOOD = {
  name: "Braised beef with barley",
  kind: "entree",
  mealtime: "dinner",
  diets: ["standard", "diabetic", "low-fat"],
  yieldPortions: 50,
  portionSize: "4 oz beef + 1/2 cup barley",
  components: [
    { ingredient: "Beef chuck", category: "protein", quantity: 4, unit: "oz", prep: "trimmed, cut 1in cubes" },
    { ingredient: "Pearl barley", category: "starch", quantity: 0.5, unit: "cup", prep: "rinsed" },
  ],
  seasonings: [{ ingredient: "Kosher salt", quantity: 0.25, unit: "tsp" }],
  method: [
    { order: 0, phase: "make_ahead", text: "Sear the beef at 400F until browned.", timeMin: 8, criticalTempF: 145 },
    { order: 1, phase: "make_ahead", text: "Braise covered at 325F until fork tender.", timeMin: 150, criticalTempF: 165 },
    { order: 2, phase: "make_ahead", text: "Cool 135F to 70F within 2 hours, then to 41F.", timeMin: 360, criticalTempF: 41 },
    { order: 3, phase: "on_line", text: "Reheat to service temperature.", timeMin: 20, criticalTempF: 165 },
    { order: 4, phase: "on_line", text: "Portion with a #8 scoop.", timeMin: 1, criticalTempF: null },
  ],
};
const clone = (over = {}) => ({ ...structuredClone(GOOD), ...over });

test("the reference dish satisfies the whole contract", () => {
  assert.deepEqual(validateRecipe(GOOD), []);
});

test("a quantity of zero is a default nobody chose, not a measurement", () => {
  const d = clone();
  d.components[0].quantity = 0;
  assert.match(validateDish(d).join(" "), /no measured quantity/);
});

test("a recipe without a yield cannot be scaled to a census", () => {
  assert.match(validateDish(clone({ yieldPortions: undefined })).join(" "), /yieldPortions/);
  assert.match(validateDish(clone({ portionSize: "" })).join(" "), /portionSize/);
});

test("a step that cooks or holds must state its temperature", () => {
  const noTemp = clone();
  noTemp.method[1] = { ...noTemp.method[1], criticalTempF: null };
  assert.match(validateDish(noTemp).join(" "), /states no criticalTempF/);
});

// DEPRECATED ASSERTION, replaced deliberately: this used to demand a timeMin on method[1] (a braise
// that records criticalTempF 165) and so pinned the rule that EVERY cook owes a clock. A step with a
// verified internal temperature is controlled by the probe, and demanding minutes it does not have
// can only be satisfied by inventing them — which invites a cook to pull at the timer instead.
test("a cook with a recorded temperature is controlled by the probe, not the clock", () => {
  const noTime = clone();
  noTime.method[1] = { ...noTime.method[1], timeMin: null };
  assert.deepEqual(validateDish(noTime), []);

  const reheat = clone();
  reheat.method[3] = { order: 3, phase: "on_line", text: "Reheat to 165F for 15 seconds.", timeMin: null, criticalTempF: 165 };
  assert.deepEqual(validateDish(reheat), []);
});

test("a cook with NEITHER number has nothing controlling it and fails on both", () => {
  const neither = clone();
  neither.method[1] = { order: 1, phase: "make_ahead", text: "Braise covered until fork tender.", timeMin: null, criticalTempF: null };
  const errs = validateDish(neither);
  assert.match(errs.join(" "), /states no criticalTempF/);
  assert.match(errs.join(" "), /states no timeMin/);
});

test("cooling owes its clock whatever its temperature says — 3-501.14(A) mandates the RATE", () => {
  const noClock = clone();
  noClock.method[2] = { ...noClock.method[2], timeMin: null };
  assert.match(validateDish(noClock).join(" "), /states no timeMin/);
});

test("an inflected verb names a food, not an action", () => {
  // "Cooked rice held below 135F" describes the product; it instructs nothing and owes nothing.
  const participle = clone();
  participle.method[4] = { order: 4, phase: "on_line", text: "Portion with a #8 scoop. Cooked rice held below 135F is discarded.", timeMin: null, criticalTempF: null };
  assert.deepEqual(validateDish(participle), []);
});

test("`cook the chicken through` is not a repeatable instruction", () => {
  const vague = clone();
  vague.method[1] = { order: 1, phase: "make_ahead", text: "Cook the beef through.", timeMin: null, criticalTempF: null };
  const errs = validateDish(vague);
  assert.ok(errs.some((x) => /timeMin/.test(x)) && errs.some((x) => /criticalTempF/.test(x)));
});

test("seasonings are measured and kept out of the component list", () => {
  const inComponents = clone();
  inComponents.components.push({ ingredient: "Salt", category: "seasoning", quantity: 1, unit: "tsp", prep: "fine" });
  assert.match(validateDish(inComponents).join(" "), /belongs in seasonings/);

  const toTaste = clone({ seasonings: [{ ingredient: "Kosher salt", quantity: 0, unit: "tsp" }] });
  assert.match(validateDish(toTaste).join(" "), /not measured/);
});

test("method is ordered, make_ahead first, and ends by portioning", () => {
  // Step COUNT is not part of the contract — a short dish that says everything it needs to say is
  // valid. A method that does not exist still is not a recipe.
  const short = clone({
    method: [
      { order: 0, phase: "make_ahead", text: "Whisk the cocoa into the milk.", timeMin: null, criticalTempF: null },
      { order: 1, phase: "on_line", text: "Portion into a 12 oz mug.", timeMin: null, criticalTempF: null },
    ],
  });
  assert.deepEqual(validateDish(short), []);
  assert.match(validateDish(clone({ method: [] })).join(" "), /has no method/);
  // A method with nothing at service is still incomplete, whatever its length.
  assert.match(validateDish(clone({ method: GOOD.method.slice(0, 3) })).join(" "), /no on_line/);

  const backwards = clone();
  backwards.method = [...GOOD.method];
  backwards.method[4] = { ...backwards.method[4], phase: "make_ahead" };
  assert.match(validateDish(backwards).join(" "), /make_ahead step appears after an on_line step/);

  const noPortion = clone();
  noPortion.method[4] = { ...noPortion.method[4], text: "Wipe down the station." };
  assert.match(validateDish(noPortion).join(" "), /does not end by portioning/);
});

test("a meal is not a dish, and an ingredient is not a dish", () => {
  assert.match(validateIsSingleDish({ name: "Breakfast tray", components: [] }).join(" "), /not a single dish/);
  assert.match(
    validateIsSingleDish({ name: "Margarine", components: [{ ingredient: "Margarine" }] }).join(" "),
    /bare ingredient/,
  );
  assert.deepEqual(validateIsSingleDish(GOOD), []);
});

test("only real course kinds are accepted", () => {
  assert.match(validateDish(clone({ kind: "meal" })).join(" "), /not a course kind/);
  for (const kind of COURSE_KINDS) assert.deepEqual(validateDish(clone({ kind })), []);
});

test("fields the write path cannot store are named, so they are stripped and never 400", () => {
  // RecipeBulkInput (yeschef/lib/db/neo4jGraphql.ts) accepts no yield/allergens/nutrition; sending
  // them is a hard GraphQL error, so the contract has to say which fields stay in the kitchen.
  for (const f of ["yieldPortions", "portionSize", "nutrition"]) assert.ok(RECIPE_UNWRITABLE.includes(f));
});
