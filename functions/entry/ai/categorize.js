// POST /ai/categorize — synchronous ingredient categorization via Ollama streaming.
// Called by the n8n scraper (no Firebase auth). Streams tokens from Ollama, accumulates
// the full YAML, parses, returns it. No Firestore involved.
import http from "node:http";
import https from "node:https";
import { parse as parseYaml } from "yaml";
import { getCollection } from "../../lib/mongo.js";

// Categorize uses the HOST's native Ollama (small/fast model), not the Docker worker's.
const OLLAMA_HOST = process.env.CATEGORIZE_OLLAMA_HOST || process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.CATEGORIZE_OLLAMA_MODEL || "llama3.2:3b";

// FDA FALCPA big-9 — the only allergen values the API returns (model output is normalized to these).
const BIG9 = ["milk", "eggs", "fish", "shellfish", "tree_nuts", "peanuts", "wheat", "soybeans", "sesame"];

// System prompts live in Mongo prompt_library (mapping.<type>), same shape the worker
// uses: docs whose mapping has the type key, joined ascending by the mapping value (lex order).
// Cached per process; refreshed every 60s so dashboard edits apply without a restart.
const promptCache = new Map();
async function promptFor(type) {
  const hit = promptCache.get(type);
  if (hit && Date.now() - hit.at < 60_000) return hit.text;
  const col = await getCollection("prompt_library");
  const docs = await col.find({ [`mapping.${type}`]: { $ne: null } }).toArray();
  const text = docs
    .sort((a, b) => {
      const x = String(a.mapping[type]), y = String(b.mapping[type]);
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .map((p) => p.content)
    .filter(Boolean)
    .map((c) => c.replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1"))
    .join("\n\n");
  promptCache.set(type, { text, at: Date.now() });
  return text;
}

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

  const [system, allergenSystem] = await Promise.all([promptFor("categorize"), promptFor("allergen_check")]);
  if (!system) {
    console.error(`[categorize] no prompt in prompt_library — nothing maps to "categorize"`);
    return reply.code(503).send({ error: `No categorize prompt in prompt_library` });
  }

  const numbered = ingredients.map((r, i) => `${i + 1}. ${r}`).join("\n");
  const userMsg = `Recipe: "${name || "unknown"}"\n\nIngredients:\n${numbered}`;
  console.log(`[categorize] model=${OLLAMA_MODEL} host=${OLLAMA_HOST} recipe="${name}" ingredients=${ingredients.length}`);
  console.log(`[categorize] user message:\n${userMsg}`);

  let raw;
  try {
    raw = await ollamaChat([
      { role: "system", content: system },
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
  let allergens = (Array.isArray(parsed?.allergens) ? parsed.allergens : [])
    .filter((a) => typeof a === "string" && a.trim());

  // Second, allergen-only pass: a small model buries allergens when they trail the
  // categorization output, so a dedicated FALCPA big-9 check gets its own full attention.
  // Union with the first pass; skip silently if no allergen_check prompt is configured.
  if (allergenSystem) {
    try {
      const aRaw = await ollamaChat([
        { role: "system", content: allergenSystem },
        { role: "user", content: userMsg },
      ]);
      const aCleaned = String(aRaw).replace(/^```(?:yaml)?\s*/i, "").replace(/```\s*$/, "").trim();
      console.log(`[categorize] allergen pass raw output for "${name}":\n${aCleaned}`);
      const aParsed = parseYaml(aCleaned);
      const extra = (Array.isArray(aParsed?.allergens) ? aParsed.allergens : [])
        .filter((a) => typeof a === "string" && a.trim());
      // Normalize to the FALCPA enum — the model sometimes annotates ("milk (parmesan)")
      allergens = [...new Set(
        [...allergens, ...extra]
          .map((a) => BIG9.find((b) => a.toLowerCase().includes(b.replace("_", " ")) || a.toLowerCase().includes(b)))
          .filter(Boolean),
      )];
    } catch (e) {
      console.error(`[categorize] allergen pass failed for "${name}" — keeping first-pass allergens:`, e.message);
    }
  }

  console.log(`[categorize] "${name}" → ${components.length} components [${components.map(c => c.category + ':' + c.ingredient).join(', ')}]`);
  console.log(`[categorize] "${name}" → ${seasonings.length} seasonings [${seasonings.map(s => s.ingredient).join(', ')}]`);
  console.log(`[categorize] "${name}" → allergens: [${allergens.join(', ')}]`);
  return { components, seasonings, allergens };
}
