import { test } from "node:test";
import assert from "node:assert/strict";
import { cannedResponse } from "./cannedResponses.js";

const CTX = { meals: ["breakfast", "lunch", "dinner"], days: 3 };
// The exact nutrients contract — plan_library instruction + seed-recipes-nutrients.mjs.
const NUTRIENTS_HEADER = "Day | Mealtime | Calories | Protein g | Sodium mg | Carbs g";
const nut = (diet) => cannedResponse("nutrients", { item: diet, ctx: CTX });

test("nutrients emits the exact 4-column contract header", () => {
  assert.equal(nut("standard").split("\n")[0], NUTRIENTS_HEADER);
});

test("nutrients rows are all numeric in every column", () => {
  const rows = nut("standard").split("\n").slice(1);
  assert.equal(rows.length, CTX.days * CTX.meals.length);
  for (const r of rows) {
    const cols = r.split("|").map((c) => c.trim());
    assert.equal(cols.length, 6); // Day, Mealtime, + 4 numeric
    for (const n of cols.slice(2)) assert.ok(/^\d+$/.test(n), `non-numeric: "${n}" in "${r}"`);
  }
});

test("nutrients returns a DISTINCT table per diet — no two collapse", () => {
  // The regression: diets sharing coefficients used to emit byte-identical tables.
  const diets = ["standard", "gluten-free", "vegetarian", "lactose-free", "renal", "low-sodium", "diabetic"];
  const tables = diets.map(nut);
  assert.equal(new Set(tables).size, diets.length, "some diets returned identical tables");
});

test("nutrients honors diet shaping (renal ↓ sodium & protein vs standard)", () => {
  const cell = (diet, i) => Number(nut(diet).split("\n")[2].split("|")[i].trim()); // day1 lunch row
  assert.ok(cell("renal", 4) < cell("standard", 4), "renal sodium not reduced");
  assert.ok(cell("renal", 3) < cell("standard", 3), "renal protein not reduced");
  assert.ok(cell("diabetic", 5) < cell("standard", 5), "diabetic carbs not reduced");
});

test("nutrients is deterministic — same input, same output", () => {
  assert.equal(nut("renal"), nut("renal"));
});

test("unknown subtype falls back to a generic stub", () => {
  assert.match(cannedResponse("wat", {}), /Canned wat response/);
});

test("planner returns a parseable YAML step routed back to the fake topic", () => {
  const out = cannedResponse("planner", {});
  assert.match(out, /```yaml/);
  assert.match(out, /subtype: task/);
});

test("compliance emits the terminal PASS block", () => {
  assert.match(cannedResponse("compliance", {}), /@@::PASS::@@/);
});

test("menu_plan echoes the unit context and yields a week of days", () => {
  const out = cannedResponse("menu_plan", { query: "regular / breakfast" });
  assert.match(out, /```yaml/);
  assert.match(out, /# unit: regular \/ breakfast/);
});

test("recipe/recipes/protein_grid honor the diet pool (vegan gets no meat)", () => {
  const veganCtx = { item: "vegan", ctx: CTX };
  const grid = cannedResponse("protein_grid", veganCtx);
  const recipes = cannedResponse("recipes", veganCtx);
  assert.equal(grid.split("\n")[0], "Day | Mealtime | Type | Cut");
  assert.equal(recipes.split("\n")[0], "Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit");
  assert.doesNotMatch(grid + recipes, /Chicken|Beef|Pork|Salmon|Turkey|Cod/);
  assert.match(cannedResponse("recipe", { item: "vegan" }), /recipe:/);
});

test("recipe_suggestion returns a strict JSON array of {name, components} recipes", () => {
  const out = cannedResponse("recipe_suggestion", { item: "vegan" });
  assert.equal(typeof out, "string");
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed) && parsed.length > 0);
  for (const r of parsed) {
    assert.equal(typeof r.name, "string");
    assert.ok(Array.isArray(r.components));
  }
});

test("recipe_suggestion echoes the proteinType requested in the prompt, multi-word included", () => {
  const query = "Suggest one recipe. Respond with ONLY a JSON array.\n\n1. Greek yogurt — cut: plain, diet: regular, mealtime: breakfast";
  const parsed = JSON.parse(cannedResponse("recipe_suggestion", { query }));
  for (const r of parsed) assert.equal(r.proteinType, "Greek yogurt");
});
