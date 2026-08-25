// Canned responses for the fake/test transport (FAKE_TOPIC). A fake job dispatches
// its steps here instead of a model topic; this returns deterministic output per
// subtype, written through the worker's normal Firestore path — no Ollama, no delay.
//
// compliance must emit a terminal status block (@@::PASS::@@) so the worker marks the
// run success, exactly like a real compliance step. Other subtypes return plain text
// (no block → success).
import { FAKE_TOPIC } from "../config/models.js";
import { COMPONENT_CATEGORIES } from "./recipeTemplate.js";
import { WIDGET_REFUSAL } from "./analyticsWidget.js";

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

// A recipe is ONE DISH, so its components are the protein plus what is COOKED INTO it — never the
// toast, mushroom and banana that sit beside it on the tray. Those are dishes of their own at their
// own course positions (COURSE_DISHES), and a dish that lists them is a meal wearing a dish's name.
// No catalogue match → a "<protein> plate", which is honestly a plate and carries nothing else.
const COOKED_IN_PORTION = { seasoning: [1, "tbsp"], fat: [1, "tbsp"], dairy: [2, "tbsp"] };
function buildCanonicalRecipe(pool, { protein, cut, mealtime }) {
  const matched = poolRowForProtein(pool, protein);
  const cooked = matched ? matched[2] : [];
  const components = [
    { ingredient: protein, category: "protein", quantity: 4, unit: "oz", prep: cut || "portioned" },
    ...cooked.map(([ingredient, category]) => {
      const [quantity, unit] = COOKED_IN_PORTION[category] || [0.25, "cup"];
      return { ingredient, category, quantity, unit, prep: "prepped" };
    }),
  ];
  const sides = cooked.map(([ingredient]) => String(ingredient).toLowerCase());
  const withText = sides.length ? ` with ${sides.join(" and ")}` : "";
  return {
    proteinType: protein,
    name: matched ? matched[0] : `${protein} plate`,
    summary: `A ${(mealtime || "meal").toLowerCase()} dish of ${protein}${withText}.`,
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

// What KIND of food each protein is — the input to the per-diet rule below.
const PROTEIN_CLASS = {
  Tofu: "plant", Tempeh: "plant", Seitan: "plant", Edamame: "plant", Lentil: "plant",
  Chickpea: "plant", "Black bean": "plant", Quinoa: "plant",
  Egg: "egg", "Egg white": "egg",
  "Greek yogurt": "dairy", Paneer: "dairy", "Cottage cheese": "dairy",
  Chicken: "poultry", Turkey: "poultry",
  Cod: "fish", Tilapia: "fish", Salmon: "fish",
  Beef: "meat", Lamb: "meat", Pork: "pork",
};

// The rule that lets a given diet accept a given class. Returns null when the diet has no rule
// bearing on it, so the reason never claims a rule that did not apply.
function dietRuleFor(diet, cls) {
  const d = String(diet).toLowerCase();
  if (d.includes("vegan")) return cls === "plant" ? "carries no animal product" : null;
  if (d.includes("vegetarian")) return "carries no meat, poultry or seafood";
  if (d.includes("renal")) return "phosphorus and potassium stay inside the renal limit";
  if (d.includes("halal") || d.includes("kosher")) return "a permitted species carrying no pork";
  return "no dietary restriction on this menu excludes it";
}

// Group the row's OWN diets by the rule that admitted them, so the reason cites only diets actually
// on the row — never a cross-reference to a diet this protein was not categorized for.
function reasonFor(type, diets) {
  const cls = PROTEIN_CLASS[type] || "other";
  const byRule = new Map();
  for (const diet of diets) {
    const rule = dietRuleFor(diet, cls);
    if (!rule) continue;
    if (!byRule.has(rule)) byRule.set(rule, []);
    byRule.get(rule).push(diet);
  }
  if (!byRule.size) return "admitted on the listed diets";
  return [...byRule].map(([rule, ds]) => `${ds.join(" and ")}: ${rule}`).join("; ");
}

// The chef adjusts these categories in the UI, so a fake build has to produce them. Derived by
// INVERTING PROTEIN_POOLS across the plan's diets — a protein belongs to a diet when it sits in
// that diet's pool — so fake categories can never contradict the fake grid or recipes.
// One row per TYPE: a cut does not decide which diets a protein serves, so keying on it would split
// one judgement into contradictory rows (renal lists chicken breast, standard lists thigh, which
// would read as "thigh is not renal-safe" — a pool coincidence). The cut is still reported, joined
// where a type appears with more than one.
// RAW proteins only — the bare ingredient, no cut. A cut is chosen later, per meal, so carrying one
// here would fix a whole cycle to (say) chicken thigh.
// `payload.query` naming one protein classifies JUST that protein — the add-a-protein path, where the
// chef types a name and the diets it suits have to be worked out.
function cannedProteinCategories(payload = {}) {
  const ctx = payload.ctx || {};
  const diets = Array.isArray(ctx.diets) && ctx.diets.length ? ctx.diets : ["standard"];
  const asked = String(payload.query || "").trim();

  // type -> the diets whose pool contains it (PROTEIN_POOLS already encodes diet-appropriateness).
  const byType = new Map();
  for (const diet of diets) {
    for (const [type] of poolForDiet(diet)) {
      if (!byType.has(type)) byType.set(type, []);
      if (!byType.get(type).includes(diet)) byType.get(type).push(diet);
    }
  }

  // Chef-typed proteins must appear even though no pool proposed them. Unknown to the pools, so they
  // get the diets with no ingredient rule against them rather than a fabricated judgement.
  for (const name of (Array.isArray(ctx.addedProteins) ? ctx.addedProteins : [])) {
    const t = String(name).trim();
    if (!t) continue;
    const hit = [...byType.keys()].find((k) => k.toLowerCase() === t.toLowerCase());
    if (!hit) byType.set(t, diets.filter((d) => !/vegan|vegetarian/i.test(d)));
  }

  const lines = ["Protein | Diets | Why"];
  if (asked) {
    // Match the pool case-insensitively; an unknown protein falls back to the diets with no
    // ingredient rule against it rather than claiming knowledge the pools don't have.
    const hit = [...byType.keys()].find((t) => t.toLowerCase() === asked.toLowerCase());
    const type = hit || asked;
    const ds = hit ? byType.get(hit) : diets.filter((d) => !/vegan|vegetarian/i.test(d));
    lines.push(`${type} | ${ds.join(", ")} | ${reasonFor(type, ds)}`);
    return lines.join("\n");
  }

  for (const type of [...byType.keys()].sort((a, b) => a.localeCompare(b))) {
    lines.push(`${type} | ${byType.get(type).join(", ")} | ${reasonFor(type, byType.get(type))}`);
  }
  return lines.join("\n");
}

// The diet keys (yeschef/src/lib/planOptions.ts DIETS) a dish may DECLARE. Every dish in this file —
// entrée and accompaniment alike — carries the list of diets it satisfies, because that declaration
// is the only thing downstream can read: the frontend used to infer it by comparing dish names
// across diets, which never matched and lit nothing.
// Written as an EXCLUSION because that is how a kitchen reasons about a dish: buttered toast is
// fine for everyone except the diets butter and wheat rule out.
const DIET_KEYS = ["standard", "diabetic", "low-sodium", "renal", "gluten-free", "vegetarian", "vegan", "low-fat", "lactose-free"];
const DM = "diabetic", LS = "low-sodium", RNL = "renal", GF = "gluten-free",
      VEG = "vegetarian", VGN = "vegan", LF = "low-fat", LAC = "lactose-free";
const ALL = DIET_KEYS;
const but = (...ks) => DIET_KEYS.filter((k) => !ks.includes(k));

// The unit's diet string → one canonical diet key. Halal and kosher are restrictions rather than
// diets (planOptions.ts RESTRICTIONS), so they read as standard here; the entrée pool still honours
// them, since that is where species actually matters.
function dietKeyFor(diet) {
  const d = String(diet || "").toLowerCase().replace(/\s+/g, "-");
  return DIET_KEYS.find((k) => d.includes(k)) || "standard";
}

// WE DO DISHES AND WHICH DIETS THEY SATISFY. One dish exists ONCE, under one plain name, declaring
// every diet it satisfies. The entrée catalogue used to be keyed BY DIET, so the same scramble sat
// in four pools under four names ("Egg scramble", "Egg & veggie scramble", "Plain egg scramble",
// "Scrambled eggs") — and once the frontend stacked every diet's dish into one cell, one dish
// rendered as four cards. A diet-driven preparation is one dish DECLARING that diet, never a
// renamed twin, so no dish name may carry a diet word.
// Each entry is [dish, protein, cookedIn, diets]:
//   cookedIn — [ingredient, category] pairs COOKED INTO the dish. Never an accompaniment: toast,
//              mushrooms and a banana are dishes of their own at their own course positions, and an
//              entrée that lists them is a meal wearing a dish's name.
//   diets    — the diet keys this dish satisfies; the entrée's own declaration, the only thing
//              downstream can read.
// A dish served at both dayparts is ONE binding referenced from both catalogues, so it cannot drift
// into two declarations.
// cookedIn is reconciled against the curated method (recipeMethods.ts `scrambled-eggs`, from the
// USDA/ICN standardized recipe): pasteurized liquid whole egg, nonfat milk, salt, margarine. Butter
// and black pepper were declared here but appear in no step, so they are gone.
// LAC is excluded: the curated method cooks nonfat milk into the dish, so it is not lactose-free.
const SCRAMBLED_EGGS = ["Scrambled eggs", "Egg", [["Nonfat milk", "dairy"], ["Salt", "seasoning"], ["Margarine", "fat"]], but(VGN, RNL, LF, LAC)];
const SHAKSHUKA = ["Shakshuka", "Egg", [["Tomato", "vegetable"], ["Cumin", "seasoning"]], but(VGN, LS, RNL)];
const EGG_WHITE_OMELET = ["Egg white omelet", "Egg white", [["Chives", "seasoning"]], but(VGN)];
const YOGURT_PARFAIT = ["Yogurt parfait", "Greek yogurt", [["Granola", "starch"], ["Berries", "fruit"]], but(VGN, LAC, DM, GF, RNL)];

// Lunch/dinner entrées. ONE catalogue for every diet — a diet selects from it by declaration, it
// does not get a pool of its own.
// ORDER IS THE MENU. A slot takes a contiguous slice of this list, so grouping the dishes by protein
// family would serve a week of nothing but beans; the families are interleaved instead, and any
// window of a few days reads like a menu a kitchen would actually run.
const MAIN_ENTREES = [
  ["Roast chicken", "Chicken", [["Rosemary", "seasoning"], ["Olive oil", "fat"]], but(VEG, VGN)],
  ["Beef stew", "Beef", [["Carrot", "vegetable"], ["Beef stock", "seasoning"]], but(VEG, VGN, DM, GF, RNL, LF)],
  ["Baked cod", "Cod", [["Lemon", "fruit"], ["Parsley", "seasoning"]], but(VEG, VGN)],
  SCRAMBLED_EGGS,
  ["Tofu stir-fry", "Tofu", [["Broccoli", "vegetable"], ["Soy sauce", "seasoning"]], but(GF, LS, RNL)],
  ["Turkey meatloaf", "Turkey", [["Breadcrumbs", "starch"], ["Onion", "vegetable"]], but(VEG, VGN, DM, GF, LS, RNL, LF)],
  ["Pork loin", "Pork", [["Thyme", "seasoning"], ["Olive oil", "fat"]], but(VEG, VGN, RNL)],
  ["Grilled salmon", "Salmon", [["Lemon", "fruit"], ["Dill", "seasoning"]], but(VEG, VGN, RNL, LF)],
  YOGURT_PARFAIT,
  ["Lentil curry", "Lentil", [["Onion", "vegetable"], ["Curry spice", "seasoning"]], but(RNL)],
  ["Chicken kebab", "Chicken", [["Peppers", "vegetable"], ["Cumin", "seasoning"]], but(VEG, VGN, LS, RNL)],
  ["Beef brisket", "Beef", [["Onion", "vegetable"], ["Paprika", "seasoning"]], but(VEG, VGN, DM, LS, RNL, LF)],
  ["Pan-seared tilapia", "Tilapia", [["Lemon", "fruit"], ["Paprika", "seasoning"]], but(VEG, VGN)],
  ["Egg salad", "Egg", [["Mayonnaise", "fat"], ["Celery", "vegetable"]], but(VGN, LS, RNL, LF)],
  ["Stewed chickpeas", "Chickpea", [["Tomato", "vegetable"], ["Garlic", "seasoning"]], but(RNL)],
  ["Turkey patty", "Turkey", [["Breadcrumbs", "starch"], ["Onion", "vegetable"]], but(VEG, VGN, GF)],
  ["Lamb stew", "Lamb", [["Onion", "vegetable"], ["Rosemary", "seasoning"]], but(VEG, VGN, DM, GF, LS, RNL, LF)],
  SHAKSHUKA,
  ["Tempeh tacos", "Tempeh", [["Corn tortilla", "starch"], ["Peppers", "vegetable"]], but(LS, RNL)],
  ["Turkey schnitzel", "Turkey", [["Breadcrumbs", "starch"], ["Paprika", "seasoning"]], but(VEG, VGN, GF, LS, RNL, LF)],
  ["Beef tagine", "Beef", [["Apricot", "fruit"], ["Ras el hanout", "seasoning"]], but(VEG, VGN, LS, RNL, LF)],
  EGG_WHITE_OMELET,
  ["Black bean chili", "Black bean", [["Tomato", "vegetable"], ["Chili spice", "seasoning"]], but(RNL)],
  ["Turkey wrap", "Turkey", [["Flour tortilla", "starch"], ["Lettuce", "vegetable"]], but(VEG, VGN, GF, LS, RNL)],
  ["Paneer masala", "Paneer", [["Tomato", "vegetable"], ["Cream", "dairy"]], but(VGN, LAC, LS, RNL, LF)],
  ["Edamame noodles", "Edamame", [["Soba noodles", "starch"], ["Bok choy", "vegetable"]], but(GF, LS, RNL)],
];

// Breakfast entrées, kept SEPARATE because a daypart is not a seasoning: beef stew is not a
// breakfast dish, and drawing the morning entrée from the dinner catalogue is what put egg noodles
// and pot roast on a breakfast tray. A protein with no breakfast dish falls back to a plate rather
// than borrowing a dinner one.
const BREAKFAST_ENTREES = [
  SCRAMBLED_EGGS,
  ["Turkey sausage patty", "Turkey", [["Sage", "seasoning"], ["Fennel", "seasoning"]], but(VEG, VGN, LS, RNL, LF)],
  ["Tofu scramble", "Tofu", [["Peppers", "vegetable"], ["Turmeric", "seasoning"]], ALL],
  YOGURT_PARFAIT,
  // Reconciled against the curated `chicken-hash` method: it seasons with granulated garlic and
  // black pepper (no added salt), so both are declared here.
  ["Chicken hash", "Chicken", [["Potatoes", "starch"], ["Onion", "vegetable"], ["Peppers", "vegetable"], ["Vegetable oil", "fat"], ["Garlic", "seasoning"], ["Black pepper", "seasoning"]], but(VEG, VGN, RNL)],
  ["Chickpea flour pancakes", "Chickpea", [["Scallion", "vegetable"], ["Turmeric", "seasoning"]], but(DM, RNL)],
  SHAKSHUKA,
  ["Smoked salmon", "Salmon", [["Dill", "seasoning"]], but(VEG, VGN, LS, RNL)],
  ["Quinoa porridge", "Quinoa", [["Cinnamon", "seasoning"]], but(RNL)],
  ["Ham and cheese omelet", "Pork", [["Cheddar", "dairy"], ["Butter", "fat"]], but(VEG, VGN, LAC, LS, RNL, LF)],
  EGG_WHITE_OMELET,
  ["Cod cakes", "Cod", [["Potatoes", "starch"], ["Parsley", "seasoning"]], but(VEG, VGN, LS, RNL)],
  ["Black bean breakfast burrito", "Black bean", [["Corn tortilla", "starch"], ["Peppers", "vegetable"]], but(LS, RNL)],
  ["Paneer bhurji", "Paneer", [["Tomato", "vegetable"], ["Turmeric", "seasoning"]], but(VGN, LAC, LS, RNL, LF)],
  ["Lamb kofta", "Lamb", [["Onion", "vegetable"], ["Cumin", "seasoning"]], but(VEG, VGN, LS, RNL, LF)],
  ["Lentil hash", "Lentil", [["Potatoes", "starch"], ["Onion", "vegetable"], ["Peppers", "vegetable"], ["Vegetable oil", "fat"]], but(LS, RNL)],
];

const isBreakfast = (meal) => /break/i.test(String(meal || ""));

// Halal and kosher are RESTRICTIONS, not diets (planOptions.ts RESTRICTIONS) — they rule a species
// out rather than shape the nutrition, so they cannot be a diet declaration and subtract from the
// catalogue instead.
const RESTRICTED_PROTEINS = { halal: ["Pork"], kosher: ["Pork"] };

// The entrées a unit may be served: the ONE catalogue for this daypart, minus what its restriction
// forbids, narrowed to the dishes that DECLARE its diet — exactly as dishesFor does for every other
// course. Selecting a pool by diet key is what served a gluten-free tray a granola parfait.
function entreePoolFor(diet, meal) {
  const d = String(diet || "").toLowerCase();
  const banned = RESTRICTED_PROTEINS[d.includes("halal") ? "halal" : d.includes("kosher") ? "kosher" : ""] || [];
  const catalogue = (isBreakfast(meal) ? BREAKFAST_ENTREES : MAIN_ENTREES).filter((row) => !banned.includes(row[1]));
  const fit = catalogue.filter((row) => row[3].includes(dietKeyFor(diet)));
  return fit.length ? fit : catalogue;
}
function recipePoolForDiet(diet) { return entreePoolFor(diet, "lunch"); }

// Normalize a diet key so the grid ("diet 1") and the recipe fanout item (values.diets, may be
// spaced/cased differently or empty) match. Used to look up a slot's grid protein.
function normDiet(s) { return String(s || "").replace(/\s+/g, "").toLowerCase(); }

// Catalogue entry whose protein matches `type` (case-insensitive, either contains the other) — so
// the grid's protein drives which dish the slot serves. Null when nothing matches.
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

// Course positions a meal offers, after the Skilled Nursing care-level template the production-menu
// mockup encodes (src/components/mockups/production-menu.tsx:60-64). Each entry is [course, kind];
// `kind` is a :CourseType slug. The ENTRÉE MUST COME FIRST: it is the row carrying the grid's
// assigned protein, and every consumer that asks "what protein is on this slot" reads the slot's
// first row. Per-site course lists will eventually replace this constant.
// The fixture deliberately exercises EVERY course kind and the repeat cases — two soups and two
// sides at the main services — so a fake build surfaces the same shapes a real one can produce
// rather than a reduced happy path that hides bugs in the repeat handling.
const MEAL_COURSES = {
  breakfast: [["Entrée", "entree"], ["Cereal", "starch"], ["Side", "side"], ["Side", "side"], ["Beverage", "beverage"]],
  lunch:     [["Appetizer", "appetizer"], ["Soup", "soup"], ["Soup", "soup"], ["Salad", "salad"], ["Entrée", "entree"],
              ["Starch", "starch"], ["Vegetable", "vegetable"], ["Side", "side"], ["Side", "side"], ["Dessert", "dessert"], ["Beverage", "beverage"]],
  dinner:    [["Appetizer", "appetizer"], ["Soup", "soup"], ["Soup", "soup"], ["Salad", "salad"], ["Entrée", "entree"],
              ["Starch", "starch"], ["Vegetable", "vegetable"], ["Side", "side"], ["Side", "side"], ["Dessert", "dessert"], ["Beverage", "beverage"]],
};
const DEFAULT_COURSES = MEAL_COURSES.lunch;

// Printed name for a course slug. `side` is a Side — never "Fruit", which named the position after
// one dish that happened to fill it and made every side on the menu read as fruit.
const COURSE_NAME = {
  appetizer: "Appetizer", soup: "Soup", salad: "Salad", entree: "Entrée",
  starch: "Starch", vegetable: "Vegetable", side: "Side", dessert: "Dessert", beverage: "Beverage",
};
// Course order down a printed menu, so a configured list still reads in service order.
const COURSE_SEQ = ["appetizer", "soup", "salad", "entree", "starch", "vegetable", "side", "dessert", "beverage"];

// The positions this meal offers. The PLAN decides them (ctx.courseCounts, set on the setup page);
// a count above 1 repeats the position numbered. Only when the plan carries none do we fall back to
// the Skilled Nursing template, and that fallback is a fixture — the production default is
// entrée-plus-sides, which arrives here as courseCounts.
function coursePositions(ctx, meal) {
  const counts = ctx.courseCounts && Object.keys(ctx.courseCounts).length ? ctx.courseCounts : null;
  // Template path: each repeat of a kind carries its own occurrence index, so a two-soup service is
  // two DIFFERENT soups rather than the same one twice. The template says how many of each position
  // there are — including beverages; nothing here silently multiplies a position.
  if (!counts) {
    const seen = new Map();
    return (MEAL_COURSES[meal] || DEFAULT_COURSES).map(([name, kind]) => {
      const i = seen.get(kind) ?? 0;
      seen.set(kind, i + 1);
      return [name, kind, i];
    });
  }
  const out = [];
  for (const kind of COURSE_SEQ) {
    // The COUNT is the chef's, including for drinks: asking for 2 beverages must not produce 7.
    // BEVERAGES only decides WHICH drinks fill those positions, never how many there are.
    const n = Number(counts[kind]) || 0;
    const name = COURSE_NAME[kind] || kind;
    // No numbering: two sides are two DISHES, not "Side 1" and "Side 2". Numbering the course made
    // the Course column a reworded copy of Kind, which tells a reader nothing the Kind didn't.
    for (let i = 0; i < n; i++) out.push([name, kind, i]);
  }
  return out;
}

// A COURSE IS ITS OWN DISH. Every accompaniment used to be a string spun off the entrée's tuple —
// the starch column reworded, the fruit column twice — which is why breakfast served buttered egg
// noodles and a slot carried "Orange wedges" beside "Orange compote". So each kind gets its OWN
// candidate dishes, and each candidate is [name, ingredient, category, diets]:
//   ingredient — the commodity behind the dish; it fills the one column its category owns.
//   category   — a ComponentCategory (yeschef/src/query/hooks/recipes.ts). Only protein/starch/
//                vegetable/fruit have a column; dairy, fat, seasoning and beverage fill none.
//   diets      — the diet keys (planOptions.ts DIETS) this dish SATISFIES. This declaration is the
//                whole diet-safety guarantee now: nothing downstream can infer it from the entrée.
//
// Sauces, syrups and dressings are DISHES with kind `side` — they are ordered, plated and costed
// like anything else, so no dish name may carry one ("Buttermilk pancakes & syrup" is two dishes).
const COURSE_DISHES = {
  main: {
    appetizer: [
      ["Marinated vegetable salad", "Mixed vegetables", "vegetable", ALL],
      ["Chilled melon cup", "Melon", "fruit", but(RNL)],
      ["Stuffed mushroom caps", "Mushroom", "vegetable", but(VGN, LAC, LF)],
      ["Tomato bruschetta", "Tomato", "vegetable", but(GF, RNL)],
    ],
    soup: [
      ["Garden vegetable soup", "Mixed vegetables", "vegetable", ALL],
      ["Split pea soup", "Split peas", "vegetable", but(RNL)],
      ["Tomato bisque", "Tomato", "vegetable", but(VGN, LAC, RNL, LF)],
      ["Chicken noodle soup", "Chicken", "protein", but(VEG, VGN, GF)],
      ["Corn chowder", "Corn", "vegetable", but(VGN, LAC, RNL)],
      ["Beef barley soup", "Beef", "protein", but(VEG, VGN, GF)],
      ["Lentil soup", "Lentils", "protein", but(RNL)],
    ],
    salad: [
      ["Garden salad", "Mixed greens", "vegetable", ALL],
      ["Cucumber and dill salad", "Cucumber", "vegetable", ALL],
      ["Coleslaw", "Cabbage", "vegetable", but(VGN, LF)],
      ["Caesar salad", "Romaine", "vegetable", but(VGN, GF, LAC, LF)],
      ["Three-bean salad", "Green beans", "vegetable", but(RNL)],
    ],
    starch: [
      ["Steamed white rice", "White rice", "starch", ALL],
      ["Wild rice pilaf", "Wild rice", "starch", ALL],
      ["Herbed couscous", "Couscous", "starch", but(GF)],
      ["Mashed potatoes", "Potatoes", "starch", but(RNL, VGN, LAC)],
      ["Buttered egg noodles", "Egg noodles", "starch", but(GF, VGN, LAC, LF)],
      ["Dinner roll", "Wheat roll", "starch", but(GF)],
      ["Roasted sweet potatoes", "Sweet potato", "starch", but(RNL)],
      ["Farro pilaf", "Farro", "starch", but(GF)],
    ],
    vegetable: [
      ["Steamed broccoli", "Broccoli", "vegetable", ALL],
      ["Roasted zucchini", "Zucchini", "vegetable", ALL],
      ["Braised cabbage", "Cabbage", "vegetable", ALL],
      ["Buttered carrots", "Carrots", "vegetable", but(VGN, LAC, LF)],
      ["Green beans almondine", "Green beans", "vegetable", but(VGN, LAC, LF)],
      ["Glazed baby carrots", "Carrots", "vegetable", but(DM)],
      ["Sauteed spinach", "Spinach", "vegetable", but(RNL)],
    ],
    side: [
      ["Applesauce", "Apples", "fruit", ALL],
      ["Cranberry sauce", "Cranberries", "fruit", but(DM)],
      ["Dinner roll", "Wheat roll", "starch", but(GF)],
      ["Seasonal fruit cup", "Mixed fruit", "fruit", but(RNL)],
      ["Cottage cheese cup", "Cottage cheese", "dairy", but(VGN, LAC, LS)],
      ["Coleslaw", "Cabbage", "vegetable", but(VGN, LF)],
    ],
    dessert: [
      ["Baked cinnamon apples", "Apples", "fruit", ALL],
      ["Chilled fruit cup", "Mixed fruit", "fruit", but(RNL)],
      ["Apple crisp", "Apples", "fruit", but(GF, DM)],
      ["Vanilla pudding", "Milk", "dairy", but(VGN, LAC, DM, LF, RNL)],
      ["Sugar-free gelatin", "Gelatin", "protein", but(VEG, VGN)],
      ["Oatmeal raisin cookie", "Oats", "starch", but(GF, DM, VGN, LAC, LF)],
      ["Sorbet", "Fruit puree", "fruit", but(DM)],
    ],
  },
  breakfast: {
    appetizer: [
      ["Warm applesauce", "Apples", "fruit", ALL],
      ["Chilled pear halves", "Pears", "fruit", ALL],
      ["Chilled fruit cup", "Mixed fruit", "fruit", but(RNL)],
      ["Half grapefruit", "Grapefruit", "fruit", but(RNL)],
    ],
    // A morning soup is a light broth. Falling through to the standing repertoire put beef barley
    // soup on a breakfast tray, which is the daypart bug in a different costume.
    soup: [
      ["Vegetable broth", "Mixed vegetables", "vegetable", ALL],
      ["Rice congee", "White rice", "starch", ALL],
      ["Miso soup", "Miso", "protein", but(LS, RNL)],
      ["Egg drop soup", "Egg", "protein", but(VGN)],
      ["Chicken broth", "Chicken", "protein", but(VEG, VGN, LS, RNL)],
    ],
    salad: [
      ["Apple and pear cup", "Apples", "fruit", ALL],
      ["Fresh fruit salad", "Mixed fruit", "fruit", but(RNL)],
      ["Cottage cheese and pineapple", "Cottage cheese", "dairy", but(VGN, LAC)],
    ],
    starch: [
      ["Hot oatmeal", "Rolled oats", "starch", ALL],
      ["English muffin", "Wheat muffin", "starch", but(GF)],
      ["Buttered toast", "White bread", "starch", but(GF, VGN, LAC, LF)],
      ["Cheese grits", "Grits", "starch", but(VGN, LAC, LF)],
      ["Hash brown potatoes", "Potatoes", "starch", but(RNL, LF)],
      ["Buttermilk pancakes", "Pancake batter", "starch", but(GF, VGN, LAC, DM)],
      ["Cream of wheat", "Farina", "starch", but(GF, VGN, LAC)],
    ],
    vegetable: [
      ["Stewed tomatoes", "Tomato", "vegetable", ALL],
      ["Sauteed breakfast peppers", "Peppers", "vegetable", ALL],
      ["Sauteed mushrooms", "Mushroom", "vegetable", but(LF)],
    ],
    side: [
      ["Orange wedges", "Orange", "fruit", but(RNL)],
      ["Sliced bananas", "Banana", "fruit", but(RNL)],
      ["Vanilla yogurt", "Yogurt", "dairy", but(VGN, LAC, RNL)],
      ["Turkey sausage link", "Turkey", "protein", but(VEG, VGN, LS, LF, RNL)],
    ],
    dessert: [
      ["Cinnamon baked apples", "Apples", "fruit", ALL],
      ["Fresh berries", "Berries", "fruit", ALL],
      ["Fruit sorbet", "Fruit puree", "fruit", but(DM)],
      ["Blueberry muffin", "Wheat muffin", "starch", but(GF, VGN, DM, LAC)],
    ],
  },
};

// Candidates for this kind AT THIS DAYPART, narrowed to the ones the diet admits. A kind breakfast
// does not normally offer (soup) falls through to the standing repertoire.
function dishesFor(kind, meal, dietKey) {
  const daypart = isBreakfast(meal) ? COURSE_DISHES.breakfast : COURSE_DISHES.main;
  const set = daypart[kind] || COURSE_DISHES.main[kind] || [];
  const fit = set.filter((d) => d[3].includes(dietKey));
  // A diet no dish declares gets the all-diet dishes only — never the unfiltered set, which is
  // exactly the bug this layer exists to prevent. An empty result means no row, not a random one.
  return fit.length ? fit : set.filter((d) => d[3] === ALL);
}

// A SAUCE is not a dish you draw at random — it exists RELATIVE to what it is served with, so each
// plate sauce names the entrées it belongs to. When the slot's entrée matches none, the tray gets no
// sauce at all rather than the hash's next candidate (which is how tartar sauce reached a beef stew).
// Sides that are not plate sauces (a fruit side, margarine, table syrup) stand on their own.
const SAUCE_FOR = {
  "Gravy": /roast|meatloaf|schnitzel|loin|brisket|patty|hash/i,
  "Tartar sauce": /cod|tilapia|salmon|fish|lox|cakes/i,
  "Cranberry sauce": /turkey|roast chicken/i,
  "Sour cream": /potato|hash|chili|burrito|taco|shakshuka/i,
  "Ranch dressing": /salad|wrap|kebab/i,
};

// The beverage service is DAYPART-SHAPED: juice belongs at breakfast, and dinner offers a glass of
// wine or a beer. Serving the same seven drinks at every meal is what a vending machine does, not a
// kitchen. Order matters — a count of 2 takes the first two, so the daypart's characteristic drinks
// lead. `standing` is what every service carries regardless.
const BEVERAGES_BY_DAYPART = {
  breakfast: ["Orange juice", "Apple juice", "Coffee", "Decaf coffee", "Hot tea", "Low-fat milk", "Water"],
  dinner:    ["Red wine", "Beer", "Iced tea", "Coffee", "Decaf coffee", "Low-fat milk", "Water"],
  main:      ["Coffee", "Decaf coffee", "Hot tea", "Iced tea", "Low-fat milk", "Apple juice", "Water"],
};
const beveragesFor = (meal) =>
  isBreakfast(meal) ? BEVERAGES_BY_DAYPART.breakfast
  : /dinner|supper/i.test(String(meal)) ? BEVERAGES_BY_DAYPART.dinner
  : BEVERAGES_BY_DAYPART.main;
// Alcohol is a physician-order item on a clinical tray: it is not offered on the therapeutic diets
// that control sugar, sodium or fluid, and never on a diet that forbids it outright.
const ALCOHOL = new Set(["Red wine", "Beer"]);
const ALCOHOL_DIETS = ["standard", "vegetarian", "low-fat", "lactose-free", "gluten-free"];
// A diet cannot DROP a position from that minimum set, so it substitutes: cow's milk is not vegan
// and orange juice carries the potassium a renal tray is counting.
const BEVERAGE_SWAPS = {
  vegan: { "Low-fat milk": "Soy milk" },
  "lactose-free": { "Low-fat milk": "Lactose-free milk" },
  renal: { "Low-fat milk": "Rice milk", "Orange juice": "Cranberry juice" },
};
// A drink DECLARES its diets off that same swap table: the standing drink serves every diet that
// does not swap it out, and a swapped-in drink serves exactly the diets that asked for it.
function beverageRow(i, dietKey, meal) {
  // Drop what this unit's diet cannot have BEFORE indexing — a diabetic tray must not carry a wine
  // row it can never be served. Filtering (rather than skipping from i) also keeps repeated drink
  // positions distinct: skipping landed two positions on the same fallback.
  const list = beveragesFor(meal).filter((name) => !ALCOHOL.has(name) || ALCOHOL_DIETS.includes(dietKey));
  const base = list[i % list.length];
  const swap = (BEVERAGE_SWAPS[dietKey] || {})[base];
  // Alcohol declares its own (short) diet list rather than the swap table's — no substitute stands
  // in for a glass of wine, so a diet that cannot have it simply is not served it.
  const diets = ALCOHOL.has(base)
    ? ALCOHOL_DIETS.filter((k) => DIET_KEYS.includes(k))
    : swap
      ? DIET_KEYS.filter((k) => (BEVERAGE_SWAPS[k] || {})[base] === swap)
      : DIET_KEYS.filter((k) => !(BEVERAGE_SWAPS[k] || {})[base]);
  return { cells: [swap || base, "", "", "", ""], diets, cookedIn: [[swap || base, "beverage"]] };
}

// Which of the four component columns a category owns. Sauces, dairy and drinks own none — the
// table has no column for them, so they report through the dish name alone.
const DISH_COLUMN = { protein: 0, starch: 1, vegetable: 2, fruit: 3 };

// One course position → its own dish row: { cells: [dish, protein, starch, vegetable, fruit], diets },
// only the column this dish actually occupies filled. Repeats of a kind are offset by their
// occurrence index, so a two-side service is two DIFFERENT dishes and not one ingredient spelled
// twice. `entree` is the slot's entrée name — the dish a sauce would be served WITH. Null when the
// diet admits no dish at this position: no row beats a wrong one.
// `taken` is the dish names already placed in THIS slot. The position pools overlap — `Coleslaw` is
// both a salad and a side, `Dinner roll` both a starch and a side — so without it one tray offered
// the same dish at two positions (44 slots across 9 diets × 3 dayparts × 14 days), and a position
// asked for more dishes than its pool holds repeated one. A short tray beats a doubled dish, so an
// exhausted pool returns null rather than a repeat.
function courseRow(kind, meal, dietKey, seed, i = 0, entree = "", taken = new Set()) {
  if (kind === "beverage") return beverageRow(i, dietKey, meal);
  const list = dishesFor(kind, meal, dietKey).filter(([n]) => !taken.has(n));
  // The first side position carries the entrée's sauce when one suits it; the rest never do, so a
  // tray gets at most the one sauce that belongs on it.
  const sauces = kind === "side" && i === 0 ? list.filter(([n]) => SAUCE_FOR[n]?.test(entree)) : [];
  const plain = kind === "side" ? list.filter(([n]) => !SAUCE_FOR[n]) : list;
  const pool = sauces.length ? sauces : plain;
  if (!pool.length) return null;
  const [name, ingredient, category, diets] = pool[(fnv1a(seed) + i) % pool.length];
  const cells = ["", "", "", ""];
  const col = DISH_COLUMN[category];
  if (col != null) cells[col] = ingredient;
  // Components is the row's ONLY ingredient carrier now that the four positional columns are gone,
  // and an empty one is a Fail criterion the fakes must not emit.
  return { cells: [name, ...cells], diets, cookedIn: ingredient ? [[ingredient, category]] : [] };
}

// One diet's menu slice (this fanout unit) — the dish layer on the protein backbone, ONE ROW PER
// COURSE POSITION. Emits ROW_HEADER honouring THIS unit's diet, mealtimes, and day count
// (payload.item / payload.ctx).
// Each slot's entrée is seeded FROM the proteins grid's assigned protein for that day·mealtime
// (payload.ctx.proteins) so recipes MIRROR the grid; the grid protein drives the dish + sides
// (matched pool row, else the rotation). No grid protein for a slot → the diet-pool rotation.
function cannedRecipes(payload = {}) {
  return cannedSlotRows(payload, (kind) => kind === "entree");
}

// Accompanying courses — every position for the slot EXCEPT the entrée, which `recipes` already
// wrote. Split across two generators because the real pipeline splits it across two steps: recipes
// decides the entrée from the protein input, courses decides what goes beside it from the plan's
// flavor profile. One generator emitting everything would not exercise that seam.
function cannedCourses(payload = {}) {
  return cannedSlotRows(payload, (kind) => kind !== "entree");
}

// The row every dish-writing step emits. The four positional columns (Protein | Starch | Vegetable |
// Fruit) are gone: measured over 94 model-written rows they were filled 9–49% of the time, repeated
// what Components already said when filled, and were the source of every wrong-width row (27%) and
// every `name:category`-in-the-wrong-column defect. Components carries the ingredients, and the
// consumer (yeschef recipeShared.ts buildRecipeInputsFromRuns) skips any positional column absent
// from the header and lets Components win per category, so nothing downstream loses data.
const ROW_HEADER = "Day | Mealtime | Dish | Kind | Diets | Components";
const componentsCell = (row) =>
  (row.cookedIn || []).map(([ingredient, category]) => `${ingredient}:${category}`).join("; ");

function cannedSlotRows(payload = {}, keep = () => true) {
  const ctx = payload.ctx || {};
  const meals = Array.isArray(ctx.meals) && ctx.meals.length ? ctx.meals : ["breakfast", "lunch", "dinner"];
  const days = Math.max(1, Number(ctx.days) || 7);
  // Day-fanout: payload.item is a {diet, day} slot → emit ONLY that day. Legacy per-diet fanout:
  // item is a diet string → emit all days. Absolute day number drives the pool rotation either way.
  const item = payload.item;
  const diet = item && typeof item === "object" ? item.diet : item;
  const onlyDay = item && typeof item === "object" && item.day != null ? Number(item.day) : null;
  const dayList = onlyDay != null ? [onlyDay] : Array.from({ length: days }, (_, i) => i + 1);
  const dietKey = dietKeyFor(diet);
  const gridProteins = slotProteinsFor(ctx, diet);
  // No `Course` column: it was the printed name of the position, which is derivable from Kind — two
  // columns carrying the same word. Kind is the :CourseType slug the parser and the graph both use;
  // the printed label is the frontend's business (COURSE_LABEL in recipeShared.ts). `Diets` is
  // APPENDED last, so index-based readers of the original eight columns are unaffected.
  const lines = [ROW_HEADER];
  for (const d of dayList) {
    for (let m = 0; m < meals.length; m++) {
      const meal = meals[m];
      // The entrée is the ONE row still drawn from a pool row: it is the dish the grid's protein
      // names. AN ENTRÉE IS ONE DISH — it carries its protein and nothing else. It used to carry the
      // pool row's starch/vegetable/fruit too, which put a second starch on any tray that also
      // served a starch course (`Beef stew | Egg noodles` beside `Herbed couscous`). Those positions
      // are dishes of their own now, and each one says so.
      const pool = entreePoolFor(diet, meal);
      const rowAt = (i) => pool[(d * meals.length + m + i) % pool.length];
      const gridSlot = gridProteins && gridProteins[d] && gridProteins[d][meal];
      // Each entrée POSITION gets its own dish, so a service configured for two entrées serves two.
      // Only the first follows the grid's assigned protein — that is the slot's protein backbone.
      // Components is where the protein is stated now that the Protein column is gone — a pool row's
      // cookedIn lists what is cooked WITH the protein, not the protein itself, so it goes in front.
      const withProtein = (protein, cookedIn = []) =>
        cookedIn.some(([, c]) => c === "protein") ? cookedIn : [[protein, "protein"], ...cookedIn];
      const entreeAt = (i) => {
        const fallback = rowAt(i);
        if (i > 0 || !(gridSlot && gridSlot.type)) {
          return { cells: [fallback[0], fallback[1], "", "", ""], diets: fallback[3], cookedIn: withProtein(fallback[1], fallback[2]) };
        }
        const protein = gridSlot.type;
        const match = poolRowForProtein(pool, protein);
        // A protein no pool dish names gets a plate of its own; the only diet we can honestly claim
        // for it is the one this unit was built for.
        return match ? { cells: [match[0], protein, "", "", ""], diets: match[3], cookedIn: withProtein(protein, match[2]) }
                     : { cells: [`${protein} plate`, protein, "", "", ""], diets: [dietKey], cookedIn: [[protein, "protein"]] };
      };
      // One tray = one slot. Names placed here are off the table for its other positions, whether or
      // not this generator is the one that emits them: `keep` filters the OUTPUT, so the entrée the
      // courses generator does not emit still occupies its dish name on that tray.
      const taken = new Set();
      for (const [, kind, idx] of coursePositions(ctx, meal)) {
        const i = idx ?? 0;
        const row = kind === "entree"
          ? entreeAt(i)
          : courseRow(kind, meal, dietKey, `${dietKey}:${d}:${meal}:${kind}`, i, entreeAt(0).cells[0], taken);
        if (row) taken.add(row.cells[0]);
        if (!keep(kind)) continue;
        if (!row) continue;
        lines.push([`Day ${d}`, meal, row.cells[0], kind, row.diets.join(", "), componentsCell(row)].join(" | "));
      }
    }
  }
  return lines.join("\n");
}

// ── The recipe DETAIL, one dish per unit ────────────────────────────────────────────────────────
// The detail step fans over the ROWS the recipes/courses steps wrote (dispatch.js `rowsOf`), so a fake
// unit is handed its own row as payload.item — the dish's name, kind, declared diets and ingredients.
// The detail is written FROM that row: a fake side and a fake entrée are different dishes and must not
// come back as the same block. Emits the one-fact-per-line form the `Recipe Detail system` prompt
// specifies (prompt_library), because ONE parser reads both paths (recipeShared.ts
// parseRecipeDetails) and ONE contract judges them (recipeTemplate.js validateRecipe).

// The row's four positional columns and the category each one owns.
const CELL_CATEGORY = { protein: "protein", starch: "starch", vegetable: "vegetable", fruit: "fruit" };
// The commodity a dish is built on when its row names none — a drink and a dairy side occupy no
// positional column, so the row can arrive with every ingredient cell blank.
const KIND_CATEGORY = {
  entree: "protein", soup: "vegetable", salad: "vegetable", starch: "starch",
  vegetable: "vegetable", side: "vegetable", dessert: "fruit", appetizer: "vegetable", beverage: "beverage",
};
// WHOLE-BATCH amounts at a yield of 50, by category, scaled by how much of the tray the course is.
// Fake numbers, but a batch a kitchen would recognise: a case of beef for the entrée, not for the
// garnish.
const BATCH_AT_50 = {
  protein: [18, "lb"], starch: [8, "lb"], vegetable: [10, "lb"], fruit: [10, "lb"],
  dairy: [6, "lb"], fat: [8, "fl oz"], beverage: [3, "gal"],
};
const BATCH_SCALE = {
  entree: 1, soup: 0.8, starch: 0.7, vegetable: 0.7, salad: 0.6, side: 0.5,
  dessert: 0.5, appetizer: 0.4, beverage: 1,
};
const PREP_BY_CATEGORY = {
  protein: "trimmed and cut 1 inch", starch: "rinsed", vegetable: "washed and cut",
  fruit: "washed and cut", dairy: "chilled", fat: "none", beverage: "chilled",
};
const PORTION_BY_KIND = {
  entree: "6 oz (No. 6 scoop)", soup: "8 fl oz (6 oz ladle)", salad: "4 oz (No. 8 scoop)",
  starch: "4 oz (No. 8 scoop)", vegetable: "3 oz (No. 10 scoop)", side: "4 oz (No. 8 scoop)",
  dessert: "4 oz (No. 8 scoop)", appetizer: "3 oz (No. 10 scoop)", beverage: "8 fl oz (1 cup)",
};
// A hot course is cooked and hot-held (135); everything else is chilled and cold-held (41).
const HOT_KINDS = ["entree", "soup", "starch", "vegetable"];

const cellOf = (row, key) => {
  const k = Object.keys(row || {}).find((x) => String(x).trim().toLowerCase() === key);
  return k ? String(row[k] ?? "").trim() : "";
};

// `Ingredient:category; Ingredient:category` — the Components syntax, honoured inside a positional
// column too (a model routinely copies the tag there). An untagged cell keeps the column's own
// category; in the Components cell there is no column, so an untagged part is dropped — exactly what
// the frontend's parseComponentCell does.
function pairsFrom(cell, fallback) {
  return String(cell || "").split(";")
    .map((part) => {
      const [ingredient, cat] = part.split(":").map((s) => s.trim());
      const category = String(cat || "").toLowerCase();
      return [ingredient, COMPONENT_CATEGORIES.includes(category) ? category : fallback];
    })
    .filter(([ingredient, category]) => ingredient && category);
}

// What the catalogues in this file already know a dish is made of — the fallback for a row whose
// ingredient cells are blank (a dairy side and every beverage occupy no column). Derived from the
// dish, never invented: the same tuple the naming step drew the dish from.
function catalogueIngredients(name) {
  const n = String(name || "").toLowerCase();
  for (const [dish, protein, cookedIn] of [...MAIN_ENTREES, ...BREAKFAST_ENTREES]) {
    if (dish.toLowerCase() === n) return [[protein, "protein"], ...cookedIn];
  }
  for (const daypart of Object.values(COURSE_DISHES)) {
    for (const set of Object.values(daypart)) {
      for (const [dish, ingredient, category] of set) if (dish.toLowerCase() === n) return [[ingredient, category]];
    }
  }
  return [];
}

// The row's own ingredients, columns first (the dish's headline commodity) then its Components,
// each ingredient once.
function rowIngredients(row) {
  const out = [];
  const add = (pairs) => {
    for (const [ingredient, category] of pairs) {
      if (!out.some(([i]) => i.toLowerCase() === ingredient.toLowerCase())) out.push([ingredient, category]);
    }
  };
  for (const [key, category] of Object.entries(CELL_CATEGORY)) add(pairsFrom(cellOf(row, key), category));
  add(pairsFrom(cellOf(row, "components"), null));
  return out;
}

// Five steps, in the order a cook does them: prep, hold, service, portion. The last step portions,
// and every step that cooks, chills or holds carries the temperature that controls it.
function bodySteps(name, kind, components, portion) {
  const list = components.map(([ingredient]) => ingredient).join(", ");
  const primary = components[0][0];
  const cookTempF = components.some(([, c]) => c === "protein") ? 165 : 145;
  return HOT_KINDS.includes(kind) ? [
    ["make_ahead", 20, "-", `Trim and portion the ${list} for ${name}.`],
    ["make_ahead", "-", 41, `Hold the prepped ${primary} under refrigeration at 41 degrees.`],
    ["on_line", 45, cookTempF, `Cook the ${primary} in a steam-jacketed kettle until it reaches ${cookTempF} degrees.`],
    ["on_line", "-", 135, "Hold for hot service at 135 degrees or above and log the temperature every 30 minutes."],
    ["on_line", "-", "-", `Portion ${portion} of ${name}.`],
  ] : [
    ["make_ahead", 20, "-", `Prep and measure the ${list} for ${name}.`],
    ["make_ahead", 30, 41, `Chill the prepared ${name} to 41 degrees.`],
    ["make_ahead", "-", 41, "Hold under refrigeration at 41 degrees until service."],
    ["on_line", 10, "-", `Set the chilled ${name} on the service line.`],
    ["on_line", "-", "-", `Portion ${portion} of ${name}.`],
  ];
}

function cannedRecipeDetail(payload = {}) {
  const row = payload.item && typeof payload.item === "object" ? payload.item : {};
  // No row at all (the step dispatched without a fan-out) still owes a real block, not a stub.
  const name = cellOf(row, "dish") || MAIN_ENTREES[0][0];
  const kind = (cellOf(row, "kind") || "entree").toLowerCase();
  const ingredients = rowIngredients(row);
  const seasonings = ingredients.filter(([, c]) => c === "seasoning");
  // Salt, garlic and spices are seasonings, never components — salt hidden among the components is
  // invisible to a low-sodium review.
  let components = ingredients.filter(([, c]) => c !== "seasoning");
  if (!components.length) components = catalogueIngredients(name).filter(([, c]) => c !== "seasoning");
  if (!components.length) components = [[name, KIND_CATEGORY[kind] || "vegetable"]];

  const portion = PORTION_BY_KIND[kind] || PORTION_BY_KIND.side;
  const scale = BATCH_SCALE[kind] ?? 0.5;
  const lines = [`DISH: ${name}`, "YIELD: 50", `PORTION: ${portion}`];
  for (const [ingredient, category] of components) {
    const [base, unit] = BATCH_AT_50[category] || BATCH_AT_50.vegetable;
    const quantity = Math.max(0.5, Math.round(base * scale * 10) / 10);
    lines.push(`COMPONENT: ${ingredient} | ${category} | ${quantity} | ${unit} | ${PREP_BY_CATEGORY[category] || "none"}`);
  }
  for (const [ingredient] of seasonings) lines.push(`SEASONING: ${ingredient} | 1 | oz`);
  for (const [phase, timeMin, tempF, text] of bodySteps(name, kind, components, portion)) {
    lines.push(`STEP: ${phase} | ${timeMin} | ${tempF} | ${text}`);
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

// ONE chart spec for ONE typed question — the analytics ask box (yeschef /analytics). Emits the
// exact contract in worker/analyticsWidget.js, byte for byte, so the app's parser reads the fake
// and the real answer identically. A question that names none of the metrics we hold gets the
// refusal line, exactly as the prompt tells the model to answer: the panel must be able to say
// "I can't answer that" rather than draw an unrelated chart.
const WIDGET_RULES = [
  { re: /take[ -]?rate|uptake|acceptance/i, metric: "takeRate", kind: "line" },
  { re: /diet|renal|pureed|plant|allergen/i, metric: "dietBreakdown", kind: "donut" },
  { re: /ingredient|lbs|pound|produce/i, metric: "ingredientsLbs", kind: "bar" },
  { re: /meal|served|cover|breakfast|lunch|dinner/i, metric: "mealsServed", kind: "stack" },
];

function cannedAnalyticsWidget(payload = {}) {
  const q = String(payload?.query || "").trim();
  const hit = WIDGET_RULES.find((r) => r.re.test(q));
  if (!hit) return WIDGET_REFUSAL;
  const title = q.length > 60 ? `${q.slice(0, 59)}…` : q || "Kitchen figures";
  return ["```yaml", `title: ${title}`, `metric: ${hit.metric}`, `kind: ${hit.kind}`, "```"].join("\n");
}

const BY_SUBTYPE = {
  analytics_widget: cannedAnalyticsWidget,
  planner:      cannedPlanner,
  compliance:   cannedCompliance,
  menu_plan:    cannedMenuPlan,
  recipe:       cannedRecipe,
  protein_grid: cannedProteinGrid,
  recipes:      cannedRecipes,
  courses:      cannedCourses,
  recipe_detail:  cannedRecipeDetail,
  // "Ask Remy, replace this dish" answers in the recipe-detail format (one DISH block, read by
  // parseReplacementDish), so the detail fake IS the fake: with no fan-out row it emits the
  // catalogue entrée. A generic stub here would reach the panel unparseable.
  replace_dish:   cannedRecipeDetail,
  nutrients:    cannedNutrients,
  protein_dietary_categorization: cannedProteinCategories,
};

export function cannedResponse(subtype, payload = {}) {
  const fn = BY_SUBTYPE[subtype];
  if (fn) return fn(payload);
  // Unknown subtype → a generic, success-shaped stub.
  return `Canned ${subtype || "step"} response.`;
}
