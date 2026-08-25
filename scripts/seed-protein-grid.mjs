// One-off seed: add the `protein_grid` plan step + its system prompt to Mongo so the
// build can compose a one-step protein-grid plan. Idempotent (upsert by name) and it
// BACKS UP plan_library + prompt_library to .backups/ before writing.
//
//   node scripts/seed-protein-grid.mjs
import { MongoClient } from "mongodb";
import dotenvFlow from "dotenv-flow";
import fs from "node:fs";
import path from "node:path";

dotenvFlow.config({ node_env: "dev" });
const uri = process.env.MONGO_URI;
const dbName = process.env.MONGO_DB || "yeschef";
if (!uri) { console.error("MONGO_URI not set (.env.dev)"); process.exit(1); }

const STEP = {
  name: "Build Protein Grid",
  subtype: "protein_grid",
  kind: "fanout",
  mapOf: "diets as |diet|",            // one unit per diet
  inputs: ["diets", "meals"],
  requiredFlags: [],
  context: [],
  model: "llama3_1_8b_v1",             // overridden to the FAKE topic when fake:true
  style: "structured",
  includeInOutput: true,
  active: true,
  order: "A",                          // sorts first (only step in a protein-grid build anyway)
  instruction:
    "For the {{diet}} diet, assign ONE protein per day and mealtime across {{days}} days and these mealtimes: {{join meals \", \"}}. " +
    "A protein = a type plus a cut/form (e.g. Beef / chuck, Egg / scrambled, Lentil). Honor the {{diet}} diet strictly " +
    "(vegan = no animal products; vegetarian = no meat/poultry/seafood; renal = control phosphorus & potassium; honor no-pork/halal/kosher). " +
    "Respect the {{costTier}} cost tier and {{region}} regional/cultural availability. Rotate proteins so the same one is not repeated on " +
    "consecutive days for a mealtime. Label days Day 1 through Day {{days}}.\n\n" +
    "Output ONLY pipe-delimited rows, one per line, with this exact header and columns and nothing else:\n" +
    "Day | Mealtime | Type | Cut\nLeave Cut blank when a protein has no meaningful cut.",
  pass:
    "Every day (1..{{days}}) × mealtime ({{join meals \", \"}}) has exactly one protein row, all appropriate for the {{diet}} diet, " +
    "in the `Day | Mealtime | Type | Cut` format with no prose.",
  fail:
    "Any missing day/mealtime slot, a protein disallowed on the {{diet}} diet, or output that is not the pipe-delimited rows.",
};

const PROMPT = {
  name: "Protein Grid system",
  active: true,
  mapping: { protein_grid: "a" },
  content:
    "You assign the PROTEIN BACKBONE of an institutional menu — one protein per day and mealtime for a single diet. " +
    "You never write recipes or methods.\n\n" +
    "A \"protein\" = a TYPE plus a CUT/form (Beef / chuck, Egg / scrambled, Yogurt / greek, Cod / fillet, Lentil). The domain is wide: " +
    "all meat & poultry (common and uncommon), seafood, eggs, dairy like yogurt, and plant proteins (legumes, tofu, tempeh, quinoa).\n\n" +
    "Constraints, in order:\n" +
    "1. DIET — only proteins allowed on the given diet (vegan = no animal products; vegetarian = no meat/poultry/seafood; " +
    "renal = control phosphorus & potassium; honor no-pork/halal/kosher).\n" +
    "2. AVAILABILITY — respect the cost tier and region. Budget favors economical staples; premium allows specialty cuts. " +
    "Honor regional/cultural norms (e.g. no beef in India).\n" +
    "3. VARIETY — rotate proteins across the cycle; avoid the same protein on consecutive days for a mealtime.\n\n" +
    "Output ONLY pipe-delimited rows, one per line, with this header and nothing else:\n" +
    "Day | Mealtime | Type | Cut\nLeave Cut blank when a protein has no meaningful cut.",
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
  const backup = path.join(dir, `protein-grid-seed-backup-${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify({ plan_library: planLib, prompt_library: promptLib }, null, 2));
  console.log(`backed up plan_library(${planLib.length}) + prompt_library(${promptLib.length}) → ${backup}`);

  // ── Idempotent upserts ──
  const r1 = await db.collection("plan_library").updateOne({ name: STEP.name }, { $set: STEP }, { upsert: true });
  console.log(`plan_library step "${STEP.name}": ${r1.upsertedCount ? "inserted" : "updated"}`);
  const r2 = await db.collection("prompt_library").updateOne({ name: PROMPT.name }, { $set: PROMPT }, { upsert: true });
  console.log(`prompt_library "${PROMPT.name}": ${r2.upsertedCount ? "inserted" : "updated"}`);
  console.log("done.");
} finally {
  await client.close();
}
