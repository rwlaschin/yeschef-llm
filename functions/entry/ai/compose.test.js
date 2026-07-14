// Tests for the PURE composer — especially `chain`, which inherits its source step's fan-out.
// Run: node --test functions/entry/ai/compose.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeFromDefs, renderUnit } from "./compose.js";

const form = (extra = {}) => ({ model: "m", values: {}, duration: {}, residents: 1, flags: {}, costTier: "", ...extra });

test("chain inherits the source step's fan-out 1:1 and renders per unit", () => {
  const source = { name: "menu",    subtype: "menu_plan", kind: "fanout", mapOf: "days", instruction: "menu {{itemIndex}}", pass: "", fail: "", context: [] };
  const chain  = { name: "recipes", subtype: "recipe",    kind: "chain",  mapOf: "",     instruction: "recipes day {{itemIndex}} {{date itemIndex}}", pass: "", fail: "", context: ["menu"] };
  const plan = composeFromDefs([source, chain], form({ duration: { days: 5, startDate: "2026-06-01" } }));

  assert.equal(plan[0].items.length, 5);                 // source fans 5 days
  assert.equal(plan[1].kind, "chain");
  assert.equal(plan[1].items.length, 5);                 // chain INHERITS the 5
  assert.deepEqual(plan[1].contexts, [0]);               // chains off the source
  assert.match(renderUnit(plan[1], 2), /recipes day 3 2026-06-03/); // per-unit: inherited day + date
});

test("chain off a single (1-unit) source is itself a single unit", () => {
  const source = { name: "intro", subtype: "task", kind: "fanout", mapOf: "", instruction: "intro", pass: "", fail: "", context: [] };
  const chain  = { name: "after", subtype: "task", kind: "chain",  mapOf: "", instruction: "after", pass: "", fail: "", context: ["intro"] };
  const plan = composeFromDefs([source, chain], form());
  assert.ok(!Array.isArray(plan[1].items));              // not fanned → single unit (1 → 1)
});

test("recipe chain: rides the menu's per-day fan-out and renders each day's instruction", () => {
  const menu = {
    name: "menu", subtype: "menu_plan", kind: "fanout", mapOf: "days",
    instruction: "menu day {{itemIndex}}", pass: "", fail: "", context: [],
  };
  const recipes = {
    name: "recipes", subtype: "recipe", kind: "chain", mapOf: "",
    // Recipe step TRUSTS the menu (diet/season/texture already settled upstream); it just realizes
    // each dish. Headcount is a TOTAL split across diet variants (not ×diets), and only batch
    // ingredient totals scale — never the serving size. Here we just exercise the per-unit helpers.
    instruction: 'Recipes for day {{itemIndex}} ({{weekday (date itemIndex)}}, {{date itemIndex}}), ~{{residents}} residents split across diets.',
    pass: "", fail: "", context: ["menu"], includeInOutput: true,
  };
  const plan = composeFromDefs([menu, recipes], form({
    duration: { days: 3, startDate: "2026-06-01" }, residents: 200,
  }));
  assert.equal(plan[1].kind, "chain");
  assert.equal(plan[1].items.length, 3);                 // inherits the menu's 3 days
  assert.deepEqual(plan[1].contexts, [0]);
  assert.ok(!plan[1].error, `template error: ${plan[1].error}`);
  const day2 = renderUnit(plan[1], 1);                   // day 2 = 2026-06-02
  assert.match(day2, /day 2 \(.+, 2026-06-02\)/);
  assert.match(day2, /~200 residents/);
});

test("allocate splits residents by weight, sums to the total, and buffers the batch", () => {
  const step = {
    name: "rec", subtype: "recipe", kind: "fanout", mapOf: "",
    instruction: '{{#each (allocate diets residents) as |d|}}{{d.diet}}={{d.count}}({{d.pct}}%) {{/each}}',
    pass: "", fail: "", context: [],
  };
  const plan = composeFromDefs([step], form({
    values: { diets: "regular, renal, vegan" }, residents: 300,
    dietWeights: { regular: 70, renal: 20, vegan: 10 },
  }));
  assert.ok(!plan[0].error, `template error: ${plan[0].error}`);
  // 70/20/10 of 300 = 210/60/30 demand; +5% buffer rounded up = 221/63/32.
  assert.match(plan[0].instructions, /regular=221\(70%\)/);
  assert.match(plan[0].instructions, /renal=63\(20%\)/);
  assert.match(plan[0].instructions, /vegan=32\(10%\)/);
});

test("allocate ceils each share — never shorts a diet; equal-shares missing weights", () => {
  // 3 diets, NO weights → equal 1/3 of 301 = 100.33 each; ceil → 101 each (303 total, never short).
  const step = {
    name: "rec", subtype: "recipe", kind: "fanout", mapOf: "",
    instruction: '{{#each (allocate diets residents) as |d|}}{{d.demand}} {{/each}}',
    pass: "", fail: "", context: [],
  };
  const plan = composeFromDefs([step], form({ values: { diets: "a, b, c" }, residents: 301 }));
  assert.ok(!plan[0].error, `template error: ${plan[0].error}`);
  const demands = (plan[0].instructions.match(/\d+/g) || []).map(Number); // pass/fail empty → only the 3 demands
  assert.deepEqual(demands, [101, 101, 101]);             // each ceil'd — nobody rounded down
  assert.ok(demands.reduce((s, n) => s + n, 0) >= 301);   // sums to >= residents (over is the safe side)
});

test("each step's model comes from the step def (no run-level model)", () => {
  const a = { name: "a", subtype: "task", kind: "fanout", mapOf: "", instruction: "a", pass: "", fail: "", context: [], model: "llama_70b" };
  const b = { name: "b", subtype: "task", kind: "fanout", mapOf: "", instruction: "b", pass: "", fail: "", context: [] };
  const plan = composeFromDefs([a, b], { values: {}, duration: {}, residents: 1, flags: {}, costTier: "" });
  assert.equal(plan[0].model, "llama_70b"); // taken from the step
  assert.equal(plan[1].model, "");          // unset on the step → empty (no plan-level fallback)
});

test("modelProd overrides the step model in production only", () => {
  const a = { name: "a", subtype: "task", kind: "fanout", mapOf: "", instruction: "a", pass: "", fail: "", context: [], model: "llama_8b", modelProd: "llama_70b" };
  const b = { name: "b", subtype: "task", kind: "fanout", mapOf: "", instruction: "b", pass: "", fail: "", context: [], model: "llama_8b" }; // no override
  const dev  = composeFromDefs([a, b], form());                  // isProd defaults false
  const prod = composeFromDefs([a, b], form(), { isProd: true });
  assert.equal(dev[0].model, "llama_8b");   // dev/dry-run ignores modelProd
  assert.equal(prod[0].model, "llama_70b"); // prod swaps to the override
  assert.equal(prod[1].model, "llama_8b");  // no modelProd → base model even in prod
});

test("an authored failStep (by name) resolves to that step's index", () => {
  const a = { name: "menu",   subtype: "menu_plan", kind: "fanout", mapOf: "", instruction: "m", pass: "", fail: "", context: [] };
  const b = { name: "recipe", subtype: "recipe",    kind: "fanout", mapOf: "", instruction: "r", pass: "", fail: "", context: ["menu"] };
  const c = { name: "review", subtype: "compliance",kind: "fanout", mapOf: "", instruction: "v", pass: "", fail: "", context: ["recipe"], failStep: "menu" };
  const plan = composeFromDefs([a, b, c], form());
  assert.equal(plan[2].failStep, 0);                     // explicit "menu" wins over the compliance default (which would be 1)
});

test("compliance with no authored failStep defaults to the step it validates", () => {
  const a = { name: "menu",   subtype: "menu_plan", kind: "fanout", mapOf: "", instruction: "m", pass: "", fail: "", context: [] };
  const c = { name: "review", subtype: "compliance",kind: "fanout", mapOf: "", instruction: "v", pass: "", fail: "", context: ["menu"] };
  const plan = composeFromDefs([a, c], form());
  assert.equal(plan[1].failStep, 0);                     // falls back to its single context
});

test("a non-compliance step with no failStep leaves it null", () => {
  const a = { name: "menu", subtype: "menu_plan", kind: "fanout", mapOf: "", instruction: "m", pass: "", fail: "", context: [] };
  const b = { name: "recipe", subtype: "recipe",  kind: "fanout", mapOf: "", instruction: "r", pass: "", fail: "", context: ["menu"] };
  const plan = composeFromDefs([a, b], form());
  assert.equal(plan[1].failStep, null);
});

test("renderCtx.proteins threads through to a NON-fanned step (single-diet recipes build)", () => {
  const proteins = { diet1: { 1: { breakfast: { type: "Greek yogurt" } } } };
  // Empty diets → the recipes fanout resolves to one unit (not fanned).
  const recipes = { name: "recipes", subtype: "recipes", kind: "fanout", mapOf: "diets", instruction: "r", pass: "", fail: "", context: [] };
  const plan = composeFromDefs([recipes], form({ values: { diets: "" }, proteins, duration: { days: 2 } }));
  assert.equal(plan[0].items, undefined);                 // not fanned (one unit)
  assert.deepEqual(plan[0].renderCtx.proteins, proteins); // ...but proteins still ride renderCtx → fake dispatch
  assert.equal(plan[0].renderCtx.days, 2);
});

test("renderCtx.proteins threads through to a FANNED step (multi-diet)", () => {
  const proteins = { renal: { 1: { breakfast: { type: "Cod" } } }, standard: {} };
  const recipes = { name: "recipes", subtype: "recipes", kind: "fanout", mapOf: "diets", instruction: "r {{diet}}", pass: "", fail: "", context: [] };
  const plan = composeFromDefs([recipes], form({ values: { diets: "renal, standard" }, proteins }));
  assert.equal(plan[0].items.length, 2);                  // fanned per diet
  assert.deepEqual(plan[0].renderCtx.proteins, proteins);
});

test("proteinBackbone keeps the cut in the name WITHOUT parentheses", () => {
  const proteins = { renal: { 1: { breakfast: { type: "Chicken", cut: "thigh" } } } };
  const recipes = { name: "recipes", subtype: "recipes", kind: "fanout", mapOf: "diets", instruction: "{{proteinBackbone proteins diet}}", pass: "", fail: "", context: [] };
  const plan = composeFromDefs([recipes], form({ values: { diets: "renal" }, proteins }));
  const rendered = renderUnit(plan[0], 0);
  assert.match(rendered, /Chicken thigh/);                 // cut stays in the name (space-joined)
  assert.doesNotMatch(rendered, /\(/);                     // …and NEVER wrapped in parentheses
});
