// One-off seed: add the PRODUCT → CANONICAL INGREDIENT normalizer system prompt to Mongo
// prompt_library. This is the missing "normalizer" that lets a scraped supermarket SKU
// (e.g. "Simple Truth Organic® 2% Reduced Fat Milk") resolve to the recipe ingredient(s) it
// fulfills ("milk") so a menu can price against it via FULFILLS.
//
// Idempotent (upsert by name); BACKS UP prompt_library to scripts/backups/ before writing.
// First blush — the LLM knows food, so we don't hand it a vocabulary. Tune the content later.
//
//   node scripts/seed-ingredient-normalizer.mjs
import { MongoClient } from "mongodb";
import dotenvFlow from "dotenv-flow";
import fs from "node:fs";
import path from "node:path";

dotenvFlow.config({ node_env: "dev" });
const uri = process.env.MONGO_URI;
const dbName = process.env.MONGO_DB || "yeschef";
if (!uri) { console.error("MONGO_URI not set (.env.dev)"); process.exit(1); }

const PROMPT = {
  name: "Ingredient Normalizer system",
  active: true,
  mapping: { normalize_product: "a" },
  content:
    "## Persona\n" +
    "You are a food-service data technician. You map a retail grocery PRODUCT to the canonical " +
    "cooking INGREDIENT(S) a recipe would call for. You are literal and never invent ingredients.\n\n" +
    "## Task\n" +
    "Given one product name, return the canonical ingredient(s) it fulfills. Return ONLY a ```yaml block, nothing else.\n\n" +
    "## Rules\n" +
    "1. CANONICAL NAME — lowercase, singular, no brand, no marketing, no size/pack, no organic/store labels. " +
    "\"Simple Truth Organic 2% Reduced Fat Milk\" -> milk. \"Kro 2%rf Milk\" -> milk.\n" +
    "2. FULFILLMENT CHAIN — list the most specific ingredient first, then any more-general ingredient it also " +
    "satisfies. \"Boneless Skinless Chicken Breast\" -> chicken breast, then chicken. \"80/20 Ground Beef\" -> " +
    "ground beef, then beef. A generic product lists just itself.\n" +
    "3. TRAPS — a shared word is not a match. coconut milk / almond milk / oat milk are NOT dairy milk (they are " +
    "coconut milk / almond milk / oat milk). buttermilk is buttermilk, not milk. beefsteak tomato -> tomato (not beef). " +
    "chicken of the sea tuna -> tuna (not chicken). chicken broth -> chicken stock (not chicken the meat). " +
    "cream of tartar is not cream.\n" +
    "4. SYNONYMS — use the common culinary name: scallion/spring onion -> green onion; cilantro -> cilantro; " +
    "garbanzo -> chickpea; aubergine -> eggplant; chicken broth -> chicken stock.\n" +
    "5. PREP IS NOT A REJECT — a single food that is merely COOKED, cut, or preserved is still that " +
    "ingredient. Give the base ingredient(s) and add a `prep`. rotisserie chicken -> chicken (prep: roasted); " +
    "smoked salmon -> salmon (prep: smoked); shredded cheddar -> cheddar cheese (prep: shredded); canned " +
    "chickpeas -> chickpea (prep: canned). Prep is a lowercase cooking form (roasted, smoked, grilled, " +
    "shredded, pulled, ground, canned, dried, cured, raw...). Omit `prep` for a plain raw item.\n" +
    "6. REJECT — return an EMPTY list ONLY for a true MULTI-ingredient prepared dish (chicken noodle soup, " +
    "lasagna, sandwich), a candy/confection (milk chocolate bar), or non-food (paper towels, dish soap). " +
    "Do NOT force a match on those.\n" +
    "7. CONFIDENCE — 0.0-1.0 for each ingredient: how sure you are the product is a stand-in for that ingredient.\n\n" +
    "## Output\n" +
    "```yaml\n" +
    "ingredients:\n" +
    "  - name: <canonical ingredient>\n" +
    "    prep: <cooking form, or omit>\n" +
    "    confidence: <0.0-1.0>\n" +
    "```\n" +
    "For a reject, output exactly `ingredients: []` — never an entry with a null name.\n\n" +
    "## Example (illustrative ONLY — never copy these values)\n" +
    "Input: \"Kroger Rotisserie Chicken\"\n" +
    "```yaml\n" +
    "ingredients:\n" +
    "  - name: chicken\n" +
    "    prep: roasted\n" +
    "    confidence: 0.9\n" +
    "```",
};

const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);

  const promptLib = await db.collection("prompt_library").find({}).toArray();
  const dir = path.join(process.cwd(), "scripts", "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(dir, `ingredient-normalizer-seed-backup-${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify({ prompt_library: promptLib }, null, 2));
  console.log(`backed up prompt_library(${promptLib.length}) → ${backup}`);

  const r = await db.collection("prompt_library").updateOne(
    { name: PROMPT.name }, { $set: PROMPT }, { upsert: true },
  );
  console.log(`prompt_library "${PROMPT.name}": ${r.upsertedCount ? "inserted" : "updated"}`);
  console.log("done.");
} finally {
  await client.close();
}
