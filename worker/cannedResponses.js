// Canned responses for the fake/test transport (FAKE_TOPIC). A fake job dispatches
// its steps here instead of a model topic; this returns deterministic output per
// subtype, written through the worker's normal Firestore path — no Ollama, no delay.
//
// compliance must emit a terminal status block (@@::PASS::@@) so the worker marks the
// run success, exactly like a real compliance step. Other subtypes return plain text
// (no block → success).
import { FAKE_TOPIC } from "../config/models.js";

// The PLANNER dispatched to the fake worker (type="planner", no subtype) must return a VALID plan —
// a YAML step list build.js can parse — not the generic stub. Emit ONE step routed back to the fake
// topic (model=FAKE_TOPIC) so it too returns canned output; build.js parses this → dispatches step 0.
function cannedPlanner() {
  return [
    "```yaml",
    "- instructions: Canned task step (fake pipeline test).",
    `  model: ${FAKE_TOPIC}`,
    "  subtype: task",
    "  kind: single",
    "  contexts: []",
    "  tools: []",
    "```",
  ].join("\n");
}

function cannedCompliance() {
  return [
    "## Compliance check",
    "",
    "- ✅ Therapeutic diets meet CMS dietary standards (§483.60).",
    "- ✅ Allergen and restriction controls satisfied.",
    "- ✅ Texture modification validated against IDDSI framework.",
    "- ✅ Sodium and carbohydrate targets within range.",
    "",
    "@@::PASS::@@",
  ].join("\n");
}

function cannedMenuPlan(payload) {
  // The unit prompt (payload.query) carries the rendered diet/meal for this fanout unit.
  const ctx = String(payload?.query || "").slice(0, 120);
  return [
    "```yaml",
    "week: 1",
    "days:",
    "  monday:",
    "    breakfast: Oatmeal with berries",
    "    lunch: Herb-roasted chicken",
    "    dinner: Baked salmon & rice",
    "  tuesday:",
    "    breakfast: Scrambled eggs & toast",
    "    lunch: Lentil & vegetable stew",
    "    dinner: Turkey meatloaf & potatoes",
    "```",
    ctx ? `# unit: ${ctx}` : "",
  ].filter(Boolean).join("\n");
}

// Canonical recipe shape — the ONE permanent shape for ALL recipes, everywhere:
// { proteinType, name, summary, components[{ingredient,category,quantity,unit,prep}],
//   method[{text,phase,order}], nutrition{...} }. See buildCanonicalRecipe below.
// Three request styles arrive under subtype `recipe`, distinguished by the query text:
//   1. Suggestion batch (protein grid): numbered target lines → JSON array, one per target.
//   2. Directions (dish name + component lines): single recipe carrying the full method.
//   3. Plan-pipeline recipe step (anything else): single recipe from the diet pool.
// Always strict JSON — JSON is valid YAML, so formatRecipeYaml's parse→stringify is a no-op.
function cannedRecipe(payload = {}) {
  const query = String(payload.query || "");

  // Style 1 — suggestion batch: "N. <proteinType> — cut: <cut>, diet: <diet>, mealtime: <mealtime>"
  // (buildPreviewPrompt; proteinType may be multi-word and must be ECHOED verbatim — the client
  // keeps only items whose proteinType matches the slot's).
  const targets = [...query.matchAll(/^\s*\d+\.\s+(.+?)\s+—\s+cut:\s*(.*?),\s*diet:\s*(.*?),\s*mealtime:\s*(.*?)\s*$/gmu)]
    .map((m) => ({ protein: m[1].trim(), cut: m[2].trim(), mealtime: m[4].trim() }));
  const pool = recipePoolForDiet(payload.item);
  if (targets.length) {
    return JSON.stringify(targets.map((t) => buildCanonicalRecipe(pool, t)));
  }

  // Style 2 — directions: dish name line, then one "<prep> <ingredient>" line per component
  // (buildDirectionsPrompt). Return the full canonical recipe for that dish; the client reads
  // its `method`.
  const lines = query.split("\n").map((s) => s.trim()).filter(Boolean);
  if (lines.length > 1) {
    const items = lines.slice(1);
    const protein = items[0] || "protein";
    const recipe = buildCanonicalRecipe(pool, { protein, cut: "", mealtime: "" });
    return JSON.stringify({ ...recipe, name: lines[0], method: methodFor(protein.toLowerCase(), items.slice(1).map((s) => s.toLowerCase())) });
  }

  // Style 3 — plan-pipeline recipe step: one canonical recipe off the diet pool.
  return JSON.stringify(buildCanonicalRecipe(pool, { protein: pool[0][1], cut: "", mealtime: "lunch" }));
}

// One canonical recipe from a diet pool row. Mealtime shapes the plate: breakfast is
// protein + starch + fruit — NO savoury vegetable, so yogurt never lands next to spinach;
// lunch/dinner add the vegetable. No pool match → a "<protein> plate".
function buildCanonicalRecipe(pool, { protein, cut, mealtime }) {
  const matched = poolRowForProtein(pool, protein);
  const row = matched || pool[0];
  const [, , starch, veg, fruit] = row;
  const breakfast = /break/i.test(mealtime);
  const components = [
    { ingredient: protein, category: "protein", quantity: 4, unit: "oz", prep: cut || "portioned" },
    { ingredient: starch, category: "starch", quantity: 0.5, unit: "cup", prep: "cooked" },
    ...(breakfast ? [] : [{ ingredient: veg, category: "vegetable", quantity: 0.5, unit: "cup", prep: "steamed soft" }]),
    { ingredient: fruit, category: "fruit", quantity: 1, unit: "serving", prep: "fresh" },
  ];
  const partner = breakfast ? fruit : veg;
  const sides = components.slice(1).map((c) => String(c.ingredient).toLowerCase());
  return {
    proteinType: protein,
    name: matched ? row[0] : `${protein} plate`,
    summary: `A balanced ${(mealtime || "meal").toLowerCase()} featuring ${protein} with ${String(starch).toLowerCase()} and ${String(partner).toLowerCase()}.`,
    components,
    method: methodFor(String(protein).toLowerCase(), sides),
    nutrition: { kcal: 520, proteinG: 32, fatG: 18, carbG: 54, sodiumMg: 480, potassiumMg: 720, phosphorusMg: 310, fluidMl: 0 },
  };
}

// Method steps derived from the recipe's own components — no step for a dropped ingredient
// (e.g. a breakfast plate with no vegetable never gets a "blanch the spinach" step).
// make_ahead = prep/sear steps, on_line = plate/service steps.
function methodFor(protein, sides) {
  const sidesText = sides.length ? sides.join(" and ") : "the sides";
  return [
    { text: `Trim and prep the ${protein}; season and hold chilled.`, phase: "make_ahead" },
    { text: `Cook the ${protein} through, then hold for service.`, phase: "make_ahead" },
    { text: `Prepare ${sidesText} ahead.`, phase: "make_ahead" },
    { text: `Bring the ${protein} to a safe serving temperature on the line.`, phase: "on_line" },
    { text: `Portion and plate with ${sidesText}.`, phase: "on_line" },
  ].map((s, i) => ({ ...s, order: i }));
}

// Diet-appropriate protein pools — canned data must NEVER put meat on a vegan grid, etc.
// Picked by the unit's diet (payload.item). Cut is "" where a protein has no meaningful cut.
const PROTEIN_POOLS = {
  vegan:      [["Tofu", "firm"], ["Lentil", ""], ["Chickpea", ""], ["Black bean", ""], ["Tempeh", ""], ["Quinoa", ""], ["Edamame", ""], ["Seitan", ""]],
  vegetarian: [["Egg", "scrambled"], ["Greek yogurt", ""], ["Paneer", ""], ["Tofu", "firm"], ["Lentil", ""], ["Cottage cheese", ""], ["Chickpea", ""], ["Black bean", ""]],
  renal:      [["Egg white", ""], ["Chicken", "breast"], ["Cod", "fillet"], ["Turkey", "breast"], ["Tilapia", "fillet"], ["Tofu", "firm"]],
  halal:      [["Chicken", "thigh"], ["Lamb", "shoulder"], ["Beef", "chuck"], ["Turkey", "breast"], ["Cod", "fillet"], ["Egg", "scrambled"]],
  kosher:     [["Chicken", "thigh"], ["Beef", "brisket"], ["Turkey", "breast"], ["Cod", "fillet"], ["Salmon", "fillet"], ["Egg", "scrambled"]],
  omnivore:   [["Chicken", "thigh"], ["Beef", "chuck"], ["Salmon", "fillet"], ["Egg", "scrambled"], ["Turkey", "breast"], ["Cod", "fillet"], ["Pork", "loin"], ["Greek yogurt", ""]],
};
function poolForDiet(diet) {
  const d = String(diet || "").toLowerCase();
  if (d.includes("vegan")) return PROTEIN_POOLS.vegan;
  if (d.includes("vegetarian")) return PROTEIN_POOLS.vegetarian;
  if (d.includes("renal")) return PROTEIN_POOLS.renal;
  if (d.includes("halal")) return PROTEIN_POOLS.halal;
  if (d.includes("kosher")) return PROTEIN_POOLS.kosher;
  return PROTEIN_POOLS.omnivore; // standard/diabetic/low-sodium/low-fat/gluten-free/lactose-free
}

// FNV-1a hash — fast, no stdlib, deterministic across runs. Used to seed protein
// selection so each (diet, day, mealtime) slot has its own stable index.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// One diet's slice (this fanout unit). Emits the `Day N | Mealtime | Type | Cut` rows the
// app's protein-grid parser reads — honouring THIS unit's diet, mealtimes, and day count
// (passed on the fake dispatch message as payload.item / payload.ctx).
// Seed: fnv1a(diet + ":" + day + ":" + mealIndex) — diet-specific, day-specific, stable.
function cannedProteinGrid(payload = {}) {
  const ctx = payload.ctx || {};
  const meals = Array.isArray(ctx.meals) && ctx.meals.length ? ctx.meals : ["breakfast", "lunch", "dinner"];
  const days = Math.max(1, Number(ctx.days) || 7);
  const diet = String(payload.item || "standard");
  const pool = poolForDiet(diet);
  const lines = ["Day | Mealtime | Type | Cut"];
  for (let d = 1; d <= days; d++) {
    for (let m = 0; m < meals.length; m++) {
      const [type, cut] = pool[fnv1a(`${diet}:${d}:${m}`) % pool.length];
      lines.push(`Day ${d} | ${meals[m]} | ${type} | ${cut}`);
    }
  }
  return lines.join("\n");
}

// Diet-aware reduced-recipe pools — the dish layer built on the protein backbone. Keyed
// off the unit's diet (payload.item), parallel to PROTEIN_POOLS. Each entry is
// [dish, protein, starch, vegetable, fruit] so canned recipes never put meat on a vegan grid.
const RECIPE_POOLS = {
  vegan:      [["Tofu stir-fry", "Tofu", "Brown rice", "Broccoli", "Orange"], ["Lentil curry", "Lentil", "Quinoa", "Spinach", "Mango"], ["Chickpea bowl", "Chickpea", "Couscous", "Kale", "Apple"], ["Tempeh tacos", "Tempeh", "Corn tortilla", "Peppers", "Lime"], ["Black bean chili", "Black bean", "Sweet potato", "Tomato", "Avocado"], ["Edamame noodles", "Edamame", "Soba", "Bok choy", "Pear"]],
  vegetarian: [["Egg scramble", "Egg", "Toast", "Mushroom", "Berries"], ["Paneer masala", "Paneer", "Basmati rice", "Peas", "Mango"], ["Yogurt parfait", "Greek yogurt", "Granola", "Cucumber", "Banana"], ["Lentil soup", "Lentil", "Barley", "Carrot", "Apple"], ["Cottage cheese plate", "Cottage cheese", "Crackers", "Tomato", "Grapes"], ["Tofu bowl", "Tofu", "Brown rice", "Broccoli", "Orange"]],
  renal:      [["Poached egg whites", "Egg white", "White rice", "Green beans", "Apple"], ["Grilled chicken", "Chicken", "White bread", "Cabbage", "Berries"], ["Baked cod", "Cod", "Pasta", "Zucchini", "Pear"], ["Turkey patty", "Turkey", "Couscous", "Lettuce", "Grapes"], ["Tilapia plate", "Tilapia", "White rice", "Bell pepper", "Apple"], ["Tofu saute", "Tofu", "Noodles", "Onion", "Pineapple"]],
  halal:      [["Chicken kebab", "Chicken", "Rice pilaf", "Eggplant", "Dates"], ["Lamb stew", "Lamb", "Couscous", "Okra", "Apricot"], ["Beef tagine", "Beef", "Bulgur", "Carrot", "Orange"], ["Turkey wrap", "Turkey", "Flatbread", "Spinach", "Apple"], ["Baked cod", "Cod", "Rice", "Zucchini", "Lemon"], ["Egg shakshuka", "Egg", "Pita", "Tomato", "Grapes"]],
  kosher:     [["Roast chicken", "Chicken", "Potato", "Carrot", "Apple"], ["Beef brisket", "Beef", "Kugel", "Cabbage", "Orange"], ["Turkey schnitzel", "Turkey", "Rice", "Green beans", "Pear"], ["Baked cod", "Cod", "Quinoa", "Zucchini", "Berries"], ["Salmon fillet", "Salmon", "Couscous", "Asparagus", "Grapes"], ["Egg salad", "Egg", "Rye bread", "Cucumber", "Apple"]],
  omnivore:   [["Roast chicken", "Chicken", "Potato", "Broccoli", "Apple"], ["Beef stew", "Beef", "Barley", "Carrot", "Orange"], ["Grilled salmon", "Salmon", "Rice", "Asparagus", "Berries"], ["Egg scramble", "Egg", "Toast", "Mushroom", "Banana"], ["Turkey meatloaf", "Turkey", "Mashed potato", "Green beans", "Pear"], ["Baked cod", "Cod", "Couscous", "Zucchini", "Grapes"], ["Pork loin", "Pork", "Sweet potato", "Cabbage", "Apple"], ["Yogurt bowl", "Greek yogurt", "Granola", "Spinach", "Mango"]],
};
// Diabetic = low-glycemic starches (no white rice/potato/sugar). Low-sodium = unsalted
// preparations + low-sodium starches. Distinct from regular so the diet tabs actually differ.
RECIPE_POOLS.diabetic = [
  ["Grilled chicken & quinoa", "Chicken", "Quinoa", "Broccoli", "Berries"], ["Beef & lentils", "Beef", "Lentils", "Carrot", "Apple"],
  ["Baked salmon", "Salmon", "Wild rice", "Asparagus", "Pear"], ["Egg & veggie scramble", "Egg", "Steel-cut oats", "Mushroom", "Berries"],
  ["Turkey & barley", "Turkey", "Barley", "Green beans", "Apple"], ["Cod & farro", "Cod", "Farro", "Zucchini", "Grapes"],
  ["Pork & chickpeas", "Pork", "Chickpeas", "Cabbage", "Plum"], ["Yogurt & nuts", "Greek yogurt", "Almonds", "Spinach", "Berries"],
];
RECIPE_POOLS.low_sodium = [
  ["Unsalted roast chicken", "Chicken", "Brown rice", "Broccoli", "Apple"], ["Herb beef stew", "Beef", "Barley", "Carrot", "Orange"],
  ["Lemon salmon (no salt)", "Salmon", "Rice", "Asparagus", "Berries"], ["Plain egg scramble", "Egg", "Toast (low-sodium)", "Mushroom", "Banana"],
  ["Turkey & herbs", "Turkey", "Mashed potato (unsalted)", "Green beans", "Pear"], ["Steamed cod", "Cod", "Couscous", "Zucchini", "Grapes"],
  ["Pork & herbs", "Pork", "Sweet potato", "Cabbage", "Apple"], ["Yogurt bowl (no added salt)", "Greek yogurt", "Granola (low-sodium)", "Spinach", "Mango"],
];
function recipePoolForDiet(diet) {
  const d = String(diet || "").toLowerCase();
  if (d.includes("vegan")) return RECIPE_POOLS.vegan;
  if (d.includes("vegetarian")) return RECIPE_POOLS.vegetarian;
  if (d.includes("renal")) return RECIPE_POOLS.renal;
  if (d.includes("halal")) return RECIPE_POOLS.halal;
  if (d.includes("kosher")) return RECIPE_POOLS.kosher;
  if (d.includes("diabetic")) return RECIPE_POOLS.diabetic;
  if (d.includes("low-sodium") || d.includes("low sodium")) return RECIPE_POOLS.low_sodium;
  return RECIPE_POOLS.omnivore; // standard/low-fat/gluten-free/lactose-free
}

// Normalize a diet key so the grid ("diet 1") and the recipe fanout item (values.diets, may be
// spaced/cased differently or empty) match. Used to look up a slot's grid protein.
function normDiet(s) { return String(s || "").replace(/\s+/g, "").toLowerCase(); }

// Pool row whose protein matches `type` (case-insensitive, either contains the other) — so the
// grid's protein drives the dish + sides. Null when nothing matches.
function poolRowForProtein(pool, type) {
  const t = String(type || "").toLowerCase();
  if (!t) return null;
  return pool.find(([, protein]) => {
    const p = String(protein || "").toLowerCase();
    return p && (t.includes(p) || p.includes(t));
  }) || null;
}

// This unit's per-slot proteins from the grid (payload.ctx.proteins: normDiet → day → mealtime →
// {type,cut}). When the unit's diet isn't found but the grid has exactly one diet (the common
// single-diet case, incl. an empty values.diets fanout with item=null), fall back to that one.
function slotProteinsFor(ctx, diet) {
  const all = ctx.proteins || {};
  const keys = Object.keys(all);
  if (!keys.length) return null;
  const direct = all[normDiet(diet)];
  if (direct) return direct;
  return keys.length === 1 ? all[keys[0]] : null;
}

// One diet's reduced-recipe slice (this fanout unit) — the dish layer on the protein backbone.
// Emits `Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit` rows honouring THIS unit's
// diet, mealtimes, and day count (payload.item / payload.ctx). Each slot's recipe is seeded FROM
// the proteins grid's assigned protein for that day·mealtime (payload.ctx.proteins) so recipes
// MIRROR the grid; the grid protein drives the dish + sides (matched pool row, else the rotation).
// No grid protein for a slot → the diet-pool rotation (legacy behavior, e.g. real-model builds).
function cannedRecipes(payload = {}) {
  const ctx = payload.ctx || {};
  const meals = Array.isArray(ctx.meals) && ctx.meals.length ? ctx.meals : ["breakfast", "lunch", "dinner"];
  const days = Math.max(1, Number(ctx.days) || 7);
  const pool = recipePoolForDiet(payload.item);
  const gridProteins = slotProteinsFor(ctx, payload.item);
  const lines = ["Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit"];
  for (let d = 1; d <= days; d++) {
    for (let m = 0; m < meals.length; m++) {
      const meal = meals[m];
      const fallback = pool[(d * meals.length + m) % pool.length];
      const gridSlot = gridProteins && gridProteins[d] && gridProteins[d][meal];
      let dish, protein, starch, veg, fruit;
      if (gridSlot && gridSlot.type) {
        protein = gridSlot.type;
        const match = poolRowForProtein(pool, protein);
        if (match) { dish = match[0]; starch = match[2]; veg = match[3]; fruit = match[4]; }
        else { dish = `${protein} plate`; starch = fallback[2]; veg = fallback[3]; fruit = fallback[4]; }
      } else {
        [dish, protein, starch, veg, fruit] = fallback;
      }
      lines.push(`Day ${d} | ${meal} | ${dish} | ${protein} | ${starch} | ${veg} | ${fruit}`);
    }
  }
  return lines.join("\n");
}

// Per-meal nutrient totals for one diet (this fanout unit). Emits EXACTLY the pipe table the
// nutrients prompt/parser contract expects (plan_library + seed-recipes-nutrients.mjs) — same
// header, same 4 columns, same order, or the fake won't line up with a real run:
//   Day | Mealtime | Calories | Protein g | Sodium mg | Carbs g
// Base per-daypart values are shaped by diet (renal/low-sodium ↓ sodium, renal ↓ protein,
// diabetic ↓ carbs) then jittered by a diet+day+meal seed — same scheme as cannedProteinGrid —
// so every diet's table is DISTINCT (two diets sharing coefficients must not emit identical rows)
// and days vary realistically instead of a fixed wobble cycle.
function cannedNutrients(payload = {}) {
  const ctx = payload.ctx || {};
  const meals = Array.isArray(ctx.meals) && ctx.meals.length ? ctx.meals : ["breakfast", "lunch", "dinner"];
  const days = Math.max(1, Number(ctx.days) || 7);
  const diet = String(payload.item || "standard").toLowerCase();
  // [calories, protein g, sodium mg, carbs g] per daypart.
  const BASE = { breakfast: [380, 24, 320, 46], lunch: [560, 32, 520, 64], dinner: [620, 36, 600, 72] };
  const DEFAULT = [520, 30, 480, 60];
  const sodiumK = diet.includes("renal") || diet.includes("low-sodium") || diet.includes("low sodium") ? 0.5 : 1;
  const proteinK = diet.includes("renal") ? 0.7 : 1;
  const carbsK = diet.includes("diabetic") ? 0.78 : 1;
  const lines = ["Day | Mealtime | Calories | Protein g | Sodium mg | Carbs g"];
  for (let d = 1; d <= days; d++) {
    for (let m = 0; m < meals.length; m++) {
      const meal = meals[m];
      const [cal, pro, sod, carb] = BASE[meal] || DEFAULT;
      // Diet+day+meal seed → a stable ±15% jitter unique to this slot, so identical-coefficient
      // diets still diverge and no two fanout messages return the same table.
      const jit = 0.85 + (fnv1a(`${diet}:${d}:${meal}`) % 31) / 100;
      lines.push([
        `Day ${d}`, meal,
        Math.round(cal * jit),
        Math.round(pro * proteinK * jit),
        Math.round(sod * sodiumK * jit),
        Math.round(carb * carbsK * jit),
      ].join(" | "));
    }
  }
  return lines.join("\n");
}

const BY_SUBTYPE = {
  planner:      cannedPlanner,
  compliance:   cannedCompliance,
  menu_plan:    cannedMenuPlan,
  recipe:       cannedRecipe,
  protein_grid: cannedProteinGrid,
  recipes:      cannedRecipes,
  nutrients:    cannedNutrients,
};

export function cannedResponse(subtype, payload = {}) {
  const fn = BY_SUBTYPE[subtype];
  if (fn) return fn(payload);
  // Unknown subtype → a generic, success-shaped stub.
  return `Canned ${subtype || "step"} response.`;
}
