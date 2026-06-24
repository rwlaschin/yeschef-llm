// Canned responses for the fake/test transport (FAKE_TOPIC). A fake job dispatches
// its steps here instead of a model topic; this returns deterministic output per
// subtype, written through the worker's normal Firestore path — no Ollama, no delay.
//
// compliance must emit a terminal status block (@@::PASS::@@) so the worker marks the
// run success, exactly like a real compliance step. Other subtypes return plain text
// (no block → success).

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
    `  diet tags: ${payload.item || "regular"}`,
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
  return PROTEIN_POOLS.omnivore; // regular/diabetic/low-sodium/low-fat/gluten-free/lactose-free
}

// One diet's slice (this fanout unit). Emits the `Day N | Mealtime | Type | Cut` rows the
// app's protein-grid parser reads — honouring THIS unit's diet, mealtimes, and day count
// (passed on the fake dispatch message as payload.item / payload.ctx). Proteins rotate so
// the grid, heatmap, and rotation views show realistic reuse.
function cannedProteinGrid(payload = {}) {
  const ctx = payload.ctx || {};
  const meals = Array.isArray(ctx.meals) && ctx.meals.length ? ctx.meals : ["breakfast", "lunch", "dinner"];
  const days = Math.max(1, Number(ctx.days) || 7);
  const pool = poolForDiet(payload.item);
  const lines = ["Day | Mealtime | Type | Cut"];
  for (let d = 1; d <= days; d++) {
    for (let m = 0; m < meals.length; m++) {
      const [type, cut] = pool[(d * meals.length + m) % pool.length];
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
  return RECIPE_POOLS.omnivore; // regular/low-fat/gluten-free/lactose-free
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

// Per-meal nutrient totals for one diet (this fanout unit). Emits the pipe table the app
// parses + renders as a nutrition-facts panel vs USDA daily values:
//   Day | Mealtime | Calories | Protein g | Fat g | Carbs g | Sodium mg | Fiber g
// Base per-daypart values are nudged by diet (renal/low-sodium ↓ sodium, diabetic ↓ carbs,
// low-fat ↓ fat) and vary a little day-to-day so the daily averages look realistic.
function cannedNutrients(payload = {}) {
  const ctx = payload.ctx || {};
  const meals = Array.isArray(ctx.meals) && ctx.meals.length ? ctx.meals : ["breakfast", "lunch", "dinner"];
  const days = Math.max(1, Number(ctx.days) || 7);
  const diet = String(payload.item || "").toLowerCase();
  // [calories, protein g, fat g, carbs g, sodium mg, fiber g] per daypart.
  const BASE = { breakfast: [420, 22, 14, 52, 380, 5], lunch: [620, 34, 22, 70, 560, 7], dinner: [700, 38, 26, 76, 640, 8] };
  const DEFAULT = [560, 30, 20, 66, 520, 6];
  const sodiumK = diet.includes("renal") || diet.includes("low-sodium") ? 0.5 : 1;
  const carbsK = diet.includes("diabetic") ? 0.78 : 1;
  const fatK = diet.includes("low-fat") ? 0.6 : 1;
  const lines = ["Day | Mealtime | Calories | Protein g | Fat g | Carbs g | Sodium mg | Fiber g"];
  for (let d = 1; d <= days; d++) {
    const wobble = 1 + ((d % 3) - 1) * 0.06; // ±6% day-to-day
    for (const m of meals) {
      const [cal, pro, fat, carb, sod, fib] = BASE[m] || DEFAULT;
      lines.push([
        `Day ${d}`, m,
        Math.round(cal * wobble), Math.round(pro * wobble), Math.round(fat * fatK * wobble),
        Math.round(carb * carbsK * wobble), Math.round(sod * sodiumK * wobble), Math.round(fib * wobble),
      ].join(" | "));
    }
  }
  return lines.join("\n");
}

const BY_SUBTYPE = {
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
