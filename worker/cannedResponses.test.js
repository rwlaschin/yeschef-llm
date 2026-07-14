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
  assert.doesNotMatch(JSON.stringify(JSON.parse(cannedResponse("recipe", { item: "vegan", query: "" }))), /Chicken|Beef|Pork|Salmon|Turkey|Cod/);
});

test("recipe with target lines returns a strict JSON array of canonical recipes", () => {
  const query = "1. Tofu — cut: firm, diet: vegan, mealtime: lunch";
  const out = cannedResponse("recipe", { item: "vegan", query });
  assert.equal(typeof out, "string");
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed) && parsed.length > 0);
  for (const r of parsed) {
    assert.equal(typeof r.name, "string");
    assert.ok(Array.isArray(r.components));
    assert.ok(Array.isArray(r.method), "canonical recipes carry their method");
    assert.equal(typeof r.nutrition, "object");
  }
});

test("recipe echoes the proteinType requested in the prompt, multi-word included", () => {
  const query = "Suggest one recipe. Respond with ONLY a JSON array.\n\n1. Greek yogurt — cut: plain, diet: regular, mealtime: breakfast";
  const parsed = JSON.parse(cannedResponse("recipe", { query }));
  for (const r of parsed) assert.equal(r.proteinType, "Greek yogurt");
});

test("recipe builds the recipe FROM the requested protein — body matches, not just the label", () => {
  const query = "1. Greek yogurt — cut: plain, diet: regular, mealtime: breakfast";
  const r = JSON.parse(cannedResponse("recipe", { query }))[0];
  const protein = r.components.find((c) => c.category === "protein");
  assert.equal(protein.ingredient, "Greek yogurt", "protein component must be the requested protein, not a foreign pool row");
  assert.match(r.name.toLowerCase(), /yogurt/);
});

test("recipe is mealtime-aware — breakfast drops the savoury veg and adds fruit", () => {
  const bfast = JSON.parse(cannedResponse("recipe", { query: "1. Greek yogurt — cut: , diet: regular, mealtime: breakfast" }))[0];
  const cats = bfast.components.map((c) => c.category);
  assert.ok(!cats.includes("vegetable"), "breakfast must NOT include a vegetable (no yogurt + spinach)");
  assert.ok(cats.includes("fruit"), "breakfast should include fruit");
  assert.doesNotMatch(bfast.summary.toLowerCase(), /spinach/, "summary must not pair yogurt with spinach");

  const lunch = JSON.parse(cannedResponse("recipe", { query: "1. Chicken — cut: diced, diet: regular, mealtime: lunch" }))[0];
  assert.ok(lunch.components.some((c) => c.category === "vegetable"), "lunch/dinner keeps the vegetable");
});

test("recipe directions-style query returns a single recipe whose method derives from its own components", () => {
  // Mirrors buildDirectionsPrompt: dish name + one "<prep> <ingredient>" line per component.
  const query = "Yogurt bowl\nportioned Greek yogurt\ncooked Granola\nfresh Mango";
  const r = JSON.parse(cannedResponse("recipe", { query }));
  assert.equal(r.name, "Yogurt bowl", "directions response is the requested dish");
  assert.ok(Array.isArray(r.method) && r.method.length > 0);
  const text = r.method.map((s) => s.text).join(" ").toLowerCase();
  assert.match(text, /greek yogurt/, "steps reference the recipe's protein");
  assert.doesNotMatch(text, /spinach|broccoli/, "steps must not mention a vegetable the breakfast recipe never had");
});

test("recipe method steps are strict {text, phase, order} covering both phases", () => {
  const r = JSON.parse(cannedResponse("recipe", { item: "vegan", query: "" }));
  assert.ok(Array.isArray(r.method) && r.method.length > 0);
  const phases = new Set(["make_ahead", "on_line"]);
  for (const s of r.method) {
    assert.equal(typeof s.text, "string");
    assert.ok(s.text.length > 0);
    assert.ok(phases.has(s.phase), `bad phase: "${s.phase}"`);
    assert.equal(typeof s.order, "number");
  }
  // must cover both phases — make-ahead prep + on-line service
  const seen = new Set(r.method.map((s) => s.phase));
  assert.ok(seen.has("make_ahead") && seen.has("on_line"), "both phases present");
});

// ── recipes step is SEEDED from the proteins grid (Bug fix: recipes ignored the grid) ──────────
// payload.ctx.proteins carries the grid's per-slot proteins (normDiet → day → mealtime → {type,cut}).
// cannedRecipes must emit each slot's recipe FROM that protein so recipes MIRROR the proteins grid.
const recipeRows = (out) => out.split("\n").slice(1).map((l) => l.split("|").map((c) => c.trim()));
const proteinAt = (out, day, meal) => {
  const row = recipeRows(out).find((c) => c[0] === `Day ${day}` && c[1] === meal);
  return row ? row[3] : null;   // column order: Day | Mealtime | Dish | Protein | Starch | Veg | Fruit
};
const dishAt = (out, day, meal) => {
  const row = recipeRows(out).find((c) => c[0] === `Day ${day}` && c[1] === meal);
  return row ? row[2] : null;
};

test("recipes seeded from the grid emit each slot's assigned protein (mirrors the grid)", () => {
  const proteins = { "diet1": {
    1: { breakfast: { type: "Greek yogurt" }, lunch: { type: "Turkey", cut: "breast" }, dinner: { type: "Cod", cut: "fillet" } },
    2: { breakfast: { type: "Pork Loin", cut: "smoked" } },
  } };
  const out = cannedResponse("recipes", { item: "diet 1", ctx: { meals: ["breakfast", "lunch", "dinner"], days: 2, proteins } });
  assert.equal(proteinAt(out, 1, "breakfast"), "Greek yogurt");   // the reported bug: was "Baked cod"
  assert.equal(proteinAt(out, 1, "lunch"), "Turkey");
  assert.equal(proteinAt(out, 1, "dinner"), "Cod");
  assert.equal(proteinAt(out, 2, "breakfast"), "Pork Loin");
  // dish reflects the grid protein (Greek yogurt → the yogurt-bowl pool row)
  assert.match(dishAt(out, 1, "breakfast"), /yogurt/i);
});

test("recipes seed matches the unit's diet even when item is null (single-diet grid)", () => {
  const proteins = { "diet1": { 1: { breakfast: { type: "Greek yogurt" } } } };
  const out = cannedResponse("recipes", { item: null, ctx: { meals: ["breakfast"], days: 1, proteins } });
  assert.equal(proteinAt(out, 1, "breakfast"), "Greek yogurt");
});

test("recipes fall back to the diet pool when no grid proteins are provided", () => {
  const out = cannedResponse("recipes", { item: "vegan", ctx: { meals: ["breakfast"], days: 1 } });
  const p = proteinAt(out, 1, "breakfast");
  assert.ok(["Tofu", "Lentil", "Chickpea", "Black bean", "Tempeh", "Quinoa", "Edamame", "Seitan"].includes(p), `vegan pool protein, got "${p}"`);
});
