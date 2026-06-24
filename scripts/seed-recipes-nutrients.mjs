// One-off seed: add the `recipes` + `nutrients` plan steps + their system prompts to
// Mongo so the build can compose a one-step recipes/nutrients plan (mirrors the
// protein_grid seed). Idempotent (upsert by name); BACKS UP plan_library +
// prompt_library to scripts/backups/ before writing.
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
  mapOf: "diets as |diet|",            // one unit per diet
  inputs: ["diets", "meals"],
  requiredFlags: [],
  context: [],
  model: "llama3_1_8b_v1",             // overridden to the FAKE topic when fake:true
  style: "structured",
  includeInOutput: true,
  active: true,
  order: "B",                          // after the protein grid (A)
  instruction:
    "For the {{diet}} diet, write ONE reduced recipe per day and mealtime across {{days}} days and these mealtimes: {{join meals \", \"}}. " +
    "A reduced recipe = a dish name plus its four components: protein, starch, vegetable, fruit. Build on the protein backbone. " +
    "Honor the {{diet}} diet strictly (vegan = no animal products; vegetarian = no meat/poultry/seafood; renal = control phosphorus & potassium; honor no-pork/halal/kosher). " +
    "Respect the {{costTier}} cost tier and {{region}} regional/cultural availability. Label days Day 1 through Day {{days}}.\n\n" +
    "Output ONLY pipe-delimited rows, one per line, with this exact header and columns and nothing else:\n" +
    "Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit",
  pass:
    "Every day (1..{{days}}) × mealtime ({{join meals \", \"}}) has exactly one recipe row, all appropriate for the {{diet}} diet, " +
    "in the `Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit` format with no prose.",
  fail:
    "Any missing day/mealtime slot, a component disallowed on the {{diet}} diet, or output that is not the pipe-delimited rows.",
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
    "You write the DISH LAYER of an institutional menu — one reduced recipe per day and mealtime for a single diet, " +
    "built on the protein backbone. You do not write full methods; you name the dish and its four components.\n\n" +
    "A reduced recipe = a DISH plus PROTEIN + STARCH + VEGETABLE + FRUIT.\n\n" +
    "Constraints, in order:\n" +
    "1. DIET — only foods allowed on the given diet (vegan = no animal products; vegetarian = no meat/poultry/seafood; " +
    "renal = control phosphorus & potassium; honor no-pork/halal/kosher).\n" +
    "2. AVAILABILITY — respect the cost tier and region.\n" +
    "3. VARIETY — vary dishes across the cycle.\n\n" +
    "Output ONLY pipe-delimited rows, one per line, with this header and nothing else:\n" +
    "Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit",
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
  const dir = path.join(process.cwd(), "scripts", "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(dir, `recipes-nutrients-seed-backup-${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify({ plan_library: planLib, prompt_library: promptLib }, null, 2));
  console.log(`backed up plan_library(${planLib.length}) + prompt_library(${promptLib.length}) → ${backup}`);

  // ── Idempotent upserts ──
  for (const STEP of [RECIPES_STEP, NUTRIENTS_STEP]) {
    const r = await db.collection("plan_library").updateOne({ name: STEP.name }, { $set: STEP }, { upsert: true });
    console.log(`plan_library step "${STEP.name}": ${r.upsertedCount ? "inserted" : "updated"}`);
  }
  for (const PROMPT of [RECIPES_PROMPT, NUTRIENTS_PROMPT]) {
    const r = await db.collection("prompt_library").updateOne({ name: PROMPT.name }, { $set: PROMPT }, { upsert: true });
    console.log(`prompt_library "${PROMPT.name}": ${r.upsertedCount ? "inserted" : "updated"}`);
  }
  console.log("done.");
} finally {
  await client.close();
}
