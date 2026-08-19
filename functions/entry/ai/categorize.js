// POST /ai/categorize — ASYNC ingredient categorization. Called by the n8n scraper (no Firebase auth).
//
// A deployed Cloud Function has NO Ollama, so this route can never call inference itself — it used to,
// and returned 500 in production. INVARIANT: only a worker talks to Ollama; a function publishes a job.
// So this composes a fixed 3-step plan onto llmResults/{jobId}, publishes {action:"start"} to
// ORCHESTRATE_TOPIC (the same single launch authority /ai/menu uses), and returns 202 {jobId}.
//
// GET /ai/categorize/:jobId polls it. The DETERMINISTIC post-processing (category override, dual-role
// expansion, FDC allergen lookup, YAML parse) is NOT inference, so it stays here: it runs off the last
// step's output once the job is terminal, and its output is cached as `result` on the job doc.
import { randomUUID } from "crypto";
import { PubSub } from "@google-cloud/pubsub";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { parseYamlBlock } from "../../../config/yaml.js";
import { getCollection } from "../../lib/mongo.js";
import { ORCHESTRATE_TOPIC } from "../../lib/topics.js";
import { detectAllergens } from "../../lib/allergenLookup.js";
import { findAllergens, warmAllergenCache } from "../../lib/allergenFdc.js";
import { overrideCategory } from "../../lib/categoryOverride.js";
import { dualRoleFor } from "../../lib/dualRoleLookup.js";

// The model TOPIC each step is dispatched to (a worker tier, not a bare Ollama model name).
const MODEL_TOPIC = process.env.CATEGORIZE_MODEL_TOPIC || "llama3_1_8b_v1";

let _pubsub;
function pubsub() {
  if (!_pubsub) _pubsub = new PubSub({ projectId: process.env.GCP_PROJECT_ID });
  return _pubsub;
}

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

// Every step is subtype "task" — an already-registered subtype (config/models.js SUBTYPES). The worker
// resolves a step's SYSTEM prompt by prompt_library mapping[subtype], and nothing maps to "task", so the
// prompt text has to ride on the step's `instructions` instead (worker/steps/step.js renders it as the
// user message's "# Instructions" section). That's why each step reads its prompt from prompt_library
// here and injects it — the function fetches the prompt, the worker runs it.
function taskStep(instructions, contexts, successStep) {
  return {
    instructions,
    model: MODEL_TOPIC,
    subtype: "task",
    kind: "single",
    tools: [],
    style: "structured",
    contexts,
    includeInResults: true,
    failStep: null,
    successStep,
  };
}

// ---- Payload framing (MECHANISM — belongs in code) -------------------------------------------
// The stored prompts each end with a worked example, and the real payload used to be concatenated
// straight onto it. A 8B model answered the EXAMPLE instead of the input (it reproduced the
// prompt's own "1 tablespoon plus 1 teaspoon → 4 teaspoons" arithmetic with the recipe's oil
// substituted in, and dropped the recipe's salmon line entirely — losing the only protein and the
// `fish` allergen silently). So the real payload is FENCED.
//
// The fence tokens must not collide with anything the stored prompts already use to delimit their
// own examples — those use "BEGIN EXAMPLE INPUT"/"END EXAMPLE INPUT" and "Example input:", so the
// arrow-run fence below can never be confused for one.
const FENCE_OPEN = ">>>>>>>>>> REAL INPUT — ANSWER THIS >>>>>>>>>>";
const FENCE_CLOSE = "<<<<<<<<<< END REAL INPUT <<<<<<<<<<";

// The step self-report contract (MECHANISM — belongs in code). The marker format is owned by
// worker/steps/outcome.js (bare "@@::" / "::@@" bookends, NO angle brackets — weak models drop
// "<"/">"); splitOutcome() strips it from the stored response, so it never reaches the next pass
// or the YAML parser. A FAIL drives step.js's bounded retry, which folds the reason into the
// retry prompt.
//
// MEASURED LIMIT — do not treat this as the guard: llama3.1:8b emits the marker format reliably but
// self-assesses badly. In testing it reported PASS on a pass that had dropped a line and on a pass
// that had invented a quantity. It is a cheap extra chance to catch a bad pass EARLY (a FAIL does
// retry it), not a guarantee. checkPasses() is the guarantee.
function selfReport(unit, count, lastAnchor) {
  return [
    "## Self-report (required)",
    // "the last line must be numbered N" (below) made a 17-line run number the marker as item 17,
    // which hides a dropped ingredient behind a line that looks present. Say it is not a list item.
    `After your output, on its own final line, emit EXACTLY ONE of these two markers verbatim. The marker is NOT part of your output and must NOT be given a list number:`,
    `@@::PASS::@@`,
    `@@::FAIL:short reason here::@@`,
    `Emit the FAIL marker (never PASS) if your output does not contain exactly ${count} ${unit}, ` +
      (lastAnchor ? `if its last line is not numbered ${count}, ` : "") +
      `or if any value in it came from an example rather than from the real input. ` +
      `The reason must be one short phrase and must not contain a colon.`,
  ].join("\n");
}

// ---- Generic payload rules (WORDING — should move to prompt_library) --------------------------
// TODO(prompt_library): this is instruction TEXT, not mechanism. It is appended here only so it
// could be iterated without writing to Mongo. Once these sentences are added to the three prompt
// docs (resolve_combined_quantities / normalize_ingredients / categorize), delete this block and
// the `rules` argument threaded through framePayload — keeping the same rule in both code and DB
// is the failure mode to avoid.
const PAYLOAD_RULES = (unit, count, passthrough) => [
  "## Rules for this request",
  `- Any example anywhere in the instructions above is ILLUSTRATIVE ONLY. Never let an example's ingredient, quantity, unit, or arithmetic appear in your output.`,
  `- Your output must contain exactly ${count} ${unit} — one per real input line, in the SAME order, with nothing merged, split, added, or dropped.`,
  // Without this the line-oriented wording above pulled the final pass off YAML and it answered with
  // a numbered list, which parses to zero components.
  ...(passthrough ? [] : [`- Keep the output format the instructions above require (a single \`\`\`yaml block). Do NOT answer with a numbered list.`]),
  ...(passthrough ? [`- Number your output lines 1 to ${count}. The last line you write MUST be line ${count}. Do not stop early.`] : []),
  `- Never invent a quantity, unit, ingredient, or an "implied"/assumed amount that is not literally written on the real input line. A line has only the amounts you can actually read on it.`,
  ...(passthrough ? [
    `- A line may only gain or change a number if the line itself literally joins two amounts with "plus", "and" or "+". A line with no such word joining two amounts is NOT a combination: never convert its units and never add a second amount to it.`,
    `- If none of the rules above apply to a line, copy that line through UNCHANGED — character for character, including its quantity and unit.`,
  ] : []),
  `- Output only the result. No reasoning, no working, no "Step 1 —" commentary, no text before or after it.`,
].join("\n");

// Assemble one pass's instructions: the stored prompt, then the generic rules, then the fenced
// real payload (inline for pass 0; the prior step's result block for later passes), then the
// self-report contract. The payload goes LAST-but-one so the model's attention lands on real data
// rather than on the stored prompt's trailing example.
function framePayload(prompt, unit, count, payload, passthrough = false) {
  return [prompt, PAYLOAD_RULES(unit, count, passthrough), payload, selfReport(unit, count, passthrough)].join("\n\n");
}

// Two SEPARATE single-purpose cleanup passes, then the categorize pass — not one prompt doing all
// three. Combined-quantity detection runs first: an "or" alternative can itself contain a combined
// amount ("1 tbsp plus 1 tsp margarine or liquid spray"), so resolving the combination before the
// alternative-pick keeps each pass looking at one concern at a time. Each pass sees the previous
// pass's output via `contexts`.
async function buildPlan(name, ingredients) {
  const numbered = ingredients.map((r, i) => `${i + 1}. ${r}`).join("\n");
  const n = ingredients.length;
  const [combined, normalize, categorize] = await Promise.all([
    promptFor("resolve_combined_quantities"),
    promptFor("normalize_ingredients"),
    promptFor("categorize"),
  ]);
  if (!categorize) return null;

  const inline = `${FENCE_OPEN}\nRecipe: "${name || "unknown"}"\n${numbered}\n${FENCE_CLOSE}`;
  // Later passes get their real input from the prior step's "# Result of step N" context block
  // (worker/steps/step.js appends it after the instructions), so they are pointed at it instead.
  const chained = `${FENCE_OPEN}\nThe real input is the ${n} numbered ingredient lines in the "# Result of step" block below. Apply these instructions to those lines only — not to any example above.\n${FENCE_CLOSE}`;

  // The combining pass runs ONLY when some line actually joins two amounts. Its prompt teaches
  // llama3.1:8b a unit equivalence ("1 tablespoon = 3 teaspoons") plus "convert to the smaller
  // unit", and on a recipe with nothing to combine the 8B applies that conversion anyway: measured
  // across three real AHA recipes it turned "1 tablespoon olive oil" into "3 teaspoons"/"1 tablespoon
  // plus 1 teaspoon", "1 1/2 pounds" into "3 pounds", and "1/2 tablespoon" into "3/2 tablespoons".
  // Running a pass that can only corrupt a recipe it has no work to do on is pure downside, so it is
  // skipped. Detection is the same COMBINATION test the output validator uses; a false negative just
  // means the pass runs as before, and a skipped pass cannot silently drop a line either.
  const steps = [];
  if (combined && ingredients.some((l) => COMBINATION.test(l))) {
    steps.push(framePayload(combined, "numbered lines", n, inline, true));
  }
  steps.push(framePayload(normalize, "numbered lines", n, steps.length ? chained : inline, true));
  steps.push(framePayload(categorize, "components (one per input line)", n, chained));
  // Each step reads the previous one's output; the first reads the inline payload.
  return steps.map((instructions, i) =>
    taskStep(instructions, i === 0 ? [] : [i - 1], i + 1 < steps.length ? i + 1 : null)
  );
}

export async function post(req, reply) {
  const { name, ingredients, fake } = req.body ?? {};
  if (!Array.isArray(ingredients) || !ingredients.length) {
    return reply.code(400).send({ error: "ingredients[] required" });
  }

  const plan = await buildPlan(name, ingredients);
  if (!plan) {
    console.error(`[categorize] no prompt in prompt_library — nothing maps to "categorize"`);
    return reply.code(503).send({ error: `No categorize prompt in prompt_library` });
  }

  const db = getFirestore();
  const jobId = randomUUID();
  const jobRef = db.collection("llmResults").doc(jobId);
  const summary = `Categorize · ${name || "unknown"} · ${ingredients.length} ingredients`;
  await jobRef.set({
    jobId, userId: "scraper", companyId: "scraper", model: MODEL_TOPIC, type: "categorize",
    message: summary, userPrompt: summary, plan, stepCount: plan.length, cursor: 0,
    status: "running", fake: fake === true, createdAt: FieldValue.serverTimestamp(),
    // The deterministic post-processing needs the ORIGINAL request (allergen keyword fallback
    // scans the raw lines); the job doc is the only thing the GET has.
    input: { name: name || "", ingredients },
  });
  // Launch through the orchestrator — publish `start`. The plan is already on the doc, so start.js
  // skips the planner and dispatches step 0. Same single launch authority for every job.
  await pubsub().topic(ORCHESTRATE_TOPIC).publishMessage({ json: { action: "start", jobId } });

  console.log(`[categorize] → jobId=${jobId} published start to "${ORCHESTRATE_TOPIC}" steps=${plan.length} model=${MODEL_TOPIC}${fake === true ? " (FAKE)" : ""}`);
  return reply.code(202).send({ jobId });
}

// GET /ai/categorize/:jobId → {status, result}. status mirrors the job doc
// (running | success | fail | paused); `result` is null until the job is terminal.
// The result's three fields are ALSO spread at the top level, because that's where the n8n
// scraper reads them — the pre-async response shape, preserved.
// A rejection reason is also emitted as `outcome`, the field the n8n scraper node reads to build
// its human-review error message — without it a rejected recipe is filed with no explanation.
export const body = (status, result, reason) => ({ status, result, ...(result || {}), ...(reason ? { reason, outcome: reason } : {}) });

// A mangled parse must NEVER be returned as `success` — the n8n scraper treats any non-success
// status as terminal-bad and files the recipe as uncategorized for human review, which is the
// correct outcome for a recipe that silently lost an ingredient. Two deterministic invariants:
//
//   1. COUNT — one parsed line per input line. Counted on the UNIQUE source lines, not on the
//      returned rows: postProcess's dual-role expansion legitimately emits two rows for one line
//      (cheese → dairy + protein), so the returned array length is not the right thing to compare.
//   2. TRACEABILITY — every returned ingredient must share a real word with the input text. This is
//      what catches an ingredient that came from a prompt's worked example ("light tub margarine")
//      rather than from the recipe.
export function checkResult(ingredients, { components = [], seasonings = [] }) {
  const rows = [...components, ...seasonings];
  if (!rows.length) return { ok: false, reason: `no ingredients parsed from ${ingredients.length} input lines` };

  // Count DISTINCT SOURCE LINES (`src`, stamped by postProcess), never unique content: two lines may
  // legitimately carry the same ingredient/quantity/unit, and one line legitimately yields two rows
  // when dual-role. Keying on content silently mistook a real duplicate line for a lost one.
  const covered = new Set(rows.map((c) => c.src));
  if (covered.size !== ingredients.length) {
    return { ok: false, reason: `parsed ${covered.size} ingredient lines but the recipe has ${ingredients.length}` };
  }

  const haystack = ingredients.join(" \n ").toLowerCase();
  const untraceable = rows
    .map((c) => String(c.ingredient ?? ""))
    .filter((n) => !(n.toLowerCase().match(/[a-z]{4,}/g) || []).some((w) => haystack.includes(w)));
  if (untraceable.length) {
    return { ok: false, reason: `ingredient(s) not present in the recipe input: ${[...new Set(untraceable)].join(", ")}` };
  }
  return { ok: true, reason: null };
}

// A numbered "N. …" line, split into its number and its text.
// A numbered "N. …" line, split into its number and its text. The text must be non-empty: when a
// model numbers the trailing status marker as a list item, splitOutcome strips the marker and leaves
// a bare "17." behind, which would otherwise count as a real ingredient line and hide a dropped one.
const NUMBERED = /^\s*(\d+)[.)]\s*(\S.*)$/;
const numberedLines = (text) =>
  String(text ?? "").split("\n").map((l) => l.match(NUMBERED)).filter(Boolean).map((m) => m[2]);

// Two amounts joined additively on ONE line — a number, an additive connective, another number,
// within a short span so "corn, husks and silk discarded" (no second number) can't match. Resolving
// these INTO a single amount is pass 0's whole job; no cleanup pass may ever CREATE one.
const COMBINATION = /\d[^,;]{0,24}?\b(?:plus|and)\b[^,;]{0,24}?\d|\d[^,;]{0,12}?\+[^,;]{0,12}?\d/i;

// Numeric VALUES on a line: "1 1/2" → {1, 0.5}, "0.25" → {0.25}. Compared as a set, not a multiset,
// so a pass that merely repeats or drops an existing number is never flagged.
function numberValues(line) {
  const out = new Set();
  for (const tok of String(line).match(/\d+(?:\.\d+)?(?:\s*\/\s*\d+)?/g) || []) {
    const [a, b] = tok.split("/");
    out.add(b ? Number(a) / Number(b) : Number(a));
  }
  return out;
}

// The pre-async implementation compared each pass's output line count to its input's and discarded a
// pass that changed it. The passes now chain INSIDE the worker, so that guard can no longer correct a
// pass mid-flight — but once the job is terminal every pass's run doc is readable, so the DETECTION is
// recoverable here, and it names the pass that actually broke. The final pass emits YAML, not a
// numbered list, so only the cleanup passes are checked. Two invariants per cleanup pass:
//
//   COUNT   — one output line per input line (the guard that was lost).
//   NUMBERS — an output line may only carry numbers its own input line carried, unless that input
//             line was itself a combination (summing legitimately produces a new number). Observed:
//             `1 tablespoon olive oil` → `3 tablespoons olive oil`, the 3 copied out of the prompt's
//             "1 tablespoon = 3 teaspoons" worked example.
//   COMBINING — a cleanup pass may never introduce an additive combination a line didn't have.
//             Observed: `1 tablespoon olive oil` → `1 tablespoon plus 1 teaspoon olive oil`, the
//             prompt's worked-example phrase pasted onto the real line. NUMBERS cannot see this one
//             (both amounts are "1", so no new value appears) and neither changes the line count, so
//             COUNT alone reports success on silently-wrong data.
export function checkPasses(ingredients, runs, stepCount) {
  let input = ingredients;
  for (let step = 0; step < stepCount - 1; step++) {
    const text = runs.find((r) => r.step === step)?.response;
    if (text == null) continue; // no active run (e.g. a re-run mid-flight) — nothing to compare
    const output = numberedLines(text);
    if (output.length !== input.length) {
      return { ok: false, reason: `cleanup pass ${step} returned ${output.length} ingredient lines but was given ${input.length}` };
    }
    for (let i = 0; i < output.length; i++) {
      const wasCombined = COMBINATION.test(input[i]);
      if (COMBINATION.test(output[i]) && !wasCombined) {
        return {
          ok: false,
          reason: `cleanup pass ${step} invented a combined quantity on line ${i + 1}: "${input[i]}" became "${output[i]}"`,
        };
      }
      if (wasCombined) continue; // summing is licensed — the sum is a new number by design
      const had = numberValues(input[i]);
      const invented = [...numberValues(output[i])].filter((n) => !had.has(n));
      if (invented.length) {
        return {
          ok: false,
          reason: `cleanup pass ${step} invented the quantity ${invented.join(", ")} on line ${i + 1}: "${input[i]}" became "${output[i]}"`,
        };
      }
    }
    input = output; // each pass is checked against ITS OWN input — the previous pass's output
  }
  return { ok: true, reason: null };
}

export async function get(req, reply) {
  const { jobId } = req.params ?? {};
  const db = getFirestore();
  const jobRef = db.collection("llmResults").doc(jobId);
  const snap = await jobRef.get();
  // Unknown jobId → status "unknown", NOT 404: a 404 here is indistinguishable from "the route isn't
  // in the deployed bundle" (which is exactly what scripts/smoke.mjs asserts on), and the polling
  // caller needs a terminal answer either way.
  if (!snap.exists) return reply.send(body("unknown", null));
  const job = snap.data();

  if (job.status !== "success" && job.status !== "fail") {
    return reply.send(body(job.status || "running", null));
  }

  // `result` and `check` are computed together, once, and cached together: the check needs the
  // per-pass run docs, and re-reading that subcollection on every poll would be a read per poll.
  let { result, check } = job;
  if (!result) {
    const ingredients = job.input?.ingredients || [];
    const stepCount = job.stepCount || (job.plan || []).length;
    const runs = (await jobRef.collection("steps").get()).docs.map((d) => d.data()).filter((r) => !r.isDeleted);
    const raw = runs.find((r) => r.step === stepCount - 1)?.response || "";
    // JSON round-trip drops any `undefined` a sparse YAML row left behind — Firestore rejects those.
    const traced = JSON.parse(JSON.stringify(await postProcess(job.input?.name || "", ingredients, raw)));
    const passes = checkPasses(ingredients, runs, stepCount);
    // `src` is provenance for the line-coverage check only — strip it before the result is stored or
    // returned, so the response stays the shape the n8n scraper already reads.
    check = passes.ok ? checkResult(ingredients, traced) : passes;
    result = {
      ...traced,
      components: traced.components.map(({ src, ...c }) => c),
      seasonings: traced.seasonings.map(({ src, ...s }) => s),
    };
    await jobRef.set({ result, check }, { merge: true });
  }

  if (check && !check.ok) console.error(`[categorize] ${jobId} REJECTED — ${check.reason}`);
  return reply.send(body(check && !check.ok ? "fail" : job.status, result, check?.reason));
}

// DETERMINISTIC post-processing of the last step's YAML — no inference, so it lives in the function.
export async function postProcess(name, ingredients, raw) {
  let parsed = null;
  try {
    parsed = parseYamlBlock(raw);
  } catch (e) {
    console.error(`[categorize] "${name}" YAML parse failed: ${e.message}`);
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
  // `src` = the index of the INPUT line each row came from. It is the only reliable way to count
  // lines: a recipe may legitimately list the same ingredient at the same amount twice ("4 ounces
  // fat-free cream cheese" + "4 ounces low-fat cream cheese" both normalize to cream cheese|4|ounces),
  // and one line legitimately expands to two rows when dual-role. Deduplicating by CONTENT here used
  // to drop the second of two identical lines outright — silent data loss on a real AHA recipe.
  const allItems = [];
  corrected.forEach((c, src) => {
    const known = dualRoleFor(c.ingredient);
    const categories = known ?? [Array.isArray(c.category) ? c.category[0] : c.category];
    for (const category of categories) allItems.push({ ...c, category, src });
  });

  const components = allItems.filter((c) => c.category !== "seasoning");
  const seasonings = allItems
    .filter((c) => c.category === "seasoning")
    .map((c) => ({ ingredient: c.ingredient, quantity: c.quantity ?? null, unit: c.unit ?? null, src: c.src }));

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
