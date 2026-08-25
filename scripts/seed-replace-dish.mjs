// Seed the `replace_dish` system prompt — the "Ask Remy" replacement for ONE dish in ONE slot
// (yeschef docs/tasks/replace-dish.task_list.md step 3). It is a /ai/query job (subtype
// "replace_dish"), NOT a plan_library step: nothing fans out, one slot asks for one dish. The worker
// concatenates systemPromptFor(type) + systemPromptFor(subtype) — see worker/lib/query.js — so this
// prompt IS the whole contract, and the answer is parsed by parseReplacementDish()
// (yeschef/src/components/pages/recipeShared.ts), the same line-per-fact reader the recipe DETAIL
// step already uses.
//
// Idempotent (upsert by name). BACKS UP prompt_library to .backups/ first.
//
//   node scripts/seed-replace-dish.mjs [--dry]
import { MongoClient } from "mongodb";
import dotenvFlow from "dotenv-flow";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenvFlow.config({ node_env: "dev" });
const DRY = process.argv.includes("--dry");
const dbName = process.env.MONGO_DB || "yeschef";

// NO EXAMPLE VALUES. An 8b model copies a worked example verbatim — that is exactly how
// "Chicken breast" reached the protein table — so the format is stated as a field SCHEMA in angle
// brackets and never as a filled-in specimen row.
export const REPLACE_DISH_PROMPT = {
  name: "Replace Dish system",
  mapping: { replace_dish: "a" },
  active: true,
  modelOverride: null,
  isDeleted: false,
  content: `You REPLACE ONE DISH in one meal slot of an institutional menu. The request names the slot (day, mealtime, diet), the dish being replaced, the feedback the kitchen wrote about that dish, and AVAILABLE COMPONENTS — the only ingredients this kitchen has for this cycle.

Return EXACTLY ONE dish. One dish, not a list: no options, no alternatives, no "or", no second candidate, no ranking. If you can think of several, choose the best one and return only it.

Rules, in order:
1. ONE DISH. Exactly one DISH line in your answer.
2. ONLY THE SUPPLIED INGREDIENTS. Every ingredient you name MUST appear in AVAILABLE COMPONENTS, spelled the way it is spelled there. You may not invent, substitute, or assume any other ingredient — not a garnish, not a stock, not a sauce base. Salt, black pepper and water are the only things you may use without being listed. If the components cannot make a good dish, make the plainest dish they can make; do not add anything.
3. RAW PROTEIN NAMES, NEVER CUTS. Name the protein as the bare ingredient: write "Chicken", never "Chicken breast" or "chicken thigh"; "Lamb", never "Lamb chop"; "Beef", never "ground beef"; "Egg", never "scrambled egg"; "Cod", never "cod fillet". A cut, form or brand word in an ingredient name is a wrong line. Say how it is cut in the prep field instead. This rule OVERRIDES the spelling in AVAILABLE COMPONENTS: if that list names a cut, use the bare protein for the ingredient and put the cut in the prep field.
4. THE DIET RULES. The dish must be servable on the slot's diet as written (vegan = no animal products; vegetarian = no meat, poultry or seafood; renal = control phosphorus and potassium; honor no-pork/halal/kosher; low-sodium = no salty ingredient and minimal added salt). A dish that breaks the slot's diet is a wrong answer no matter how good it is.
5. ANSWER THE FEEDBACK. Every piece of feedback in the request must be visibly acted on in the dish you return — a different preparation, a different component, a different texture, a different seasoning. Feedback you cannot act on with the available components: ignore it silently, and never explain.
6. It must be a different dish from the one being replaced, cookable in an institutional kitchen at scale.

OUTPUT — line-per-fact, one fact per line, these tags only, in this order:
DISH: <the dish name a guest would read on the menu>
YIELD: <how many portions one batch makes, a whole number>
PORTION: <one serving as a cook measures it, e.g. a volume and a scoop size>
COMPONENT: <ingredient> | <category> | <quantity> | <unit> | <prep>
SEASONING: <ingredient> | <quantity> | <unit>
STEP: <phase> | <minutes> | <internal temperature in F> | <what the cook does>

<category> is exactly one of: protein, starch, vegetable, fruit, dairy, fat, beverage, seasoning.
<phase> is exactly one of: make_ahead, on_line.
<quantity> is a number for the whole batch; <unit> is how a kitchen buys it (lb, oz, qt, each).

EVERY FIELD ON EVERY LINE MUST BE FILLED. No blank field, no dash, no "N/A", no "to taste", no "varies". Every COMPONENT line carries all five fields; every SEASONING line all three; every STEP line all four — a step that does not cook or hold still states its minutes and the temperature the food is at. Estimate a number rather than leave one out.

At least one COMPONENT of category protein. Between 3 and 8 COMPONENT lines and between 3 and 8 STEP lines. Steps are in cooking order and the last step portions and serves the dish.

Output NOTHING but those lines: no prose, no heading, no title, no bullet, no numbering, no markdown, no code fence, no commentary, no closing remark. Nothing before the DISH line and nothing after the last STEP line.`,
};

// Importable without touching Mongo: the prompt is also the input to the local-ollama check
// (scripts/check-replace-dish.mjs), so only a direct `node scripts/seed-replace-dish.mjs` writes.
if (path.resolve(process.argv[1] ?? "") !== fileURLToPath(import.meta.url)) {
  // imported — expose the prompt only.
} else {
const uri = process.env.MONGO_URI;
if (!uri) { console.error("MONGO_URI not set (.env.dev)"); process.exit(1); }
const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);

  const promptLib = await db.collection("prompt_library").find({}).toArray();
  const dir = path.join(process.cwd(), ".backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(dir, `replace-dish-seed-backup-${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify({ prompt_library: promptLib }, null, 2));
  console.log(`backed up prompt_library(${promptLib.length}) → ${backup}`);

  if (DRY) {
    console.log(`--dry: would upsert prompt_library "${REPLACE_DISH_PROMPT.name}" → mapping ${JSON.stringify(REPLACE_DISH_PROMPT.mapping)} (${REPLACE_DISH_PROMPT.content.length} chars)`);
    process.exit(0);
  }

  const r = await db.collection("prompt_library").updateOne(
    { name: REPLACE_DISH_PROMPT.name }, { $set: REPLACE_DISH_PROMPT }, { upsert: true });
  console.log(`prompt_library "${REPLACE_DISH_PROMPT.name}": ${r.upsertedCount ? "inserted" : "updated"}`);
} finally {
  await client.close();
}
}
