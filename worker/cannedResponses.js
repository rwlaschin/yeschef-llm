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

// Single-recipe DETAIL. Matches the `recipe:` YAML output template in prompt_library
// (id/name/category/diet tags/batch/prep/service/holding/elevation). Diet- and protein-aware:
// pulls a dish off the SAME RECIPE_POOLS the recipes grid uses, so the detail lines up with the
// backbone. Deterministic — picks by diet, no randomness.
function cannedRecipe(payload = {}) {
  const pool = recipePoolForDiet(payload.item);
  const [dish, protein, starch, veg] = pool[0];
  const p = String(protein || "Chicken").toLowerCase();
  return [
    "recipe:",
    "  id: 00000000-0000-4000-8000-000000000001",
    `  name: ${dish}`,
    "  category: lunch",
    `  diet tags: ${payload.item || "standard"}`,
    "  batch:",
    "    yield portions: 100",
    "    portion weight: 6 oz",
    '    pan size: 2" Full Hotel Pan',
    "    pans per batch: 4",
    "  prep:",
    "    equipment: Tilt Skillet, Batch Mixer",
    "    ingredients:",
    `      - item: ${protein}`,
    "        quantity: 15",
    "        unit: kg",
    '        prep note: 1" dice, trimmed',
    `      - item: ${starch}`,
    "        quantity: 8",
    "        unit: kg",
    "        prep note: rinsed",
    `      - item: ${veg}`,
    "        quantity: 6",
    "        unit: kg",
    "        prep note: blanched",
    "    steps:",
    `      - step: 1`,
    `        action: Season and sear the ${p}`,
    "        temp: 350°F",
    "        time: 20 minutes",
    "        critical temp: 165°F poultry",
    "  service:",
    "    equipment: Steam Table",
    "    steps:",
    "      - step: 1",
    "        action: Portion and plate with starch and vegetable",
    "        temp: ~",
    "        time: ~",
    "        critical temp: ~",
    "  holding:",
    '    hot hold temp: "140°F / 60°C"',
    '    cold hold temp: "41°F / 5°C"',
    '    max hold time: "4 hours"',
    "  elevation notes:",
    "    high: Increase liquid 5% above 3500ft",
    "    low: ~",
  ].join("\n");
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

// One diet's reduced-recipe slice (this fanout unit) — the dish layer on the protein backbone.
// Emits `Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit` rows honouring THIS unit's
// diet, mealtimes, and day count (payload.item / payload.ctx). Dishes rotate for realistic reuse.
function cannedRecipes(payload = {}) {
  const ctx = payload.ctx || {};
  const meals = Array.isArray(ctx.meals) && ctx.meals.length ? ctx.meals : ["breakfast", "lunch", "dinner"];
  const days = Math.max(1, Number(ctx.days) || 7);
  const pool = recipePoolForDiet(payload.item);
  const lines = ["Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit"];
  for (let d = 1; d <= days; d++) {
    for (let m = 0; m < meals.length; m++) {
      const [dish, protein, starch, veg, fruit] = pool[(d * meals.length + m) % pool.length];
      lines.push(`Day ${d} | ${meals[m]} | ${dish} | ${protein} | ${starch} | ${veg} | ${fruit}`);
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

// Recipe-preview batch (protein grid → recipe suggestions). Emits the strict JSON array the
// client's parsePreviewResponse expects — plain array, no fences, no wrapping object — where
// each item has name, components[{ingredient, category, quantity, unit, prep}] and nutrition.
// Diet-aware via the SAME RECIPE_POOLS as cannedRecipe; deterministic — picks by diet.
// proteinType must ECHO the protein requested in the prompt (buildPreviewPrompt lines look like
// "1. <proteinType> — cut: <cut>, diet: <diet>, mealtime: <mealtime>"; proteinType may be
// multi-word) — the client keeps only items whose proteinType matches the slot's, exactly as it
// does with a real model's response.
function cannedRecipeSuggestion(payload = {}) {
  const requested = [...String(payload.query || "").matchAll(/^\s*\d+\.\s+(.+?)\s+—\s+cut:/gmu)].map((m) => m[1]);
  const pool = recipePoolForDiet(payload.item);
  const recipes = pool.slice(0, 2).map(([dish, protein, starch, veg], i) => ({
    proteinType: requested[i] ?? requested[0] ?? protein,
    name: dish, summary: "A delicious and balanced meal featuring " + protein + " and " + veg + ", served hot.",
    components: [
      { ingredient: protein, category: "protein", quantity: 4, unit: "oz", prep: '1" dice, trimmed' },
      { ingredient: starch, category: "starch", quantity: 0.5, unit: "cup", prep: "cooked" },
      { ingredient: veg, category: "vegetable", quantity: 0.5, unit: "cup", prep: "steamed soft" },
    ],
    nutrition: { kcal: 520, proteinG: 32, fatG: 18, carbG: 54, sodiumMg: 480, potassiumMg: 720, phosphorusMg: 310, fluidMl: 0 },
  }));
  return JSON.stringify(recipes);
}

const BY_SUBTYPE = {
  planner:      cannedPlanner,
  compliance:   cannedCompliance,
  menu_plan:    cannedMenuPlan,
  recipe:       cannedRecipe,
  protein_grid: cannedProteinGrid,
  recipes:      cannedRecipes,
  nutrients:    cannedNutrients,
  recipe_suggestion: cannedRecipeSuggestion,
};

export function cannedResponse(subtype, payload = {}) {
  const fn = BY_SUBTYPE[subtype];
  if (fn) return fn(payload);
  // Unknown subtype → a generic, success-shaped stub.
  return `Canned ${subtype || "step"} response.`;
}
