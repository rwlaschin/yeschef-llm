// One-off seed: add the `recipes` + `nutrients` plan steps + their system prompts to
// Mongo so the build can compose a one-step recipes/nutrients plan (mirrors the
// protein_grid seed). Idempotent (upsert by name); BACKS UP plan_library +
// prompt_library to .backups/ before writing.
//
//   node scripts/seed-recipes-nutrients.mjs
import { MongoClient } from "mongodb";
import dotenvFlow from "dotenv-flow";
import fs from "node:fs";
import path from "node:path";

dotenvFlow.config({ node_env: "dev" });
const uri = process.env.MONGO_URI;
const dbName = process.env.MONGO_DB || "yeschef";
if (!uri) { console.error("MONGO_URI not set (.env.dev)"); process.exit(1); }

const RECIPES_STEP = {
  name: "Build Recipes",
  subtype: "recipes",
  kind: "fanout",
  // One unit per (diet, day), diet-major — the frontend derives BOTH the diet and the day from the
  // unit index (dietIndexOf/unitDay in src/components/pages/recipeShared.ts), because units routinely
  // mislabel their own "Day N" column. Reverting this to a per-diet fanout collapses every recipe
  // onto one diet, so it must stay in sync with the live plan_library doc.
  mapOf: "dietDays as |slot|",
  inputs: ["diets", "meals", "preferences"],
  requiredFlags: [],
  context: [],
  model: "llama3_1_8b_v1",             // overridden to the FAKE topic when fake:true
  style: "structured",
  includeInOutput: true,
  active: true,
  order: "B",                          // after the protein grid (A)
  instruction:
    "For DAY {{slot.day}}, write THE ENTRÉE for each of these mealtimes: {{join meals \", \"}}. " +
    "ONE CALL COVERS EVERY DIET: {{join diets \", \"}}. Write the FEWEST dishes that feed all of them — one dish per mealtime " +
    "wherever a single dish satisfies every diet, and an extra row ONLY for a diet that genuinely cannot eat it. Diets share a " +
    "meal by default; a separate dish per diet is the exception you must justify by the diet's own restriction. " +
    "AN ENTRÉE IS ONE DISH: it carries its own PROTEIN and nothing else — the starch, vegetable and fruit columns stay EMPTY on an " +
    "entrée row, because the starch and vegetable positions are dishes of their own written by the next step. Build on the protein backbone. " +
    "Honor every diet strictly (vegan = no animal products; vegetarian = no meat/poultry/seafood; renal = control phosphorus & potassium; honor no-pork/halal/kosher). " +
    "Respect the {{costTier}} cost tier and {{region}} regional/cultural availability. Every row is labelled Day {{slot.day}}.\n\n" +
    "Kind is always `entree` on every row.\n" +
    "Diets is a comma-separated list of the diets this dish satisfies, drawn ONLY from this plan's diets: " +
    "{{join diets \", \"}}. It is the dish's own declaration — nothing downstream can work out who may eat a dish " +
    "except from this column.\n" +
    "The dish name says how it is made — `Braised beef with barley`, not `Beef`. Never a bare ingredient.\n" +
    "Components is THIS DISH'S OWN ingredient list, written as `Ingredient:category; Ingredient:category`, " +
    "with category one of: protein, starch, vegetable, fruit, beverage, dairy, fat, seasoning. " +
    "It is never empty — every dish is made of something. " +
    "List ONLY what is cooked into this dish — a braised beef with barley is `Beef:protein; Barley:starch`. " +
    "NEVER list the dishes plated beside it: the side, the fruit cup and the drink are rows of their own, " +
    "and naming them here turns one dish into a whole meal.\n" +
    "NEVER write the same dish twice under different wording. One dish exists once, on one row, declaring every diet it feeds.\n\n" +
    "CHECK EVERY ROW AGAINST THESE TWO RULES BEFORE YOU WRITE IT:\n" +
    "1. A DIET CLAIM IS A SAFETY CLAIM. Read the dish's own Components, then claim a diet only if every one of " +
    "them is allowed on it. Meat, poultry, seafood or their stocks → NOT vegetarian, NOT vegan. Egg, dairy or " +
    "honey → NOT vegan. Wheat, barley or rye → NOT gluten-free. `Braised beef with barley` is `standard` and " +
    "nothing more. Leaving a diet off is safe; claiming one falsely is not.\n" +
    "2. Protein, Starch, Vegetable and Fruit each hold ONE BARE INGREDIENT NAME — `Beef`, never `Beef:protein`, " +
    "never a semicolon-separated list. The `name:category` form appears in Components and nowhere else.\n\n" +
    "Output ONLY pipe-delimited rows, one per line, with this exact header and columns and nothing else:\n" +
    "Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit | Kind | Diets | Components",
  pass:
    "Every mealtime ({{join meals \", \"}}) on Day {{slot.day}} is fed, every diet in {{join diets \", \"}} appears in some row's Diets list, no two rows name the same dish, " +
    "every row's Components names only ingredients cooked into that dish, each tagged with a category, " +
    "in the `Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit | Kind | Diets | Components` format with no prose, and every Kind is `entree`.",
  fail:
    "A mealtime with no entrée, a diet fed by no row, the same dish written twice, a Kind other than `entree`, " +
    "an empty or uncategorized Components cell, a `name:category` pair written into the Protein/Starch/Vegetable/Fruit columns, " +
    "Components naming an accompaniment that is not part of the dish, " +
    "a component disallowed on a diet the row claims, or output that is not the pipe-delimited rows.",
};

// Runs AFTER Build Recipes and writes every position BESIDE the entrée, chosen for flavor affinity
// with the entrée that step already decided. Split from recipes because the two are different
// decisions: the entrée follows the protein input, the accompaniments follow the plan's flavor
// profile — and a single call cannot be seeded by its own output.
const COURSES_STEP = {
  name: "Build Courses",
  subtype: "courses",
  kind: "fanout",
  // SAME unit shape as recipes ((diet, day)) so dietIndexOf/unitDay resolve its runs unchanged.
  // `chain` would inherit items 1:1 and collapse the fan-out.
  mapOf: "dietDays as |slot|",
  inputs: ["diets", "meals", "preferences"],
  requiredFlags: [],
  // Names the recipes step so pruneOrphans keeps this one and the worker injects that unit's
  // entrée run as `# Result of step N:`.
  context: ["Build Recipes"],
  model: "llama3_1_8b_v1",
  style: "structured",
  includeInOutput: true,
  active: true,
  order: "Ba",                         // between recipes (B) and nutrients (C)
  instruction:
    "The previous step's result gives you the ENTRÉES for Day {{slot.day}}, each declaring the diets it feeds. " +
    "For each of those slots, write the dishes that accompany that entrée — never the entrée itself, which already exists.\n\n" +
    "{{#if pairingMethodology}}Choose each accompaniment for flavor affinity with the entrée using this approach: {{pairingMethodology}}.{{/if}}\n" +
    "{{#if courseList}}This meal offers exactly: {{courseList}}. The ENTRÉE positions in that list are ALREADY " +
    "WRITTEN by the previous step — skip them entirely and never repeat them. Write one row for each of the " +
    "REMAINING, NON-ENTRÉE positions, no more and no fewer.{{else}}" +
    "No course list was given, so write SIDES ONLY — one or two `side` rows per slot. Do not invent soup, salad, " +
    "dessert, drink, appetizer, starch or vegetable positions that were not asked for.{{/if}}\n\n" +
    "EVERY ROW IS A DISH, NEVER A RAW INGREDIENT. The dish name must say how it is prepared: " +
    "`Sliced bananas`, `Orange wedges`, `Steamed green beans`, `Buttered barley` — never `Banana`, `Orange`, " +
    "`Green beans`. A whole unprepared fruit or vegetable is not a dish and is never a valid row.\n" +
    "Use only STANDARD preparations for the ingredient — the prep must suit its texture, colour and flavour. " +
    "Wedges, slices, rounds, batons, steamed, roasted, braised, chilled compote are standard. Do not invent " +
    "odd preparations: no `cucumber mash`, no `pear soup`, nothing a kitchen would not actually serve.\n" +
    "REUSE, DO NOT REGENERATE: if a dish already written for another diet also satisfies this diet, write that " +
    "SAME dish name verbatim. Only write a different dish where the diet genuinely forbids the first one. " +
    "The same dish appearing across several diets is correct and wanted; near-duplicates that differ only in " +
    "wording are a defect.\n\n" +
    "Kind must be one of: side, dessert, drink, appetizer, soup, salad, starch, vegetable. Never `entree`. " +
    "Fill only the component columns the dish actually occupies; leave the others empty. " +
    "Diets is a comma-separated list of the diets the dish satisfies, drawn ONLY from this plan's diets: " +
    "{{join diets \", \"}}. Diets SHARE these dishes: write one row that feeds them all wherever possible, and a " +
    "separate row only where a diet cannot have it. A SAUCE is written only when it belongs with " +
    "that slot's entrée — tartar sauce with fried fish, gravy with a roast. When no sauce suits it, write none. " +
    "Honor every diet strictly and respect the {{costTier}} cost tier and {{region}} availability.\n" +
    "Components is THIS DISH'S OWN ingredient list, written as `Ingredient:category; Ingredient:category`, " +
    "with category one of: protein, starch, vegetable, fruit, beverage, dairy, fat, seasoning. " +
    "It is never empty — every dish is made of something, so `Sliced banana` is `Banana:fruit`. " +
    "`Steamed green beans` is `Green beans:vegetable`; `Buttered barley` is `Barley:starch; Butter:fat`. " +
    "NEVER list the entrée or any other course here — those are rows of their own, and naming them turns " +
    "one dish into a whole meal.\n\n" +
    "CHECK EVERY ROW AGAINST THESE TWO RULES BEFORE YOU WRITE IT:\n" +
    "1. A DIET CLAIM IS A SAFETY CLAIM. Read the dish's own Components, then claim a diet only if every one of " +
    "them is allowed on it. Meat, poultry, seafood or their stocks → NOT vegetarian, NOT vegan. Egg, dairy or " +
    "honey → NOT vegan. Wheat, barley or rye → NOT gluten-free. Leaving a diet off is safe; claiming one " +
    "falsely is not.\n" +
    "2. Protein, Starch, Vegetable and Fruit each hold ONE BARE INGREDIENT NAME — `Green beans`, never " +
    "`Green beans:vegetable`. The `name:category` form appears in Components and nowhere else.\n\n" +
    "Output ONLY pipe-delimited rows, one per line, with this exact header and columns and nothing else:\n" +
    "Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit | Kind | Diets | Components",
  pass:
    "Every slot named by the previous step has at least one accompanying row; no row has Kind `entree`; every Kind is one of " +
    "side, dessert, drink, appetizer, soup, salad, starch, vegetable; every row's Components names only ingredients cooked " +
    "into that dish, each tagged with a category; rows are in the " +
    "`Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit | Kind | Diets | Components` format with no prose.",
  fail:
    "Any row repeating the entrée, any Kind of `entree` or outside the allowed list, a slot from the previous step left with no row, " +
    "an empty or uncategorized Components cell, a `name:category` pair written into the Protein/Starch/Vegetable/Fruit columns, " +
    "Components naming the entrée or another course, " +
    "courses invented for positions no course list asked for, or output that is not the pipe-delimited rows.",
};

const NUTRIENTS_STEP = {
  name: "Build Nutrients",
  subtype: "nutrients",
  kind: "fanout",
  mapOf: "diets as |diet|",
  inputs: ["diets", "meals"],
  requiredFlags: [],
  context: [],
  model: "llama3_1_8b_v1",
  style: "structured",
  includeInOutput: true,
  active: true,
  order: "C",                          // after recipes (B)
  instruction:
    "For the {{diet}} diet, give per-meal nutrient totals for each day and mealtime across {{days}} days and these mealtimes: {{join meals \", \"}}. " +
    "Estimate calories, protein (g), sodium (mg), and carbohydrates (g) for the meal. Keep values appropriate to the {{diet}} diet " +
    "(renal = control sodium & protein; diabetic = moderate carbs). Label days Day 1 through Day {{days}}.\n\n" +
    "Output ONLY pipe-delimited rows, one per line, with this exact header and columns and nothing else:\n" +
    "Day | Mealtime | Calories | Protein g | Sodium mg | Carbs g",
  pass:
    "Every day (1..{{days}}) × mealtime ({{join meals \", \"}}) has exactly one row of numeric totals in the " +
    "`Day | Mealtime | Calories | Protein g | Sodium mg | Carbs g` format with no prose.",
  fail:
    "Any missing day/mealtime slot, non-numeric values, or output that is not the pipe-delimited rows.",
};

const RECIPES_PROMPT = {
  name: "Recipes system",
  active: true,
  mapping: { recipes: "a" },
  content:
    "You write the DISH LAYER of an institutional menu — the ENTRÉE for each day and mealtime, " +
    "built on the protein backbone. You do not write full methods; you name the dish, what it puts on the tray, " +
    "which diets it feeds, and what it is made of.\n\n" +
    "A reduced recipe = a DISH plus the ONE component it is built on: its PROTEIN. The starch, vegetable and fruit columns " +
    "belong to the dishes served beside it, not to the entrée.\n\n" +
    "Constraints, in order:\n" +
    "1. DIET — only foods allowed on the given diet (vegan = no animal products; vegetarian = no meat/poultry/seafood; " +
    "renal = control phosphorus & potassium; honor no-pork/halal/kosher).\n" +
    "2. AVAILABILITY — respect the cost tier and region.\n" +
    "3. VARIETY — vary dishes across the cycle.\n" +
    "4. DIETS IS A SAFETY CLAIM, NOT A COURTESY — the dish states, comma-separated, the diets it satisfies, drawn only " +
    "from the plan's own diets. Read the dish's Components and claim a diet only if every one of them is allowed on " +
    "it: meat/poultry/seafood or their stocks are never vegetarian or vegan; egg, dairy and honey are never vegan; " +
    "wheat, barley and rye are never gluten-free. Nothing downstream can work out who may eat a dish except from this " +
    "column, so an omitted diet costs a serving and a false one harms a resident.\n" +
    "5. COMPONENTS IS THE DISH, NOT THE MEAL — `Ingredient:category; Ingredient:category` over categories protein, " +
    "starch, vegetable, fruit, beverage, dairy, fat, seasoning. Only what is cooked into THIS dish. The side, the " +
    "fruit and the drink beside it are separate dishes; listing them here makes one row claim a whole tray.\n" +
    "6. THE `name:category` FORM BELONGS TO COMPONENTS ALONE — Protein, Starch, Vegetable and Fruit each hold one " +
    "BARE INGREDIENT NAME (`Beef`), never `Beef:protein` and never a list.\n\n" +
    "Output ONLY pipe-delimited rows, one per line, with this header and nothing else:\n" +
    "Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit | Kind | Diets | Components",
};

const COURSES_PROMPT = {
  name: "Courses system",
  active: true,
  mapping: { courses: "a" },
  content:
    "You write the COURSES THAT ACCOMPANY an entrée on an institutional menu. The entrée for every slot is given to " +
    "you; your job is what goes beside it, never the entrée itself.\n\n" +
    "Constraints, in order:\n" +
    "1. DIET — only foods allowed on the given diet (vegan = no animal products; vegetarian = no meat/poultry/seafood; " +
    "renal = control phosphorus & potassium; honor no-pork/halal/kosher). A vegan entrée never grows a dairy dessert.\n" +
    "2. EVERY ROW IS A DISH — the name carries the preparation: `Sliced bananas`, `Orange wedges`, `Steamed green " +
    "beans`. A bare ingredient (`Banana`, `Orange`) is never a dish. Nothing is served whole and unprepared.\n" +
    "3. STANDARD PREPARATIONS ONLY — the prep must suit the ingredient's texture, colour and flavour. No " +
    "`cucumber mash`, no `pear soup`; if a kitchen would not serve it, do not write it.\n" +
    "4. REUSE ACROSS DIETS — a dish that satisfies another diet is written again VERBATIM for this one. Only " +
    "diverge where the diet forbids it. Duplicate-but-reworded dishes are a defect.\n" +
    "5. AFFINITY — each dish is chosen to go WITH its entrée under the given flavor approach.\n" +
    "6. RESTRAINT — when no course list is given, write SIDES ONLY. A plain, correct service beats an invented one.\n" +
    "7. AVAILABILITY — respect the cost tier and region.\n" +
    "8. DIETS IS A SAFETY CLAIM, NOT A COURTESY — the dish states, comma-separated, the diets it satisfies, drawn only " +
    "from the plan's own diets. Read the dish's Components and claim a diet only if every one of them is allowed on " +
    "it: meat/poultry/seafood or their stocks are never vegetarian or vegan; egg, dairy and honey are never vegan; " +
    "wheat, barley and rye are never gluten-free. An omitted diet costs a serving; a false one harms a resident.\n" +
    "9. COMPONENTS IS THE DISH, NOT THE MEAL — `Ingredient:category; Ingredient:category` over categories protein, " +
    "starch, vegetable, fruit, beverage, dairy, fat, seasoning. Only what is cooked into THIS dish: `Steamed green " +
    "beans` is `Green beans:vegetable`. Never empty, never the entrée, never another course.\n" +
    "10. THE `name:category` FORM BELONGS TO COMPONENTS ALONE — Protein, Starch, Vegetable and Fruit each hold one " +
    "BARE INGREDIENT NAME (`Green beans`), never `Green beans:vegetable` and never a list.\n\n" +
    "Kind ∈ {side, dessert, drink, appetizer, soup, salad, starch, vegetable}. Never `entree`.\n\n" +
    "KIND is what the dish IS on the tray, not what it is made of:\n" +
    "- entree — never write this.\n" +
    "- side — a small accompaniment served WITH the main plate: unsweetened cut or whole fruit, a roll or muffin, " +
    "cottage cheese, coleslaw, a fruit cup.\n" +
    "- dessert — a PREPARED SWEET served as the closing course: sweetener or sugar is a defining component (sorbet, " +
    "pudding, cobbler, cake, sweetened baked fruit). Plain fruit and any bread or muffin are NOT desserts, whatever " +
    "they are made of.\n" +
    "- soup / salad / starch / vegetable / drink / appetizer — as named.\n" +
    "A dish whose only component is a fruit or a starch is usually Kind `side`, not `dessert`.\n" +
    "Fill only the component columns the dish occupies; leave the rest empty.\n\n" +
    "Output ONLY pipe-delimited rows, one per line, with this header and nothing else:\n" +
    "Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit | Kind | Diets | Components",
};

const NUTRIENTS_PROMPT = {
  name: "Nutrients system",
  active: true,
  mapping: { nutrients: "a" },
  content:
    "You produce per-meal NUTRITION TOTALS for an institutional menu — one row per day and mealtime for a single diet.\n\n" +
    "For each meal estimate: calories, protein (g), sodium (mg), carbohydrates (g). Values should be realistic for an " +
    "institutional portion and consistent with the diet (renal = control sodium & protein; diabetic = moderate carbs).\n\n" +
    "Output ONLY pipe-delimited rows, one per line, with this header and nothing else:\n" +
    "Day | Mealtime | Calories | Protein g | Sodium mg | Carbs g",
};

const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);

  // ── BACK UP first (unrecoverable otherwise) ──
  const planLib = await db.collection("plan_library").find({}).toArray();
  const promptLib = await db.collection("prompt_library").find({}).toArray();
  const dir = path.join(process.cwd(), ".backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(dir, `recipes-nutrients-seed-backup-${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify({ plan_library: planLib, prompt_library: promptLib }, null, 2));
  console.log(`backed up plan_library(${planLib.length}) + prompt_library(${promptLib.length}) → ${backup}`);

  // ── Idempotent upserts ──
  for (const STEP of [RECIPES_STEP, COURSES_STEP, NUTRIENTS_STEP]) {
    const r = await db.collection("plan_library").updateOne({ name: STEP.name }, { $set: STEP }, { upsert: true });
    console.log(`plan_library step "${STEP.name}": ${r.upsertedCount ? "inserted" : "updated"}`);
  }
  for (const PROMPT of [RECIPES_PROMPT, COURSES_PROMPT, NUTRIENTS_PROMPT]) {
    const r = await db.collection("prompt_library").updateOne({ name: PROMPT.name }, { $set: PROMPT }, { upsert: true });
    console.log(`prompt_library "${PROMPT.name}": ${r.upsertedCount ? "inserted" : "updated"}`);
  }
  console.log("done.");
} finally {
  await client.close();
}
