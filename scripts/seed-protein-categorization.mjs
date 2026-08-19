// One-off seed: the PROTEIN CATEGORIZATION step + its prompts. This step produces the raw protein
// list the chef weights on /plans/create (Section 9 "Proteins"), so without it that section stays
// empty and the whole protein-weights feature silently does nothing.
//
// It was originally created by direct Mongo writes, which meant it existed ONLY in live and a fresh
// environment had no way to get it. That is what this script fixes.
//
// Idempotent (upsert by name). BACKS UP plan_library + prompt_library to scripts/backups/ first.
//
//   node scripts/seed-protein-categorization.mjs [--dry]
//
// ORDER "@" IS LOAD-BEARING AND MUST NOT CHANGE: it sorts before "A" (protein_grid) and "B" (recipes),
// so this step composes FIRST. Consequence every caller must respect — the orchestrator only drops a
// step on an EXPLICIT false, so any build that omits `protein_dietary_categorization` from its
// `enabled` map silently gains this step, and its `Protein | Diets | Why` table gets parsed by
// whatever that build expects (the protein grid read it positionally as [day, mealtime, type, cut] and
// rendered phantom DIETS/Why rows). See PROTEIN_GRID_ENABLED / ENABLED_BY_STEP in
// yeschef/src/query/hooks/llm.ts.
import { MongoClient } from "mongodb";
import dotenvFlow from "dotenv-flow";
import fs from "node:fs";
import path from "node:path";

dotenvFlow.config({ node_env: "dev" });
const DRY = process.argv.includes("--dry");
const uri = process.env.MONGO_URI;
const dbName = process.env.MONGO_DB || "yeschef";
if (!uri) { console.error("MONGO_URI not set (.env.dev)"); process.exit(1); }

const STEP = {
  "name": "Categorize Proteins By Diet",
  "active": true,
  "context": [],
  "fail": "Fewer than 12 or more than 20 rows; a duplicated protein; a name carrying a cut, form, preparation or dish (\"chicken thigh\", \"ground beef\", \"scrambled egg\", \"beef stew\"); an empty Why; a Why that merely describes the food instead of naming what decided it; a Diets value outside {{join diets \", \"}}; a diet left with no protein; every protein tagged with every diet; or output that is not the pipe-delimited rows. Or a protein the chef added is missing from the output.",
  "includeInOutput": true,
  "inputs": [
    "diets"
  ],
  "instruction": "Propose the RAW PROTEINS this kitchen should rotate through for these diets: {{join diets \", \"}}.\n\nA raw protein is the ingredient itself — Chicken, Beef, Turkey, Pork, Cod, Salmon, Egg, Greek Yogurt, Tofu, Lentil, Black Bean. Name the protein ONLY. Do NOT name a cut, a form, a preparation or a dish: \"Chicken\", never \"chicken thigh\"; \"Beef\", never \"ground beef\"; \"Egg\", never \"scrambled egg\". The cut is chosen later, per meal.\n\nPropose 12 to 20 distinct proteins spanning meat, poultry, seafood, egg, dairy and plant sources so the cycle has real variety. For each, list every diet from {{join diets \", \"}} it is an appropriate routine choice for, and give the reason that decided it — the rule, restriction or nutrient limit that applies. Every diet in {{join diets \", \"}} must be served by at least one protein.\n\nHonor each diet strictly (vegan = no animal products; vegetarian = no meat/poultry/seafood; renal = control phosphorus & potassium; honor no-pork/halal/kosher). Respect the {{costTier}} cost tier and {{region}} regional availability.{{#if addedProteins}}\n\nThe chef has ALSO added these proteins by hand — include EVERY one of them in your output and classify it the same way, even if you would not have proposed it: {{join addedProteins \", \"}}.{{/if}}\n\nOutput ONLY pipe-delimited rows, one per line, with this exact header and columns and nothing else:\nProtein | Diets | Why",
  "kind": "aggregation",
  "mapOf": "",
  "model": "llama3_1_8b_v1",
  "order": "@",
  "pass": "Between 12 and 20 rows, each a DISTINCT raw protein named as the bare ingredient with no cut, form, preparation or dish word; every row has a non-empty Why naming the rule, restriction or nutrient limit that decided it; Diets names only diets drawn from {{join diets \", \"}}; every diet in {{join diets \", \"}} appears in at least one row; and the output is the pipe-delimited rows with no prose. Every protein the chef added is present in the output.",
  "requiredFlags": [],
  "style": "structured",
  "subtype": "protein_dietary_categorization"
};

const PROMPTS = [
  {
    "mapping": {
      "protein_dietary_categorization": "a"
    },
    "active": true,
    "content": "You build the PROTEIN–DIET TABLE of an institutional menu — one row per protein, naming every diet that protein may routinely be served on. You never assign proteins to days or mealtimes, and you never write recipes or methods.\n\nA \"protein\" = a TYPE plus a CUT/form (Beef / chuck, Egg / scrambled, Yogurt / greek, Cod / fillet, Lentil). The domain is wide: all meat & poultry (common and uncommon), seafood, eggs, dairy like yogurt, and plant proteins (legumes, tofu, tempeh, quinoa).\n\nConstraints, in order:\n1. DIET — a protein suits a diet only if the diet permits that kind of food (vegan = no animal products; vegetarian = no meat/poultry/seafood; renal = control phosphorus & potassium; honor no-pork/halal/kosher). Judge the protein as a kitchen serves it normally, not whether an unusual preparation or a tiny portion could make it fit.\n2. COVERAGE — every diet MUST end with at least one suitable protein. If the supplied list leaves a diet with none, ADD a protein that suits it. A diet with no protein is not an acceptable answer.\n3. AVAILABILITY — respect the cost tier and region for anything you add.\n\nOutput ONLY pipe-delimited rows, one per line, with this header and nothing else:\nType | Cut | Diets | Why\nCut is the butcher cut or form; leave it blank when the protein has no meaningful cut.\nWhy states, in a short phrase, what decided the row — the rule, nutrient, or restriction that included or excluded a diet.\n\nExample — supplied proteins: Pork / loin, Pork / ham, Beef / chuck, Beef / liver, Cod / fillet.\nDiets: regular, low-sodium, renal, vegetarian. Nothing supplied serves vegetarian, so one is added.\n\nType | Cut | Diets | Why\nPork | loin | regular, low-sodium | fresh cut, no added sodium\nPork | ham | regular | cured, sodium too high for low-sodium\nBeef | chuck | regular, low-sodium | fresh cut; phosphorus too high for renal\nBeef | liver | regular | organ meat, phosphorus far too high for renal\nCod | fillet | regular, low-sodium, renal | lean white fish, low phosphorus and potassium\nTofu | | regular, low-sodium, vegetarian | plant protein, added because nothing supplied serves vegetarian",
    "modelOverride": null,
    "isDeleted": false,
    "name": "Protein Dietary Categorization system"
  },
  {
    "name": "Decision rationale clause",
    "mapping": {
      "recipes": "f",
      "protein_grid": "f",
      "nutrients": "f",
      "protein_dietary_categorization": "f"
    },
    "active": true,
    "content": "* After your deliverable, and BEFORE the status block, record WHY you decided what you decided.\n* Start the block with a line containing exactly `Why:` and nothing else. One line per decision after it.\n* Each line is `<key> — <reason>`, where `<key>` identifies the decision you made and `<reason>` is a short phrase naming the rule, nutrient, restriction, or availability constraint that decided it. State what INCLUDED it, and where something was excluded, what excluded it.\n* NO PIPE CHARACTERS ANYWHERE IN THE WHY BLOCK. A `|` here corrupts the deliverable when it is parsed. Write \"and\" or a comma instead — never `|`.\n* One line per decision, no blank lines inside the block, no headings, no bullets, no numbering.\n* The Why block is NOT part of the deliverable and never wraps it: deliverable first and in full, then `Why:`, then the status block.\n* Record a reason for EVERY decision you made — a decision with no reason recorded is an incomplete response.",
    "modelOverride": null,
    "isDeleted": false
  }
];

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
  const backup = path.join(dir, `protein-categorization-seed-backup-${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify({ plan_library: planLib, prompt_library: promptLib }, null, 2));
  console.log(`backed up plan_library(${planLib.length}) + prompt_library(${promptLib.length}) → ${backup}`);

  if (DRY) {
    console.log(`\n--dry: would upsert plan_library "${STEP.name}" (order ${STEP.order}) + ${PROMPTS.length} prompt(s):`);
    for (const p of PROMPTS) console.log(`  ${p.name} → mapping ${JSON.stringify(p.mapping)}`);
    process.exit(0);
  }

  const s = await db.collection("plan_library").updateOne({ name: STEP.name }, { $set: STEP }, { upsert: true });
  console.log(`plan_library "${STEP.name}": ${s.upsertedCount ? "inserted" : "updated"}`);
  for (const P of PROMPTS) {
    const r = await db.collection("prompt_library").updateOne({ name: P.name }, { $set: P }, { upsert: true });
    console.log(`prompt_library "${P.name}": ${r.upsertedCount ? "inserted" : "updated"}`);
  }
  console.log("done.");
} finally {
  await client.close();
}
