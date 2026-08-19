// First-blush runner for the "Ingredient Normalizer system" prompt: loads it from Mongo
// prompt_library (promptFor, same lookup categorize.js uses) and runs sample products through
// the host Ollama, printing product -> canonical ingredient(s). This is the tuning loop —
// edit the prompt (re-seed) and re-run to compare against the corpus.
//
//   node scripts/run-normalizer.mjs
import { MongoClient } from "mongodb";
import dotenvFlow from "dotenv-flow";
import { parseYamlBlock } from "../config/yaml.js";

dotenvFlow.config({ node_env: "dev" });
const uri = process.env.MONGO_URI;
const dbName = process.env.MONGO_DB || "yeschef";
const OLLAMA_HOST = process.env.CATEGORIZE_OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.CATEGORIZE_OLLAMA_MODEL || "llama3.1:8b";
if (!uri) { console.error("MONGO_URI not set (.env.dev)"); process.exit(1); }

// product -> what a correct normalizer should return (for eyeballing the first blush)
const CASES = [
  ["Simple Truth Organic 2% Reduced Fat Milk", "milk"],
  ["Organic Valley Whole Milk", "milk"],
  ["Kroger Boneless Skinless Chicken Breast, 16 oz", "chicken breast, chicken"],
  ["Kroger Chicken Drumsticks", "chicken drumstick, chicken"],
  ["Kroger 80/20 Ground Beef", "ground beef, beef"],
  ["Kroger Coconut Milk", "coconut milk (NOT milk)"],
  ["Kroger Buttermilk", "buttermilk (NOT milk)"],
  ["Beefsteak Tomato", "tomato (NOT beef)"],
  ["Chicken of the Sea Chunk Light Tuna", "tuna (NOT chicken)"],
  ["Swanson Chicken Broth", "chicken stock (NOT chicken)"],
  ["Kroger Garbanzo Beans", "chickpea"],
  ["Roma Tomato", "tomato"],
  ["Kroger Rotisserie Chicken", "chicken (prep roasted)"],
  ["Kroger Smoked Salmon", "salmon (prep smoked)"],
  ["Kroger Shredded Cheddar", "cheddar cheese (prep shredded)"],
  ["Campbell's Chicken Noodle Soup", "[] multi-ingredient dish"],
  ["Hershey's Milk Chocolate Bar", "[] candy"],
  ["Bounty Paper Towels", "[] non-food"],
];

async function promptFor(col, type) {
  const docs = await col.find({ [`mapping.${type}`]: { $ne: null } }).toArray();
  return docs
    .sort((a, b) => String(a.mapping[type]).localeCompare(String(b.mapping[type])))
    .map((p) => p.content).filter(Boolean).join("\n\n");
}

async function ollama(messages) {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: false,
      options: { temperature: 0.1, top_p: 0.9, top_k: 40, repeat_penalty: 1.1 } }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  return (await res.json()).message?.content ?? "";
}

const client = new MongoClient(uri);
try {
  await client.connect();
  const col = client.db(dbName).collection("prompt_library");
  const system = await promptFor(col, "normalize_product");
  if (!system) { console.error("no prompt mapped to normalize_product — run seed first"); process.exit(1); }
  console.log(`prompt loaded (${system.length} chars) · model ${OLLAMA_MODEL}\n`);

  let hits = 0;
  for (const [product, expected] of CASES) {
    let got;
    try {
      const out = await ollama([{ role: "system", content: system }, { role: "user", content: product }]);
      const parsed = parseYamlBlock(out) || {};
      const list = Array.isArray(parsed.ingredients) ? parsed.ingredients : [];
      got = list.length
        ? list.map((i) => `${i.name}${i.prep ? `/${i.prep}` : ""}${i.confidence != null ? `(${i.confidence})` : ""}`).join(", ")
        : "[]";
    } catch (e) { got = `ERROR ${e.message}`; }
    console.log(`• ${product}`);
    console.log(`    expect: ${expected}`);
    console.log(`    got:    ${got}\n`);
  }
} finally {
  await client.close();
}
