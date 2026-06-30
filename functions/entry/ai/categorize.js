// POST /ai/categorize — synchronous ingredient categorization via Ollama streaming.
// Called by the n8n scraper (no Firebase auth). Streams tokens from Ollama, accumulates
// the full JSON, returns it. No Firestore involved.
import http from "node:http";
import https from "node:https";
import { parse as parseYaml } from "yaml";

// Categorize uses the HOST's native Ollama (small/fast model), not the Docker worker's.
const OLLAMA_HOST = process.env.CATEGORIZE_OLLAMA_HOST || process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.CATEGORIZE_OLLAMA_MODEL || "llama3.2:3b";

const SYSTEM_PROMPT = `You categorize recipe ingredients for institutional food service. Return ONLY a \`\`\`yaml block. Every ingredient MUST have a category — never leave it blank.

Categories (pick the primary culinary role):
protein=meat/poultry/fish/eggs/tofu/beans/lentils
starch=rice/pasta/bread/potato/oats/quinoa/corn/tortilla
vegetable=onion/garlic/peppers/tomato/broccoli/carrots/mushrooms/celery/greens
fruit=fruits/berries/citrus/applesauce/dried fruit/plantain/mango/avocado
beverage=drinks served to residents
dairy=milk or cream used in cooking/cheese/butter/yogurt/sour cream
fat=oil/margarine/shortening/mayo/salad dressing
seasoning=salt/pepper/spices/herbs/sugar/honey/vinegar/sauces/condiments/stock/broth/flour as thickener

allergens from: milk, eggs, fish, shellfish, tree_nuts, peanuts, wheat, soybeans, sesame
Convert fractions to decimals: 1/2=0.5, 1/4=0.25, 3/4=0.75

Example:
\`\`\`yaml
components:
  - ingredient: chicken breast
    category: protein
    quantity: "2"
    unit: lb
    prep: diced
  - ingredient: olive oil
    category: fat
    quantity: "2"
    unit: tbsp
    prep: null
  - ingredient: garlic
    category: vegetable
    quantity: "3"
    unit: cloves
    prep: minced
  - ingredient: chicken broth
    category: seasoning
    quantity: "1"
    unit: cup
    prep: null
allergens:
  - eggs
\`\`\``;

async function ollamaChat(messages) {
  const body = JSON.stringify({ model: OLLAMA_MODEL, messages, stream: true });
  const url = new URL(`${OLLAMA_HOST}/api/chat`);
  const lib = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Ollama ${res.statusCode}`));
      }
      let buf = "";
      let accumulated = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.done) resolve(accumulated);
            else accumulated += obj.message?.content ?? "";
          } catch { /* partial line */ }
        }
      });
      res.on("end", () => resolve(accumulated));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(600000, () => { req.destroy(); reject(new Error("Ollama timeout")); });
    req.write(body);
    req.end();
  });
}

export async function post(req, reply) {
  const { name, ingredients } = req.body ?? {};
  if (!Array.isArray(ingredients) || !ingredients.length) {
    return reply.code(400).send({ error: "ingredients[] required" });
  }

  const numbered = ingredients.map((r, i) => `${i + 1}. ${r}`).join("\n");

  const userMsg = `Recipe: "${name || "unknown"}"\n\nIngredients:\n${numbered}`;
  console.log(`[categorize] model=${OLLAMA_MODEL} host=${OLLAMA_HOST} recipe="${name}" ingredients=${ingredients.length}`);
  console.log(`[categorize] user message:\n${userMsg}`);

  let raw;
  try {
    raw = await ollamaChat([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMsg },
    ]);
  } catch (e) {
    console.error(`[categorize] Ollama call failed for "${name}" (model=${OLLAMA_MODEL} host=${OLLAMA_HOST}):`, e.message);
    return reply.code(503).send({ error: `LLM unavailable: ${e.message}` });
  }

  // Strip optional ```yaml fence, parse YAML
  const cleaned = String(raw).replace(/^```(?:yaml)?\s*/i, "").replace(/```\s*$/, "").trim();
  console.log(`[categorize] raw output for "${name}":\n${cleaned}`);

  let parsed;
  try {
    parsed = parseYaml(cleaned);
  } catch (e) {
    console.error(`[categorize] YAML parse failed for "${name}": ${e.message}\nRaw:\n${cleaned}`);
    return reply.code(503).send({ error: `Parse failed: ${e.message}` });
  }

  const allItems = Array.isArray(parsed?.components) ? parsed.components : [];
  const components = allItems.filter((c) => c.category !== "seasoning");
  const seasonings = allItems
    .filter((c) => c.category === "seasoning")
    .map((c) => ({ ingredient: c.ingredient, quantity: c.quantity ?? undefined, unit: c.unit ?? undefined }));
  const allergens = Array.isArray(parsed?.allergens) ? parsed.allergens : [];

  console.log(`[categorize] "${name}" → ${components.length} components [${components.map(c => c.category + ':' + c.ingredient).join(', ')}]`);
  console.log(`[categorize] "${name}" → ${seasonings.length} seasonings [${seasonings.map(s => s.ingredient).join(', ')}]`);
  console.log(`[categorize] "${name}" → allergens: [${allergens.join(', ')}]`);
  return { components, seasonings, allergens };
}
