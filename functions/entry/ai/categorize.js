// POST /ai/categorize — synchronous ingredient categorization via Ollama streaming.
// Called by the n8n scraper (no Firebase auth). Streams tokens from Ollama, accumulates
// the full YAML, parses, returns it. No Firestore involved.
import http from "node:http";
import https from "node:https";
import { parseYamlBlock, extractYamlString } from "../../../config/yaml.js";
import { getCollection } from "../../lib/mongo.js";
import { detectAllergens } from "../../lib/allergenLookup.js";
import { findAllergens, warmAllergenCache } from "../../lib/allergenFdc.js";
import { overrideCategory } from "../../lib/categoryOverride.js";
import { dualRoleFor } from "../../lib/dualRoleLookup.js";

// Categorize uses the HOST's native Ollama (small/fast model), not the Docker worker's.
const OLLAMA_HOST = process.env.CATEGORIZE_OLLAMA_HOST || process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.CATEGORIZE_OLLAMA_MODEL || "llama3.2:3b";

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

// Categorize/cleanup is a text-processing task (extract/transform), not creative generation —
// same "structured" style the worker uses (config/models.js STYLE_TEMPS.structured = 0.1) for
// strict extraction that must not improvise. Full sampler object (not just temperature) so a
// tune here matches the worker's SAMPLER_PARAMS shape and stays forwardable to Ollama as-is.
const SAMPLER = { temperature: 0.1, top_p: 0.9, top_k: 40, repeat_penalty: 1.1 };

async function ollamaChat(messages) {
  // ── DEBUG 1: the tunables this call is running with ──
  console.log(`[categorize] Inference: Ollama chat (model=${OLLAMA_MODEL}, sampler=${JSON.stringify(SAMPLER)})`);
  // ── DEBUG 2: the exact prompt sent (system + user, role-labelled) ──
  const promptDump = messages.map((m) => `--- [${m.role}] (${m.content.length} chars) ---\n${m.content}`).join("\n\n");
  console.log(`[categorize] PROMPT SENT:\n${promptDump}\n[categorize] END PROMPT`);
  const body = JSON.stringify({ model: OLLAMA_MODEL, messages, stream: true, options: SAMPLER });
  const url = new URL(`${OLLAMA_HOST}/api/chat`);
  const lib = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    // ── DEBUG 3: the final output the model produced ── (obj.done AND the stream's own "end"
    // can both fire — guard so this logs/resolves exactly once)
    let settled = false;
    const resolveWithLog = (text) => {
      if (settled) return;
      settled = true;
      console.log(`[categorize] OUTPUT (${text?.length ?? 0} chars):\n${text}\n[categorize] END OUTPUT`);
      resolve(text);
    };
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
            if (obj.done) resolveWithLog(accumulated);
            else accumulated += obj.message?.content ?? "";
          } catch { /* partial line */ }
        }
      });
      res.on("end", () => resolveWithLog(accumulated));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(600000, () => { req.destroy(); reject(new Error("Ollama timeout")); });
    req.write(body);
    req.end();
  });
}

// Retry-with-error-feedback — same pattern the orchestrator uses for step failures
// (functions/entry/ai/dispatch/step.js): on a parse failure, resend the SAME system+user messages
// plus a note naming what was rejected and why, plus a truncated snippet of the bad output, so the
// model can see and fix its own mistake instead of blindly retrying cold. Not specific to categorize —
// used for both the categorize and allergen passes, since both parse LLM-generated YAML.
// Plain-text numbered-list parser for the normalize pre-pass (not YAML — a flat list of cleaned
// lines is a much lower parse-failure surface than nested YAML for a task this narrow). Only lines
// that actually match "N. ..." count as data — a stray non-numbered line (e.g. the model echoing a
// "BEGIN OUTPUT" marker from its own few-shot example onto its real answer) is discarded, not kept
// as an extra item, or it silently inflates the count past expectedCount and fails the whole pass.
function parseNumberedList(raw, expectedCount) {
  const lines = String(raw).split("\n")
    .map((l) => l.match(/^\s*\d+\.\s*(.*)$/))
    .filter(Boolean)
    .map((m) => m[1].trim())
    .filter(Boolean);
  return lines.length === expectedCount ? lines : null;
}

// A pre-pass LLM call that cleans up messy ingredient lines, one numbered list in, one numbered
// list out. Each pass has ONE narrow job — bundling multiple cleanup tasks into a single prompt
// (alternatives + annotations + combined-quantity math, all at once) made the math specifically
// unreliable, because it competed with the other tasks for the same limited attention (confirmed
// by testing, not assumed). Regex/code can't replace an LLM here either: detecting "combined
// amount" phrasing ("plus", "add", "and", "one and one more", or an equivalent phrase in another
// language) is exactly the kind of open-ended natural-language recognition a hardcoded pattern
// list can't cover — the LLM generalizes to phrasings nobody thought to write a regex for.
// Falls back to the input UNCHANGED (never drops/corrupts data) if the pass fails or the returned
// line count doesn't match — every pass here is a cleanup step, not a required gate.
async function llmCleanupPass(promptType, label, name, ingredients) {
  const system = await promptFor(promptType);
  if (!system) return ingredients;
  const numbered = ingredients.map((r, i) => `${i + 1}. ${r}`).join("\n");
  const userMsg = `Recipe: "${name || "unknown"}"\n\nIngredients:\n${numbered}`;
  try {
    const raw = await ollamaChat([
      { role: "system", content: system },
      { role: "user", content: userMsg },
    ]);
    const cleaned = parseNumberedList(raw, ingredients.length);
    if (!cleaned) {
      console.error(`[categorize] ${label} pass for "${name}" returned ${String(raw).split("\n").filter(Boolean).length} lines, expected ${ingredients.length} — keeping prior ingredients`);
      return ingredients;
    }
    console.log(`[categorize] ${label} pass for "${name}":\n${cleaned.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}`);
    return cleaned;
  } catch (e) {
    console.error(`[categorize] ${label} pass failed for "${name}" — keeping prior ingredients:`, e.message);
    return ingredients;
  }
}

async function chatWithYamlRetry(system, userMsg, label, maxAttempts = 3) {
  let lastError = "";
  let lastRaw = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const messages = attempt === 1
      ? [{ role: "system", content: system }, { role: "user", content: userMsg }]
      : [
          { role: "system", content: system },
          { role: "user", content: `${userMsg}\n\nNotes on possible failures: the previous attempt was REJECTED because: ${lastError}. Address that specifically and produce valid YAML.\n\nThe rejected attempt produced:\n${lastRaw.length > 1500 ? lastRaw.slice(0, 1500) + "…[truncated]" : lastRaw}` },
        ];
    try {
      const raw = await ollamaChat(messages);
      lastRaw = raw;
      const cleaned = extractYamlString(raw);
      console.log(`[categorize] ${label} raw output (attempt ${attempt}):\n${cleaned}`);
      return parseYamlBlock(raw);
    } catch (e) {
      lastError = e.message;
      console.error(`[categorize] ${label} attempt ${attempt}/${maxAttempts} failed: ${e.message}`);
    }
  }
  throw new Error(`${label} failed after ${maxAttempts} attempts: ${lastError}`);
}

export async function post(req, reply) {
  const { name, ingredients } = req.body ?? {};
  if (!Array.isArray(ingredients) || !ingredients.length) {
    return reply.code(400).send({ error: "ingredients[] required" });
  }

  const system = await promptFor("categorize");
  if (!system) {
    console.error(`[categorize] no prompt in prompt_library — nothing maps to "categorize"`);
    return reply.code(503).send({ error: `No categorize prompt in prompt_library` });
  }

  // Two SEPARATE single-purpose cleanup passes, chained — not one prompt doing both. Combined-
  // quantity detection runs first: an "or" alternative can itself contain a combined amount
  // ("1 tbsp plus 1 tsp margarine or liquid spray"), so resolving the combination before the
  // alternative-pick keeps each pass looking at one concern at a time.
  const combinedResolved = await llmCleanupPass("resolve_combined_quantities", "combined-quantity", name, ingredients);
  const cleanIngredients = await llmCleanupPass("normalize_ingredients", "normalize", name, combinedResolved);

  const numbered = cleanIngredients.map((r, i) => `${i + 1}. ${r}`).join("\n");
  const userMsg = `Recipe: "${name || "unknown"}"\n\nIngredients:\n${numbered}`;
  console.log(`[categorize] model=${OLLAMA_MODEL} host=${OLLAMA_HOST} recipe="${name}" ingredients=${cleanIngredients.length}`);
  console.log(`[categorize] user message:\n${userMsg}`);

  let parsed;
  try {
    parsed = await chatWithYamlRetry(system, userMsg, `categorize "${name}"`);
  } catch (e) {
    console.error(`[categorize] failed for "${name}" (model=${OLLAMA_MODEL} host=${OLLAMA_HOST}):`, e.message);
    return reply.code(503).send({ error: e.message });
  }

  // Correct the model's category for ingredients the prompt already pins down explicitly (carrot,
  // tomato, broth, garlic, ...) — it contradicts its own given list on these often enough that a
  // deterministic lookup is more reliable than re-prompting.
  const corrected = (Array.isArray(parsed?.components) ? parsed.components : []).map((c) => {
    const forced = overrideCategory(c.ingredient);
    if (forced && forced !== c.category) {
      console.log(`[categorize] OVERRIDE "${c.ingredient}": model said ${JSON.stringify(c.category)} -> forced "${forced}"`);
    }
    return { ...c, category: forced ?? c.category };
  });

  // Dual-plating-role exceptions (cheese/yogurt -> dairy+protein; beans/lentils/peas -> protein+
  // vegetable): the model reports category as an array when dual, and CODE expands that into
  // separate component records, copying quantity/unit/prep UNCHANGED onto each — asking the model
  // to write the same ingredient out twice made it "helpfully" split the quantity in half.
  //
  // dualRoleFor() — NOT the model's own array — is the sole authority on whether an ingredient is
  // actually dual-role. Showing ONE array example in the prompt (cheese) taught the model that
  // arrays are a valid pattern in general, and it started inventing them for ingredients that were
  // never dual (margarine as [dairy, fat], sour cream as [protein, dairy]). Trusting an arbitrary
  // model-produced array would let that overgeneralization straight into the data, so any category
  // — array or string — gets collapsed to what the regulation-grounded lookup says; only its own
  // first-choice category survives if the ingredient isn't on that known list.
  const seenLines = new Set();
  const allItems = [];
  for (const c of corrected) {
    const lineKey = `${c.ingredient}|${c.quantity}|${c.unit}|${c.prep}`;
    if (seenLines.has(lineKey)) continue;
    seenLines.add(lineKey);
    const known = dualRoleFor(c.ingredient);
    const categories = known ?? [Array.isArray(c.category) ? c.category[0] : c.category];
    for (const category of categories) allItems.push({ ...c, category });
  }

  const components = allItems.filter((c) => c.category !== "seasoning");
  const seasonings = allItems
    .filter((c) => c.category === "seasoning")
    .map((c) => ({ ingredient: c.ingredient, quantity: c.quantity ?? undefined, unit: c.unit ?? undefined }));

  // Allergens: DETERMINISTIC FDC-backed lookup (USDA FoodData Central category + majority
  // ingredient-statement scan), cached in Mongo — NO LLM in the safety-critical decision, because
  // even single-depth the small model hallucinates on individual tokens (eggplant->eggs, cooking
  // spray->wheat). One batch warms the cache for the whole recipe, then each ingredient resolves
  // from cache. Ingredients FDC can't resolve fall back to the keyword scan AND are logged for
  // review — never silently dropped.
  const names = [...new Set(allItems.map((c) => c.ingredient))];
  let allergens = [];
  try {
    await warmAllergenCache(names);
    const resolved = await Promise.all(names.map((n) => findAllergens(n)));
    const unresolved = [];
    resolved.forEach((r, i) => (r.allergens === null ? unresolved.push(names[i]) : allergens.push(...r.allergens)));
    if (unresolved.length) {
      console.log(`[categorize] "${name}" allergen FDC unresolved -> keyword-scan fallback + REVIEW: [${unresolved.join(", ")}]`);
      allergens.push(...detectAllergens(unresolved));
    }
    allergens = [...new Set(allergens)].sort();
  } catch (e) {
    console.error(`[categorize] FDC allergen lookup failed for "${name}" — keyword-scan fallback:`, e.message);
    allergens = detectAllergens([...names, ...ingredients]);
  }

  console.log(`[categorize] "${name}" → ${components.length} components [${components.map(c => c.category + ':' + c.ingredient).join(', ')}]`);
  console.log(`[categorize] "${name}" → ${seasonings.length} seasonings [${seasonings.map(s => s.ingredient).join(', ')}]`);
  console.log(`[categorize] "${name}" → allergens: [${allergens.join(', ')}]`);
  return { components, seasonings, allergens };
}
