// ============================================================
// Ollama Worker
// - Pulls jobs from Pub/Sub
// - Queries MongoDB Vector Search for RAG context
// - Streams Ollama response chunks to Firestore in real-time
// - Writes the final result to Firestore on completion (Mongo is RAG-only)
// - Acks on success, nacks on failure (job returns to queue)
// ============================================================

// FIRST, before anything can log: stamp Cloud Logging severity onto console.error/warn. Without it
// the COS ops agent labels every worker line INFO, so real failures are invisible in the console
// and cannot drive an alert. Shared with the orchestrator via config/ (symlinked into functions/).
import { installSeverityLogging } from "../config/log-severity.js";
installSeverityLogging();

import { PubSub } from "@google-cloud/pubsub";
import { MongoClient } from "mongodb";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { processDay } from "./lib/inventory.js";
// Single source of truth (config/models.js, copied into the image + mounted in dev) — the
// planner's subtype list and default tools live here, NOT hardcoded in the worker.
import { SUBTYPES, DEFAULT_TOOLS, MODELS, unitDocId, defaultSampler, temperatureForStyle, DEFAULT_STYLE, STYLE_TEMPS, FAKE_SUBSCRIPTION, maxCtxFor } from "../config/models.js";
import { parseYamlBlock } from "../config/yaml.js";
import { inScope } from "./lib/assemble.js";
import { cannedResponse } from "./cannedResponses.js";
// Step builders live under steps/ — one file per step kind (see docs/plans/worker-refactor/plan.md).
// Pure / dependency-injected modules, unit-tested in steps/*.test.js.
import { buildMessages, buildStepMessages, sizeNumCtx, TerminalError } from "./steps/step.js";
import { buildPlannerMessages } from "./steps/planner.js";
import { buildComplianceMessages } from "./steps/compliance.js";
import { visibleResponse, splitOutcome } from "./steps/outcome.js";
import { buildStandardMessages, formatRecipeYaml } from "./lib/query.js";
// Leaseless, idempotent dispatch decisions (docs/design/worker-dispatch.md). Pure + unit-tested
// in admission.test.js. shouldRun gates the receive; completionWrite is the first-writer-wins CAS.
import { shouldRun, completionWrite } from "./admission.js";
// Ollama HTTP transport (extracted + unit-tested in ollama.test.js).
import { chatRound } from "./ollama.js";
// In-process generation concurrency gate (pure + unit-tested in semaphore.test.js).
import { createSemaphore } from "./semaphore.js";
// Free-tier web_search provider pool (Ollama/Brave/Tavily/DDG) — replaces Ollama's metered hosted
// search. Weighted-random pick, Firestore-tracked rolling-30-day quota. See search-pool.js.
import { searchPool, fetchPage } from "./tools/search-pool.js";
// Idle self-shutdown — turns the VM off within IDLE_SHUTDOWN_MS of going idle (see idle-shutdown.js).
import { makeIdleShutdown, selfDeleteFromMig, workerRegion, workerInstance } from "./idle-shutdown.js";
// Lease bound: never hold more messages than we can generate (see lease.js — this is the P1 fix for a
// backlog stranding a message and for an idle box holding a lease it can't act on).
import { generationSlots } from "./lease.js";
// Subscriber lifecycle + reopen-on-close (testable with a fake subscription — see reopen.test.js).
import { makeSubscriberLoop } from "./reopen.js";

// ---- Worker version stamp ----------------------------------
// Printed the instant the worker starts, so you can SEE which code is running. The version is
// part of the SOURCE: stale/baked code prints its OLD value (or no line at all, if it predates
// this); current code prints this. Bump it by hand on meaningful worker changes — the string
// travels with the code, so it identifies the code regardless of file timestamps.
const WORKER_VERSION = "2026-07-13 idle self-shutdown";
console.log(`[worker] VERSION ${WORKER_VERSION} | pid ${process.pid}`);

// ---- Config ------------------------------------------------
const {
  GCP_PROJECT_ID,
  SUBSCRIPTION_NAME,
  OLLAMA_HOST = "http://localhost:11434",
  OLLAMA_MODEL,
  MONGO_URI,
  MONGO_DB,
  MONGO_COLLECTION,
  MONGO_INDEX = "vector_index",
  RAG_TOP_K = "5",
  FIREBASE_PROJECT_ID,
  NEO4J_URI,
  NEO4J_USERNAME,
  NEO4J_PASSWORD,
  GATEWAY,                                          // "openclaw" → infer via the OpenClaw gateway
  OPENCLAW_URL = "http://localhost:18789",
  OPENCLAW_GATEWAY_TOKEN,
  OLLAMA_API_KEY,                                   // web_search/web_fetch (both paths). Required.
  OLLAMA_WEB_BASE = "https://ollama.com/api",       // hosted search/fetch endpoints
  MAX_TOOL_ROUNDS = "4",                            // safety cap on tool-call loops (raw path)
  WEB_TOOL_FALLBACK,                                 // when on, a non-retryable web-tool failure (429 quota /
                                                     // 401/403 auth) DEGRADES to one tool-free round (model
                                                     // answers from its own knowledge) instead of terminal-
                                                     // failing. Default depends on NODE_ENV (see
                                                     // WEB_TOOL_FALLBACK_ON below); set "true"/"false" to override.
  NODE_ENV = "production",                           // "dev" → also load inactive prompts
  PROMPT_COLLECTION = "prompt_library",
  TOOL_COLLECTION = "llmtools",
  MODEL_CONFIG_COLLECTION = "model_config",          // sampler params: `_default` doc + per-model overrides
  OLLAMA_NUM_CTX = "8192",                           // context window; Ollama defaults to a tiny 2-4k which
                                                     // a long system prompt fills, starving the output
  OLLAMA_NUM_PREDICT = "-1",                          // max output tokens; -1 = until done or context full
  OUTPUT_RESERVE_TOKENS = "4096",                     // tokens kept free for the model's OUTPUT when sizing num_ctx
  WEB_SEARCH_MAX,                                     // hard cap on web_search results (model's max_results is clamped to this)
  GEN_TIMEOUT_MS,                                     // abort a chat round after this many ms of no output — a hung
                                                       // generation must FAIL (and recover), never lock the worker
} = process.env;

// This worker serves ONE model (OLLAMA_MODEL). Its max context window — the cap we must not
// exceed — comes from the single source of truth (config/models.js). null if not found → no cap.
const MODEL_DEF = MODELS.find((m) => m.model === OLLAMA_MODEL) ?? null;
const MODEL_MAX_CTX = MODEL_DEF?.ctx ?? null;
// Usable VRAM on the box this worker talks to, for the KV-cache cap (maxCtxFor). Not the card's
// nameplate: the CUDA context, compute buffers and fragmentation take a cut, so an L4 (24 GB,
// 23034 MiB visible) budgets 20 — clamping at 22 aimed a load at 22.0 of 22 and left no headroom.
const GPU_VRAM_GB = parseFloat(process.env.GPU_VRAM_GB) || 20;

// A fake/canned worker drains ONLY the fake subscription (deploy.js deployFake sets SUBSCRIPTION_NAME
// to it) and returns canned output — it never talks to Ollama, so it needs no model and no
// web-search key. It still needs GCP/Mongo/Firestore like any worker.
const FAKE_ONLY = SUBSCRIPTION_NAME === FAKE_SUBSCRIPTION;

const required = { GCP_PROJECT_ID, SUBSCRIPTION_NAME, MONGO_URI, MONGO_DB, MONGO_COLLECTION };
if (!FAKE_ONLY) {
  required.OLLAMA_MODEL = OLLAMA_MODEL;
  required.OLLAMA_API_KEY = OLLAMA_API_KEY; // web search is on for every real tier — no key, no run
}
for (const [k, v] of Object.entries(required)) {
  if (!v) throw new Error(`${k} env var is required`);
}

// ---- Orchestrator report -----------------------------------
// Orchestrated jobs carry a `report` kind ("build" | "step"). When set, the worker
// publishes to the `orchestrate` topic on completion so the orchestrator advances.
// Legacy one-shot jobs have no `report` and skip this entirely.
const ORCHESTRATE_TOPIC = process.env.ORCHESTRATE_TOPIC || "orchestrate";
let _reportPubsub;
async function reportToOrchestrator(payload) {
  if (!payload.report) {
    console.log(`[worker]   ${payload.jobId} no report flag → not an orchestrated job, skipping orchestrate ping`);
    return;
  }
  if (!_reportPubsub) _reportPubsub = new PubSub({ projectId: GCP_PROJECT_ID });
  // `action` = the orchestrate verb (build | step) — payload.report carries which. (Not to be
  // confused with a step's `kind` = fanout|chunks|aggregation.) `status` = the terminal run status
  // (success | fail) so the orchestrator can branch success → advance / fail → stop; `outcome` =
  // the failure reason when fail (null on success). `region` = where THIS worker ran (from instance
  // metadata; null off-GCE) so the capacity scoreboard can attribute end-to-end success by region.
  const region = await workerRegion();
  await _reportPubsub.topic(ORCHESTRATE_TOPIC).publishMessage({
    json: { jobId: payload.jobId, action: payload.report, step: payload.step, runId: payload.runId, status: payload.runStatus ?? "success", outcome: payload.outcome ?? null, region },
  });
  console.log(`[worker] → reported to "${ORCHESTRATE_TOPIC}" action=${payload.report} status=${payload.runStatus ?? "success"}${payload.outcome ? ` outcome=${payload.outcome}` : ""} jobId=${payload.jobId}`);
}

// ---- Capacity outcome event --------------------------------
// On EVERY completed job (orchestrated step/build AND one-shot queries — NOT gated on payload.report),
// publish an `outcome` event to the orchestrate topic. The orchestrator's capacity controller records
// it: success → $inc ok on this region + re-decide; ran-but-failed → LOG only. Recording moved OFF the
// worker (it no longer writes region_capacity_stats directly) — the orchestrator is the one brain that
// calculates + writes + logs the would-decision. `region` = where THIS worker ran (instance metadata;
// null off-GCE). Fire-and-forget: a capacity publish must NEVER break job completion.
async function publishOutcome(payload) {
  try {
    if (!_reportPubsub) _reportPubsub = new PubSub({ projectId: GCP_PROJECT_ID });
    const region = await workerRegion();
    // Also carry the model TOPIC (from SUBSCRIPTION_NAME `sub_<topic>` — unambiguous, unlike OLLAMA_MODEL
    // which several tiers share) and this box's instance self-link, so the orchestrator's releaseBox can
    // targeted-delete THIS finished box in the right model's MIG. Both null off-GCE.
    const instance = await workerInstance();
    const model = SUBSCRIPTION_NAME ? SUBSCRIPTION_NAME.replace(/^sub_/, "") : null;
    await _reportPubsub.topic(ORCHESTRATE_TOPIC).publishMessage({
      json: { action: "outcome", jobId: payload.jobId, region, model, instance, status: payload.runStatus ?? "success", outcome: payload.outcome ?? null },
    });
    console.log(JSON.stringify({ message: `[capacity] outcome ${payload.runStatus ?? "success"} ${region ?? "?"}`, capacityEvent: "outcome", region, model, status: payload.runStatus ?? "success", jobId: payload.jobId }));
  } catch (e) {
    console.error(`[capacity] publishOutcome(${payload.jobId}) swallowed: ${e?.message}`);
  }
}

// ---- Firebase Admin ----------------------------------------
// Cloud Run: Application Default Credentials used automatically.
// Local dev: set GOOGLE_APPLICATION_CREDENTIALS to a service account key file.
function getFirestoreClient() {
  if (!getApps().length) {
    initializeApp({ projectId: FIREBASE_PROJECT_ID || GCP_PROJECT_ID });
  }
  return getFirestore();
}

// ---- Resilient Firestore writes ----------------------------
// Every Firestore write goes through fsWrite so a TRANSIENT failure self-heals instead of failing
// the job (or crashing the worker). Mirrors the resilience already wired for Mongo (retryReads +
// timeouts) and Pub/Sub (lease re-extension, ack-not-nack). Transient = an auth token the SDK minted
// but the server rejected (ACCESS_TOKEN_EXPIRED — e.g. the Docker VM clock briefly skewed on host
// resume so a freshly-minted token's iat/exp looked invalid) or a gRPC blip (UNAVAILABLE/
// DEADLINE_EXCEEDED/ABORTED). The SDK does NOT retry writes on these, so we do: re-running the op
// mints a fresh, now-valid token and the write lands — that is the "catch AND fix" (not catch & die).
// A PERSISTENT failure (bad creds, permission denied, missing doc) is NOT transient → it throws after
// the cap so the caller fails just THAT job, never the whole consumer.
const FS_TRANSIENT_CODES = new Set([4, 10, 14]); // gRPC DEADLINE_EXCEEDED, ABORTED, UNAVAILABLE
function isTransientFirestore(err) {
  const reason = err?.errorInfo?.reason || err?.cause?.errorInfo?.reason || "";
  if (reason === "ACCESS_TOKEN_EXPIRED") return true;
  if (FS_TRANSIENT_CODES.has(err?.code)) return true;
  return /ACCESS_TOKEN_EXPIRED|token (?:has )?expired|UNAVAILABLE|DEADLINE_EXCEEDED|socket hang up|ECONNRESET|EAI_AGAIN/i.test(
    `${err?.message || ""} ${err?.cause?.message || ""}`
  );
}
// Run a Firestore op with exponential backoff on transient failures. `label` names the write in logs.
async function fsWrite(label, op, { tries = 5 } = {}) {
  let delay = 250;
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      if (attempt >= tries || !isTransientFirestore(err)) throw err;
      console.warn(`[worker]   firestore "${label}" transient failure (attempt ${attempt}/${tries}): ${err.message} — retry in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 5000);
    }
  }
}

// ---- MongoDB -----------------------------------------------
// Resilient options so the connection recovers when the network changes
// (laptop WiFi/VPN/sleep): fail server-selection fast instead of hanging, retry
// transient reads, heartbeat often to rediscover the topology, and drop sockets
// stranded by the old network. RAG is also opt-in + non-fatal (see handleMessage),
// so a Mongo blip never fails the job.
const mongo = new MongoClient(MONGO_URI, {
  serverSelectionTimeoutMS: 8000,
  socketTimeoutMS: 45000,
  heartbeatFrequencyMS: 5000,
  maxIdleTimeMS: 30000,
  retryReads: true,
});
let ragCollection;
let promptCollection;
let toolCollection;
let modelConfigCollection;

async function connectMongo() {
  await mongo.connect();
  ragCollection = mongo.db(MONGO_DB).collection(MONGO_COLLECTION);
  promptCollection = mongo.db(MONGO_DB).collection(PROMPT_COLLECTION);
  toolCollection = mongo.db(MONGO_DB).collection(TOOL_COLLECTION);
  modelConfigCollection = mongo.db(MONGO_DB).collection(MODEL_CONFIG_COLLECTION);
  console.log(`MongoDB connected: ${MONGO_DB} (rag=${MONGO_COLLECTION}, prompts=${PROMPT_COLLECTION}, tools=${TOOL_COLLECTION}, modelConfig=${MODEL_CONFIG_COLLECTION})`);
}

// ---- Prompt library (Mongo-backed, cached) -----------------
// Prompts live in `prompt_library`: { mapping: { <topic>: <priority> }, active, content }.
//   - `mapping` is a MAP keyed by message TYPE → order key, for O(1) lookup.
//   - dev loads inactive prompts too; prod only active:true.
//   - cached with NO TTL; ~5% of requests re-query to pick up edits eventually.
//   - for a type: join all matching prompts, sorted ASC by the lexBetween order key
//     via plain code-unit compare (matches the dashboard's drag-drop ordering).
// Match "prod"/"production" in any case — never an exact-string env compare.
const IS_PROD = /prod(uction)?/i.test(NODE_ENV || "");
const INCLUDE_INACTIVE = !IS_PROD;

// In-process generation gate. Pub/Sub flow control (maxMessages — see main()) is the INTENDED
// bound, but it isn't sufficient on its own: the dev emulator ignores maxMessages and delivers a
// whole step's fanout at once, and in prod a redelivery can overlap a live run — either way we can
// be asked to run more concurrent generations than Ollama has run-slots, which floods a CPU box into
// first-token stalls. This gate caps concurrent generations at OLLAMA_NUM_PARALLEL (the Ollama
// server's run-slot count, baked into the image); the excess QUEUES in-process while its Pub/Sub
// lease keeps extending. It is NOT a lease and NOT cross-server correctness — duplicate concurrent
// runs of one unit remain harmless via the first-writer-wins CAS (completionWrite). See
// docs/design/worker-dispatch.md.
const GEN_LIMIT = generationSlots(process.env);
const genGate = createSemaphore(GEN_LIMIT);
console.log(`[worker] generation gate: max ${GEN_LIMIT} concurrent (OLLAMA_NUM_PARALLEL=${process.env.OLLAMA_NUM_PARALLEL ?? "unset"})`);

let promptCache = null;

async function loadPrompts() {
  const filter = { isDeleted: { $ne: true } };          // never load soft-deleted
  if (!INCLUDE_INACTIVE) filter.active = true;            // prod: active only; dev: all
  return promptCollection.find(filter).toArray();
}

// Pull once, then ~5% of lookups re-query to pick up edits eventually (no TTL). Dev
// (INCLUDE_INACTIVE) always re-pulls so prompt edits show immediately while developing.
async function getPrompts() {
  if (!promptCache || INCLUDE_INACTIVE || Math.random() < 0.05) {
    try {
      promptCache = await loadPrompts();
      console.log(`  prompt_library: ${promptCache.length} prompt(s) cached (includeInactive=${INCLUDE_INACTIVE})`);
    } catch (e) {
      console.warn(`  prompt_library load failed (${e.message}) — using ${promptCache ? "cached" : "empty"} set`);
      promptCache = promptCache || [];
    }
  }
  return promptCache;
}

// ---- Tools & subtypes for the planner ----------------------
// DEFAULT_TOOLS and SUBTYPES come from config/models.js (single source of truth) — not
// hardcoded here. DEFAULT_TOOLS is the fallback the planner gets until `llmtools` is
// populated; SUBTYPES is the subtype universe the planner may assign (with definitions).

// Tools cache — SAME strategy as getPrompts (pull once, ~5% re-query, dev always re-pulls).
// `llmtools` is empty for now, so getTools falls back to DEFAULT_TOOLS; once tools are added
// to the collection, those win — no code change.
let toolCache = null;
async function loadTools() {
  const filter = { isDeleted: { $ne: true } };          // never load soft-deleted
  if (!INCLUDE_INACTIVE) filter.active = true;            // prod: active only; dev: all
  return toolCollection.find(filter).toArray();
}
async function getTools() {
  if (!toolCache || INCLUDE_INACTIVE || Math.random() < 0.05) {
    try {
      toolCache = await loadTools();
      console.log(`  llmtools: ${toolCache.length} tool(s) cached (includeInactive=${INCLUDE_INACTIVE})`);
    } catch (e) {
      console.warn(`  llmtools load failed (${e.message}) — using ${toolCache ? "cached" : "default"} set`);
      toolCache = toolCache || [];
    }
  }
  const tools = toolCache.length ? toolCache : DEFAULT_TOOLS;   // no DB tools yet → required defaults
  return tools.map(toolLine).join("\n");                        // RETURN the formatted string
}

// ---- Sampler config (Mongo-backed, cached) -----------------
// `model_config` holds Ollama sampling options: one `_default` doc (global baseline) plus
// optional per-model docs keyed by the model string (e.g. "llama3.1:8b") that OVERRIDE it.
// Each doc is { _id, params: { temperature, top_p, ... } }. Resolution (later wins):
//   defaultSampler() [code]  →  `_default` doc  →  this worker's OLLAMA_MODEL doc.
// Only keys defaultSampler knows are merged, so a stray DB key can't reach Ollama. SAME cache
// strategy as getPrompts/getTools: pull once, ~5% re-query to pick up dashboard edits (no TTL),
// dev always re-pulls; a load failure falls back to the last cache (or code defaults).
let samplerCache = null;
async function loadSampler() {
  const docs = await modelConfigCollection.find({ _id: { $in: ["_default", OLLAMA_MODEL] } }).toArray();
  const params = Object.fromEntries(docs.map((d) => [d._id, d.params || {}]));
  return { ...defaultSampler(), ...(params._default || {}), ...(params[OLLAMA_MODEL] || {}) };
}
async function getSampler() {
  if (!samplerCache || INCLUDE_INACTIVE || Math.random() < 0.05) {
    try {
      samplerCache = await loadSampler();
      console.log(`  model_config: sampler resolved for ${OLLAMA_MODEL} (${Object.keys(samplerCache).length} keys)`);
    } catch (e) {
      console.warn(`  model_config load failed (${e.message}) — using ${samplerCache ? "cached" : "code-default"} sampler`);
      samplerCache = samplerCache || defaultSampler();
    }
  }
  return samplerCache;
}

// ---- Output-style temperatures (Mongo-backed, cached) ------
// The style→temperature map MERGES default → override, exactly like getSampler:
//   code STYLE_TEMPS  →  model_config `_styles`.params (global)  →  this model's doc `.styles` (per-model)
// Each layer overrides only the styles it names; the rest fall through to the layer below (so the DB
// need only store what differs from code). Dashboard-editable. SAME cache strategy as getSampler:
// pull once, ~5% re-query (no TTL), dev always re-pulls; a load failure falls back to the code table.
let styleTempsCache = null;
async function loadStyleTemps() {
  const docs = await modelConfigCollection.find({ _id: { $in: ["_styles", OLLAMA_MODEL] } }).toArray();
  const by = Object.fromEntries(docs.map((d) => [d._id, d]));
  return { ...STYLE_TEMPS, ...(by["_styles"]?.params || {}), ...(by[OLLAMA_MODEL]?.styles || {}) };
}
async function getStyleTemps() {
  if (!styleTempsCache || INCLUDE_INACTIVE || Math.random() < 0.05) {
    try {
      styleTempsCache = await loadStyleTemps();
      console.log(`  model_config: style temps ${JSON.stringify(styleTempsCache)}`);
    } catch (e) {
      console.warn(`  style temps load failed (${e.message}) — using ${styleTempsCache ? "cached" : "code-default"} map`);
      styleTempsCache = styleTempsCache || { ...STYLE_TEMPS };
    }
  }
  return styleTempsCache;
}

// Subtypes: no `subtypes` collection yet, so the defaults (with definitions) are the source.
// (When one exists, fetch+cache here the same way as tools and fall back to SUBTYPES.)
async function getSubtypes() {
  // This string IS the planner's menu of assignable steps. A one-shot subtype (a UI action on a
  // single slot) still needs a prompt, so it stays in SUBTYPES/MESSAGE_TYPES — but offering it here
  // would let the planner schedule it as a step inside a plan. Opt-out, so anything unflagged is
  // still offered exactly as before.
  return SUBTYPES.filter((s) => !s.excludePlan).map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

// System prompt for a message TYPE (e.g. "query") = matching prompts joined,
// sorted ascending by priority. `mapping` is keyed by message type, not the model.
//
// `scope` narrows to one PIPELINE (menu_plan | task_list — see config/promptSections.js inScope), so
// one subtype can carry different prompt text in a meal-plan build than in a task list without
// forking the subtype. Undefined = no scope filter, which is what every non-step caller passes
// (buildStandardMessages for a direct /ai/query, planner.js) — their behaviour is unchanged.
async function systemPromptFor(type, scope) {
  const prompts = await getPrompts();
  return prompts
    .filter((p) => p.mapping && p.mapping[type] != null)
    .filter((p) => scope === undefined || inScope(p, scope))
    // plain code-unit sort — must match the dashboard's lexBetween ordering, NOT localeCompare
    .sort((a, b) => {
      const x = String(a.mapping[type]), y = String(b.mapping[type]);
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .map((p) => p.content)
    .filter(Boolean)
    // Strip stray markdown escape backslashes (e.g. "\#", "\-") that older editor
    // saves may have left in stored content, so the model gets clean markdown.
    .map((c) => c.replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1"))
    .join("\n\n");
}

// ---- RAG ---------------------------------------------------
// RAG is OPT-IN and OFF by default. It only works when (a) an embedding endpoint is actually
// available and (b) it's the SAME embedding model that built the `regulations` vector index —
// embedding a query with the chat model (different dimensions) yields garbage search even if the
// call succeeds, and here the call 500/501s outright. So the feature stays disabled until a real,
// index-matching embedding model is wired up: set RAG_ENABLED=true then. While off, retrieveContext
// returns "" immediately — no embeddings call, no 18s timeout, no error spam; callers proceed
// without context (compliance is designed to degrade gracefully).
const RAG_ENABLED = process.env.RAG_ENABLED === "true";

async function getEmbedding(text) {
  const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.statusText}`);
  const { embedding } = await res.json();
  return embedding;
}

async function retrieveContext(query) {
  if (!RAG_ENABLED) return ""; // feature off (no index-matching embedding model) — skip cleanly
  const embedding = await getEmbedding(query);
  const results = await ragCollection.aggregate([
    {
      $vectorSearch: {
        index: MONGO_INDEX,
        path: "embedding",
        queryVector: embedding,
        numCandidates: parseInt(RAG_TOP_K) * 10,
        limit: parseInt(RAG_TOP_K),
      },
    },
    { $project: { _id: 0, text: 1, score: { $meta: "vectorSearchScore" } } },
  ]).toArray();
  return results.map((r) => r.text).join("\n\n");
}

// buildMessages / buildStepMessages / buildPlannerMessages / buildComplianceMessages live under
// steps/ (imported above). buildStandardMessages (the generic fallback) stays here.

// toolLine formats a tool (DB or default) for the planner's tools list. Used by getTools().
function toolLine(t) {
  // DB tools store the schema in `definition`; defaults use {name, description}.
  const fn = t.definition?.function || t.definition || {};
  return `- ${fn.name || t.name || "unknown"}: ${fn.description || t.description || ""}`;
}

// ---- Per-type message builders (dispatched by a lookup table) ----------------
// One builder per message type. Each takes the full message `payload` (+ optional RAG
// `context`) and returns the chat `messages` for the LLM. They DON'T touch each other —
// add a type by adding a builder + a table entry; the handler never branches on type.

// (planner builder → steps/planner.js)

// standard (query and any other domain type): system prompt for the type + the raw query.
// buildStandardMessages is now imported from ./lib/query.js

// (step builder → steps/step.js; compliance subtype builder → steps/compliance.js)

// Dependencies the step builders need (mongo/firestore-backed helpers). Injected so the builder
// files stay pure + unit-tested (steps/*.test.js). subtypeBuilders routes a step by its `subtype`
// (e.g. compliance) inside the generic step path.
const stepDeps = {
  // getPrompts (not just systemPromptFor) because fragment placement needs the RECORDS, not the
  // joined string: `relatesTo` decides whether a fragment belongs in the system message or inside
  // the instruction. Without it, step.js falls back to the joined system prompt and the section
  // markers reach the model verbatim.
  systemPromptFor, getPrompts, getTools, getSubtypes, retrieveContext, getFirestoreClient,
  subtypeBuilders: { compliance: buildComplianceMessages },
};

// type → builder. Unknown/other types fall through to the standard builder.
const MESSAGE_BUILDERS = {
  planner: (payload, context) => buildPlannerMessages(payload, context, stepDeps),
  step:    (payload, context) => buildStepMessages(payload, context, stepDeps),
};
const builderFor = (type) => MESSAGE_BUILDERS[type] || ((p, c) => buildStandardMessages(p, c, { systemPromptFor, buildMessages }));

// ---- Ollama web tools (web_search / web_fetch) -------------
// On the raw (non-gateway) path the MODEL calls these; the WORKER executes them
// against Ollama's hosted endpoints with OLLAMA_API_KEY, then feeds results back.
// (Gateway tiers get the same tools from OpenClaw instead — see chatViaOpenClaw.)
// Built from DEFAULT_TOOLS (config/models.js) so the tool descriptions/params live in ONE place —
// the SAME specs the planner sees. The worker just wraps them in Ollama's function-call shape.
const TOOLS = DEFAULT_TOOLS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

// Hard cap on web_search results (from WEB_SEARCH_MAX in env). The MODEL picks max_results and a
// weak one asks for absurd values (we saw 1000 → a 122k-token payload that blew the context and
// timed out the next generation). Clamp to a sane window: never trust the model's number unbounded.
const WEB_SEARCH_CAP = Math.max(1, parseInt(WEB_SEARCH_MAX, 10) || 3);

// Should a dead web tool (429/auth) degrade to a tool-free "answer from memory" round instead of
// terminal-failing the step? DEV defaults ON so an exhausted web quota doesn't block local pipeline
// testing; production defaults OFF so grounding steps fail rather than invent sources. An explicit
// WEB_TOOL_FALLBACK ("true"/"false") overrides the env-based default.
const WEB_TOOL_FALLBACK_ON =
  WEB_TOOL_FALLBACK == null || WEB_TOOL_FALLBACK === ""
    ? NODE_ENV === "dev"
    : /^true$/i.test(WEB_TOOL_FALLBACK);

// Capping the COUNT is not enough — each web result carries full page text, so even 10 results
// can be ~350k chars (we saw 347,790 → the 8192-ctx model truncated to 8191 and kept 4 tokens of
// the real prompt, so it produced nothing). Condense every tool result to title + url + a snippet
// so the whole payload fits the window. web_fetch is a deliberate single-URL pull, so it gets a
// larger budget than one search hit.
const WEB_RESULT_CHARS = 1200; // per web_search hit's content
const WEB_FETCH_CHARS = 6000;  // a single web_fetch body
const clip = (s, n) => {
  const str = typeof s === "string" ? s : (s == null ? "" : String(s));
  return str.length > n ? `${str.slice(0, n)}… [truncated, ${str.length} chars total]` : str;
};

// Shrink a raw web tool result to a compact, model-friendly shape before it re-enters the prompt.
// Unknown shapes fall through clipped whole, so a new field can never silently blow the context.
function condenseToolResult(name, result) {
  if (!result || result.error) return result;
  if (name === "normalize_ingredients") return result; // already-compact rows — never clip (would corrupt the JSON of a 50-100 row batch)
  if (name === "web_search") {
    const hits = Array.isArray(result.results) ? result.results : [];
    return {
      results: hits.map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        content: clip(r.content ?? r.snippet ?? "", WEB_RESULT_CHARS),
      })),
    };
  }
  if (name === "web_fetch") {
    return {
      title: result.title ?? "",
      url: result.url ?? "",
      content: clip(result.content ?? "", WEB_FETCH_CHARS),
    };
  }
  return JSON.parse(clip(JSON.stringify(result), WEB_FETCH_CHARS));
}

async function executeTool(name, args) {
  // Inventory step: the model copied residents + the diet distribution + the day's recipes into
  // `args` (it does NO math); the tool normalizes the names and scales each amount by how many
  // residents are on that recipe's diet, in CODE. Pure (no web call). Returns rows for the model
  // to format.
  if (name === "normalize_ingredients") {
    return { rows: processDay(args) };
  }
  // web_search → free-tier PROVIDER POOL (search-pool.js), NOT Ollama's metered hosted endpoint.
  // Weighted-random pick among providers under their rolling-30-day cap, DDG as the keyless fallback;
  // quota lives in Firestore tools_limits/web_search/<provider>/<day>. Returns { results } | { error }
  // (no TerminalError — the pool routes around 429s, so an exhausted quota no longer kills the step).
  if (name === "web_search") {
    const asked = Number(args.max_results) || WEB_SEARCH_CAP;
    const max_results = Math.min(Math.max(1, asked), WEB_SEARCH_CAP);
    if (asked > WEB_SEARCH_CAP) console.warn(`[worker]   web_search max_results ${asked} → clamped to ${max_results}`);
    args.max_results = max_results;   // write the EFFECTIVE value back so the tool-call log/record shows what actually ran, not the model's (clamped-away) ask
    return await searchPool({ query: args.query, max_results, db: getFirestoreClient() });
  }
  // web_fetch → curl (search-pool.js fetchPage), NOT Ollama's metered hosted endpoint. No quota to
  // exhaust, so it never 429s the way the old path did. A failed fetch returns a soft { error } so the
  // model can try another URL or answer — never terminal.
  if (name === "web_fetch") {
    try {
      return await fetchPage(args.url);
    } catch (err) {
      return { error: err.message };
    }
  }
  return { error: `unknown tool: ${name}` };
}

// chatRound (the Ollama HTTP transport + stall watchdog + keep-alive pool) lives in ./ollama.js so
// it is unit-testable in isolation (see ollama.test.js). It takes sampler/host/timeouts as opts;
// the callers below resolve the sampler once per request and pass it in.

// Raw-path inference WITH web tools: loop chat rounds, executing any web_search/
// web_fetch the model requests, until it answers (no tool calls). Streams the answer.
// Weak/quantized models sometimes WRITE a tool call as text ("…{"name":"web_search","parameters":
// {…}}") instead of using the structured tool_calls field — which leaves the step's "answer" as a
// literal function call. Recover the intent: pull the first balanced JSON object that names a KNOWN
// tool out of the content so chatWithTools can execute it like a real call. String-aware brace scan
// so braces inside argument strings don't throw off the balance.
function parseTextToolCall(content, toolDefs) {
  if (!content || !content.includes('"name"')) return null;
  const names = new Set(toolDefs.map((t) => t.function.name));
  for (let i = content.indexOf("{"); i >= 0; i = content.indexOf("{", i + 1)) {
    let depth = 0, inStr = false;
    for (let j = i; j < content.length; j++) {
      const ch = content[j];
      if (inStr) { if (ch === "\\") j++; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const obj = JSON.parse(content.slice(i, j + 1));
          if (obj && names.has(obj.name)) return { function: { name: obj.name, arguments: obj.parameters || obj.arguments || {} } };
        } catch { /* not the tool-call object — keep scanning */ }
        break;
      }
    }
  }
  return null;
}

async function chatWithTools(initialMessages, onChunk, numCtx, toolDefs = TOOLS, style = DEFAULT_STYLE) {
  const messages = [...initialMessages];
  const maxRounds = parseInt(MAX_TOOL_ROUNDS, 10) || 4;
  // Allow-list of tools actually offered THIS step. Weak/quantized models invent tool names
  // (often mirroring a snake_case token from the prompt). We can't stop them emitting the call,
  // but we refuse to run it AND we never hand back a tool-result that would make the model think
  // the phantom tool is real — see the rejection branch below.
  const validNames = new Set(toolDefs.map((t) => t.function.name));
  const realList = [...validNames].join(", ") || "none";
  const sampler = samplerForStyle(await getSampler(), style, await getStyleTemps()); // DB base + per-style temperature
  for (let round = 0; round < maxRounds; round++) {
    const { content, toolCalls: structured } = await chatRound(messages, toolDefs, onChunk, numCtx, { sampler });
    let toolCalls = structured;
    if (!toolCalls.length) {
      const recovered = parseTextToolCall(content, toolDefs); // model wrote the call as text?
      if (!recovered) { messages.push({ role: "assistant", content }); return content; } // a real answer
      console.log(`  tool (recovered from text): ${recovered.function.name}`);
      toolCalls = [recovered];
      messages.push({ role: "assistant", content: "", tool_calls: toolCalls });
    } else {
      messages.push({ role: "assistant", content, tool_calls: toolCalls });
    }
    for (const call of toolCalls) {
      // Invented tool — don't execute, and DON'T echo a tool-result (that makes the model believe
      // the phantom worked and call it again). Answer the dangling tool_call with an explicit
      // rejection naming the only real tools, so it self-corrects to a valid tool or answers.
      if (!validNames.has(call.function.name)) {
        console.warn(`  rejected invented tool: ${call.function.name} (real: ${realList})`);
        messages.push({ role: "tool", tool_name: call.function.name, content: JSON.stringify({ error: `No tool named "${call.function.name}" exists. The ONLY available tools are: ${realList}. Do not call any other tool — use one of these or answer directly.` }) });
        continue;
      }
      let raw;
      try {
        raw = await executeTool(call.function.name, call.function.arguments || {});
      } catch (err) {
        // A non-retryable web-tool failure (429/auth) arrives here as TerminalError. With
        // WEB_TOOL_FALLBACK on, don't fail the step — satisfy the dangling tool_call, tell the
        // model the tools are gone, and answer in one tool-free round from its own knowledge.
        // (Off → rethrow, which terminal-fails the step. See WEB_TOOL_FALLBACK env note.)
        if (err?.terminal && WEB_TOOL_FALLBACK_ON) {
          console.warn(`  tool ${call.function.name} unavailable (${err.message}) — WEB_TOOL_FALLBACK on: answering tool-free from model knowledge`);
          messages.push({ role: "tool", tool_name: call.function.name, content: JSON.stringify({ error: "web lookup unavailable for this run" }) });
          messages.push({ role: "user", content: "Web lookup is unavailable. Answer the task as best you can from your own knowledge; do not call any tools." });
          const degraded = await chatRound(messages, undefined, onChunk, numCtx, { sampler });
          return degraded.content;
        }
        throw err;
      }
      const result = condenseToolResult(call.function.name, raw);
      const out = JSON.stringify(result);
      console.log(`  tool: ${call.function.name}(${JSON.stringify(call.function.arguments || {})}) → ${out.length} chars`);
      messages.push({ role: "tool", tool_name: call.function.name, content: out });
    }
  }
  const final = await chatRound(messages, undefined, onChunk, numCtx, { sampler }); // round cap → answer tool-free
  return final.content;
}

// Tool-FREE inference: one streamed round with NO tool definitions, so the model can only
// generate text. This is what the PLANNER must use — its job is to EMIT a YAML step plan
// that ASSIGNS tools to steps, not to call tools itself. Passing it executable web_search/
// web_fetch makes weaker models (e.g. Llama 3.1 8B) run tools instead of planning ("garbage").
async function chatNoTools(messages, onChunk, numCtx, style = DEFAULT_STYLE) {
  const sampler = samplerForStyle(await getSampler(), style, await getStyleTemps());
  const { content } = await chatRound(messages, undefined, onChunk, numCtx, { sampler });
  return content;
}

// Apply a step's output style to the resolved sampler: override ONLY `temperature` (the rest stays
// from model_config). CLONE — never mutate the cached sampler object (getSampler returns the shared
// cache). A style with no mapped temperature leaves the base sampler untouched.
function samplerForStyle(baseSampler, style, temps) {
  const t = temperatureForStyle(style, temps);
  return t == null ? baseSampler : { ...baseSampler, temperature: t };
}

// ---- OpenClaw gateway inference ----------------------------
// For gateway tiers the worker talks to OpenClaw's OpenAI-compatible endpoint
// (:18789/v1/chat/completions). OpenClaw runs the tools (web_search/web_fetch) for
// us — we just stream the answer back the same way the generate path does.
async function chatViaOpenClaw(messages, onChunk) {
  const res = await fetch(`${OPENCLAW_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
    },
    body: JSON.stringify({
      model: "openclaw/default",
      messages,
      stream: true,
    }),
  });
  if (!res.ok) throw new Error(`OpenClaw gateway failed: ${res.status} ${res.statusText}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || ""; // keep the trailing partial line
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const piece = JSON.parse(data).choices?.[0]?.delta?.content;
        if (piece) { full += piece; await onChunk(piece, full); }
      } catch { /* keepalive / non-JSON line */ }
    }
  }
  return full;
}

// ---- Chunk flusher -----------------------------------------
// Batches Firestore writes: flushes every 20 chunks or 500ms
function makeChunkFlusher(targetRef) {
  const jobRef = targetRef;
  let pending = "";
  let accumulated = "";
  let timer = null;
  let count = 0;

  async function flush() {
    if (!pending) return;
    // Write only what's safe to show: the marker is withheld mid-stream so a forming
    // "<@@…" never leaks into the live response (see steps/outcome.js).
    const visible = visibleResponse(accumulated);
    pending = "";
    clearTimeout(timer);
    timer = null;
    await fsWrite("stream chunk", () => jobRef.update({ response: visible, updatedAt: FieldValue.serverTimestamp() }));
  }

  return {
    async push(chunk, fullSoFar) {
      pending += chunk;
      accumulated = fullSoFar;
      count++;
      if (count % 20 === 0) {
        await flush();
      } else if (!timer) {
        // Detached flush: NOT awaited, so its promise MUST catch its own errors — an unhandled
        // rejection here is exactly what crashed the worker before. fsWrite already retries
        // transients; a genuinely persistent failure is logged and dropped (the next flush, or the
        // awaited final flush, rewrites state).
        timer = setTimeout(() => {
          flush().catch((e) => console.error(`[worker] background flush failed (non-fatal): ${e.message}`));
        }, 500);
      }
    },
    flush,
  };
}

// ---- Message handler ---------------------------------------
async function handleMessage(message) {
  let payload;
  try {
    payload = JSON.parse(message.data.toString());
  } catch {
    // ACK, do not nack. Nack means "redeliver, a different attempt may succeed" — but JSON.parse fails
    // identically every time, so nacking burned all 50 delivery attempts waking a box per redelivery,
    // and (with dead-lettering unable to forward) looped forever. A deterministic failure must be
    // recorded and dropped, never retried. The payload prefix is logged so the publisher is findable.
    console.error(JSON.stringify({
      message: "[worker] unparseable payload — ACKED and dropped (retrying cannot help)",
      workerEvent: "payload-invalid", messageId: message.id,
      deliveryAttempt: message.deliveryAttempt ?? null,
      payloadPrefix: message.data?.toString?.().slice(0, 200) ?? null,
    }));
    message.ack();
    return;
  }

  const { jobId, query, type = "query", step, unit } = payload;
  // `attempt` rides the message (dispatch.js): 0 on first dispatch, bumped on an orchestrator retry.
  // It is the discriminator that separates a real retry (re-run the same slot) from a stale
  // duplicate delivery of an attempt already finished. Stored on the slot; see admission.js.
  const attempt = Number(payload.attempt) || 0;
  // Orchestrated runs (planner + steps) carry `step` ("plan" | index). The RUN doc id depends
  // on which:
  //   • a numeric step's fanout unit → an ORDERED, zero-padded id `${step}-${unit}` (unitDocId,
  //     from config/models.js — the single source of truth). The doc id IS the order key, so the
  //     UI can stream a visible WINDOW via a documentId() range with no index. `unit` comes from
  //     dispatch; default 0 for a single-unit step. The id is a SLOT: a re-run overwrites it
  //     (idempotent — a Pub/Sub redelivery can't create a duplicate).
  //   • the planner run (step "plan", not a fanout) → keeps the Pub/Sub message id.
  // Legacy one-shot jobs have no `step` and write to the top doc.
  const isRun = step !== undefined && step !== null;
  const runId = !isRun ? null : (typeof step === "number" ? unitDocId(step, unit ?? 0) : message.id);
  payload.runId = runId; // carried into the orchestrate report so the orchestrator finds this run
  console.log(
    `[worker] ← job ${jobId}${isRun ? ` step=${step} run=${runId}` : ""} type=${type} model=${OLLAMA_MODEL} ` +
    `queryLen=${query?.length ?? 0} report=${payload.report ?? "-"} rag=${payload.rag === true || payload.metadata?.rag === true}`
  );

  const db = getFirestoreClient();
  // A RUN streams into steps/{runId} (uniform shape) — runId is the ordered `${step}-${unit}` slot
  // for a numeric step, or the Pub/Sub message id for the planner. Legacy one-shot jobs stream
  // into the top doc.
  const parentRef = db.collection("llmResults").doc(jobId);
  const jobRef = isRun
    ? parentRef.collection("steps").doc(runId)
    : parentRef;

  try {
    // Stamp companyId + userId on every RUN doc so children are company-scoped (access control:
    // you can't see another company's data) and traceable to the user who launched the job. The
    // planner message carries them; step messages don't, so fall back to the parent job doc.
    let companyId = payload.companyId ?? null;
    let userId = payload.userId ?? null;
    if (isRun && (companyId === null || userId === null)) {
      const j = (await parentRef.get()).data() || {};
      companyId = companyId ?? j.companyId ?? null;
      userId = userId ?? j.userId ?? null;
    }

    // First write CREATES (or reuses) the run doc. Uniform shape across the planner run and every
    // step run. `deletedAt: null` clears any prior soft-delete marker when a re-run reuses an
    // ordered slot id, so a resurrected slot doesn't keep a stale deletedAt.
    //
    // CRUCIAL: this is a re-entry point. A transient "fetch failed" nacks (see the catch) and
    // Pub/Sub redelivers the SAME message into the SAME slot — so a prior attempt may have left
    // `outcome`/`completedAt` set from when it wrote status:"fail". Because this is a merge, we
    // MUST clear those failure fields when we set status back to "running"; otherwise the doc
    // holds the old attempt's outcome alongside the new attempt's running status, and the UI
    // shows "fetch failed" + "Running" at once. Invariant: running ⇒ no outcome.
    //
    // `createdAt` is the SEND time and must be stamped ONCE — never re-stamped on a retry. A
    // redelivered "fetch failed" re-enters this same slot; if we reset createdAt here, the prior
    // attempt's `updatedAt` is now OLDER than the new createdAt, so runtime (updatedAt − createdAt)
    // goes negative and renders as a bogus "0.0s". So we only set createdAt when the doc doesn't
    // already have one; runtime then measures from the original send across every retry.
    // LEASELESS receive: in ONE transaction, decide whether to run (shouldRun) and, if so, mark the
    // slot `running` for THIS attempt — atomic so a stale attempt can't slip between read and write.
    // No lease, no holder: shouldRun skips only a slot already TERMINAL for this attempt or one OWNED
    // by a NEWER attempt (a retry that overtook us). A `running` slot is NOT a skip — a redelivery
    // after a crash must be able to take it over (the dead worker holds nothing). A concurrent
    // same-attempt duplicate is allowed too; the completion CAS dedups the write. The running mark
    // clears the prior attempt's failure fields (running ⇒ no outcome) and stamps createdAt ONCE so
    // runtime (updatedAt − createdAt) measures from the original send across retries.
    let willRun = false;
    await fsWrite("receive claim", () => db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef);
      const slot = snap.exists ? snap.data() : undefined;
      willRun = shouldRun(slot, attempt);
      if (!willRun) return;
      const claim = isRun
        ? { step, attempt, companyId, userId, status: "running", outcome: null, completedAt: null, isDeleted: false, deletedAt: null }
        : { attempt, status: "running", outcome: null, completedAt: null };
      if (!snap.exists || snap.get("createdAt") == null) claim.createdAt = FieldValue.serverTimestamp();
      tx.set(jobRef, claim, { merge: true });
    }));
    if (!willRun) {
      console.log(`[worker] ⤳ already terminal/superseded — skipping (acked): ${jobId}${isRun ? ` step=${step} run=${runId} attempt=${attempt}` : ""}`);
      message.ack();
      return;
    }

    // RAG is an OPTIONAL augmentation — it must never break a plain query.
    // Default: just send the query. If a request opts in (metadata.rag) we try to
    // augment, but missing/failed RAG is NOT fatal — we log and send the query as-is.
    let context = "";
    if (payload.rag === true || payload.metadata?.rag === true) {
      try {
        context = await retrieveContext(query);
        console.log(`  RAG: ${parseInt(RAG_TOP_K)} chunks retrieved`);
      } catch (e) {
        console.warn(`  RAG unavailable (${e.message}) — sending query without context`);
      }
    } else {
      console.log("  RAG: not requested");
    }

    // Dispatch by message type through the builder lookup table — each type builds its own
    // prompt+data in isolation; the handler doesn't branch on type and types don't cross over.
    // ── DEBUG 1: which path (builder) this message takes ──
    const path = MESSAGE_BUILDERS[type] ? `${type} builder` : "standard builder";
    console.log(`[worker]   ${jobId} PATH → ${path} (type=${type})`);

    const messages = await builderFor(type)(payload, context);

    // ── DEBUG 2: the exact prompt that was built (system + user, role-labelled) ──
    const promptDump = messages.map((m) => `--- [${m.role}] (${m.content.length} chars) ---\n${m.content}`).join("\n\n");
    console.log(`[worker]   ${jobId} PROMPT BUILT:\n${promptDump}\n[worker]   ${jobId} END PROMPT`);
    // Record both: `message` = the user content (the input), `prompt` = the full assembled
    // prompt (system + user) actually sent. `response` is written on completion below.
    const userMessage = messages.find((m) => m.role === "user")?.content ?? "";
    await fsWrite("input meta", () => jobRef.update({ message: userMessage, prompt: messages.map((m) => m.content).join("\n\n") }));

    // Size the context window to THIS prompt (+ output reserve), capped by the model's max.
    // Too big → TerminalError → fail WITHOUT retrying (see the catch). The gateway path ignores
    // num_ctx (OpenClaw manages it), but we still size first to fail-fast on impossible requests.
    // TWO ceilings, and the request may not exceed either. `ctx` is what the MODEL supports;
    // maxCtxFor is what THIS CARD holds once the KV cache is multiplied by the slot count (Ollama
    // allocates num_ctx per slot). Without the machine ceiling a big prompt at 3 slots asks for more
    // VRAM than exists and the load OOMs — so cap here, before the window is ever requested.
    const vramCap = maxCtxFor(MODEL_DEF, GEN_LIMIT, GPU_VRAM_GB);
    const hardCap = MODEL_MAX_CTX ? Math.min(MODEL_MAX_CTX, vramCap) : vramCap;
    const numCtx = sizeNumCtx({
      messages,
      modelMaxCtx: hardCap,
      outputReserve: parseInt(OUTPUT_RESERVE_TOKENS, 10),
      floor: parseInt(OLLAMA_NUM_CTX, 10),
    });
    console.log(`  num_ctx=${numCtx} (cap ${hardCap} = min(model ${MODEL_MAX_CTX ?? "unknown"}, vram ${vramCap} @ ${GEN_LIMIT} slot(s) of ${GPU_VRAM_GB}GB), output reserve ${OUTPUT_RESERVE_TOKENS})`);

    // The PLANNER never gets executable tools (it ASSIGNS tools to steps; giving it web_search/
    // web_fetch makes it run tools instead of emitting the plan). A domain step gets ONLY the tools
    // the planner assigned it (def.tools, carried in the message), intersected with what the worker
    // implements — so a step the planner gave no tools runs TOOL-FREE. The planner decides per step
    // from the tools list's descriptions; we just honor its choice. (Gateway/OpenClaw tiers always
    // expose tools, regardless.)
    const flusher = makeChunkFlusher(jobRef);
    const useGateway = GATEWAY === "openclaw";
    // Load the actual tool DEFINITION for each name the step was assigned, IN the order given.
    // An entry may be a plain name ("web_search") or an object ({name:"web_search"}) depending on
    // how the planner's YAML parsed — normalize to the name first. Empty list → no tools (tool-free
    // step, allowed). A name with NO matching definition is dropped LOUDLY (not silently) so a
    // planner/worker tool-name mismatch surfaces instead of looking like "no tools assigned".
    const toolByName = new Map(TOOLS.map((t) => [t.function.name, t]));
    const named = (payload.tools || []).map((n) => (typeof n === "string" ? n : n?.name)).filter(Boolean);
    const assignedTools = named.map((n) => toolByName.get(n)).filter(Boolean);
    const missing = named.filter((n) => !toolByName.has(n));
    if (missing.length) console.warn(`[worker]   ${jobId} assigned tool(s) with NO matching definition — dropped: ${missing.join(", ")} (have: ${[...toolByName.keys()].join(", ")})`);
    const allowTools = type !== "planner" && assignedTools.length > 0;
    if (useGateway && type === "planner") {
      // OpenClaw always exposes its tools, so a planner shouldn't run on a gateway tier.
      console.warn(`[worker]   ${jobId} planner on a GATEWAY tier — OpenClaw still offers tools; route the planner to a raw model topic.`);
    }
    // Output style (structured | blended | unstructured) rides the step's dispatch payload, same as
    // `tools`. The worker maps it to a temperature (DB model_config `_styles`, code fallback), overriding
    // only the sampler's temperature for this request. Default structured — every pipeline step is
    // structured unless its plan def says otherwise. The generic `query`/chat path is unstructured.
    const genStyle = payload.style || (type === "query" ? "unstructured" : DEFAULT_STYLE);
    console.log(`  Inference: ${useGateway ? "OpenClaw gateway" : "Ollama chat"} (tools ${allowTools ? `on [${assignedTools.map((t) => t.function.name).join(",")}]` : "off"}, style=${genStyle} → temp=${temperatureForStyle(genStyle, await getStyleTemps())})`);
    // Run the generation behind the in-process gate so we never run more concurrent generations
    // than Ollama has run-slots (excess queues here while its lease auto-extends). release() in a
    // `finally` so a throw still frees the slot; correctness across workers stays in the CAS below.
    let fullResponse;
    if (FAKE_ONLY || payload.fake) {
      // The fake worker (FAKE_ONLY) cans EVERYTHING routed to it — it's a first-class model, so
      // picking it and sending works like any tier, no fake flag needed. (payload.fake still honored
      // for the orchestrator's per-step fake dispatch.) No model, no generation gate, no delay:
      // return canned output by subtype and stream it through the SAME flusher → Firestore path.
      // The planner carries no subtype (type="planner"); fall back to type so it gets a canned
      // PLAN (a valid YAML step list) instead of the generic stub — otherwise build.js rejects it.
      const cannedKey = payload.subtype || payload.type;
      fullResponse = cannedResponse(cannedKey, payload);
      flusher.push(fullResponse);
      await flusher.flush();
      console.log(`[worker]   ${jobId} FAKE canned response (key=${cannedKey}, ${fullResponse.length} chars)`);
    } else {
      if (genGate.waiting > 0 || genGate.active >= genGate.max) {
        console.log(`[worker]   ${jobId} waiting for a generation slot (${genGate.active}/${genGate.max} busy, ${genGate.waiting} queued)`);
      }
      const releaseGen = await genGate.acquire();
      try {
        // Heartbeat wrapper: the console is otherwise silent from "Inference:" until END OUTPUT —
        // time-to-first-token marks the end of prompt eval, then a throttled progress line.
        const t0 = Date.now();
        let lastBeat = 0;
        const push = (piece, full) => {
          const now = Date.now();
          if (!lastBeat) { lastBeat = now; console.log(`[worker]   ${jobId} first token after ${((now - t0) / 1000).toFixed(1)}s`); }
          else if (now - lastBeat > 2000) { lastBeat = now; console.log(`[worker]   ${jobId} generating… ${full.length} chars`); }
          return flusher.push(piece, full);
        };
        fullResponse = useGateway
          ? await chatViaOpenClaw(messages, push)
          : allowTools
            ? await chatWithTools(messages, push, numCtx, assignedTools, genStyle)
            : await chatNoTools(messages, push, numCtx, genStyle);
        await flusher.flush();
      } finally {
        releaseGen();
      }
    }

    // ── DEBUG 3: the final output the model produced ──
    console.log(`[worker]   ${jobId} OUTPUT (${fullResponse?.length ?? 0} chars):\n${fullResponse}\n[worker]   ${jobId} END OUTPUT`);

    // Pull the status block (@@::PASS::@@ / @@::FAIL:reason::@@) OUT of the output, and keep
    // the marker out of the visible `response`. Terminal status is one of just two: PASS → success,
    // FAIL → fail. The FAIL reason goes in `outcome` (success has no reason → null). The orchestrator
    // gets the status + outcome in the report below so it can decide success → advance / fail → stop.
    const { status: blockStatus, reason, clean, thinking } = splitOutcome(fullResponse);
    let runStatus = blockStatus === "FAIL" ? "fail" : "success"; // PASS or no block → success
    let outcome = runStatus === "fail" ? reason : null;          // outcome carries the failure reason only

    const formatted = formatRecipeYaml(runStatus, payload, clean, parseYamlBlock, outcome);
    runStatus = formatted.runStatus;
    let finalResponse = formatted.finalResponse;
    outcome = formatted.outcome;

    payload.runStatus = runStatus;                                 // carried into the orchestrate report
    payload.outcome = outcome;
    // P1: NAME THE MARKER, not just the verdict. `PASS` and NO BLOCK AT ALL both map to success
    // (line 978), so a model that answered correctly and one that stopped mid-sentence logged the
    // identical "→ success". That equivalence is a deliberate contract, but silently applying it
    // makes a truncated or non-conforming answer indistinguishable from a good one — which is how a
    // courses unit shipped a 9-cell row as "success" and only surfaced two steps later. Say which
    // it was, and say which step/unit it was, so a bad unit is identifiable from the log alone.
    const markerNote = blockStatus === null ? "NO STATUS BLOCK → treated as success" : `marker=${blockStatus}`;
    console.log(
      `[worker]   ${jobId} step=${payload.step ?? "?"} unit=${payload.unit ?? "?"} ` +
      `→ ${runStatus} (${markerNote}, ${String(finalResponse ?? "").length}c)${outcome ? ` reason="${outcome}"` : ""}`,
    );

    // Completion = first-writer-wins CAS (docs/design/worker-dispatch.md). In a transaction,
    // completionWrite returns null if this slot is already terminal for this/a newer attempt, or
    // owned by a newer attempt — so a duplicate concurrent run, or a stale older-attempt completion,
    // never clobbers the winner. Results live in Firestore only (clients react via onSnapshot;
    // Mongo is RAG-only). `updatedAt` is bumped so runtime = updatedAt − createdAt is end-to-end.

    let wrote = false;
    await fsWrite("result", () => db.runTransaction(async (tx) => {
      const slot = (await tx.get(jobRef)).data();
      const w = completionWrite(slot, { attempt, status: runStatus, response: finalResponse, outcome, thinking });
      wrote = !!w;
      if (!w) return;
      tx.set(jobRef, {
        status: w.status, response: w.response, outcome: w.outcome ?? null, thinking: w.thinking ?? "", attempt: w.attempt,
        updatedAt: FieldValue.serverTimestamp(), completedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }));

    // Only the WINNER reports — a lost race means another run already told the orchestrator.
    if (wrote) {
      await reportToOrchestrator(payload);
      // DONE signal → capacity outcome event to the orchestrator for EVERY job type (queries included),
      // both success AND fail. The orchestrator records it (success → ok + re-decide; fail → log only) —
      // the worker no longer writes the scoreboard itself. Never blocks ack.
      await publishOutcome(payload);
      message.ack();
      console.log(`[worker] ✓ acked ${jobId} (status=${runStatus})`);
    } else {
      message.ack();
      console.log(`[worker] ⤳ completion no-op (superseded/duplicate) — acked: ${jobId}${isRun ? ` run=${runId} attempt=${attempt}` : ""}`);
    }
  } catch (err) {
    // Classify so the failure is debuggable at a glance, and name WHICH run failed (step+unit) +
    // its type — a bare "FAILED job <id>" forced reading the whole transcript to find the context.
    const where = isRun ? ` step=${step} run=${runId}` : "";
    const kind = err?.terminal ? "TERMINAL" : /stall|abort/i.test(err.message || "") ? "STALL" : "ERROR";
    console.error(`[worker] ✗ FAILED (${kind}) job ${jobId}${where} type=${type}: ${err.message}`);
    // "fetch failed" is undici's generic wrapper — the REAL reason (UND_ERR_HEADERS_TIMEOUT /
    // UND_ERR_BODY_TIMEOUT = timeout, ECONNRESET = Ollama dropped the connection, etc.) lives
    // on err.cause. Log it so failures aren't a mystery.
    if (err?.cause) console.error(`[worker]   ${jobId} cause:`, err.cause?.code || err.cause?.message || err.cause);
    // error / abort / crash all end the same: status `fail`, with the message in `outcome` (the
    // single field that says WHY it ended). Written through the SAME first-writer-wins CAS so a
    // superseded or stale-attempt failure can't clobber a newer attempt that overtook this run.
    let wroteFail = false;
    await fsWrite("fail status", () => db.runTransaction(async (tx) => {
      const slot = (await tx.get(jobRef)).data();
      const w = completionWrite(slot, { attempt, status: "fail", response: slot?.response ?? "", outcome: err.message });
      wroteFail = !!w;
      if (!w) return;
      tx.set(jobRef, { status: "fail", outcome: err.message, attempt: w.attempt, updatedAt: FieldValue.serverTimestamp(), completedAt: FieldValue.serverTimestamp() }, { merge: true });
    })).catch((e) => console.error(`[worker] ✗ PERSISTENT WRITE FAILURE writing fail-status for ${jobId}: ${e.message}`));
    // Tell the orchestrator we FAILED so its retry → pass-through logic engages — but ONLY if we
    // actually wrote the failure (a superseded run's failure is not ours to report; the owning
    // attempt will). An INFRASTRUCTURE failure (stall/abort/timeout/crash) must drive the auto-flow
    // exactly like a content FAIL (`@@::FAIL::@@`) so the cursor moves and the job never wedges.
    if (wroteFail) {
      payload.runStatus = "fail";
      payload.outcome = err.message;
      await reportToOrchestrator(payload).catch((e) => console.error(`[worker]   ${jobId} fail-report error:`, e?.message || e));
    }
    // ALWAYS ack — never nack. Nacking redelivers the SAME (often slow/poison) message forever —
    // that loop is exactly what wedged the worker for 31 minutes. Re-dispatch is the ORCHESTRATOR's
    // job (a fresh message from dispatchStep on retry), not Pub/Sub redelivery of this one.
    message.ack();
    console.log(`[worker] ⤳ failed (acked${wroteFail ? "; orchestrator notified → retry/pass-through" : "; superseded — not reported"}): ${jobId}`);
  }
}

// ---- Main --------------------------------------------------
async function main() {
  // Startup ENV dump → Cloud Logging (this container runs with --log-driver=gcplogs). We keep
  // hitting config drift between dev and prod (NODE_ENV, OLLAMA_NUM_PARALLEL, SUBSCRIPTION_NAME,
  // OLLAMA_NUM_PARALLEL), so log the full env at boot — but REDACT secret-looking values
  // (URI/KEY/TOKEN/SECRET/PASS/CRED/AUTH/MONGO) to their length so credentials never hit the logs.
  // One line per var, each prefixed `DBG `: logd splits an ingest body on newlines, so one
  // multi-line log became ~200 INFO records. The head token puts the whole dump below logd's
  // default floor until LOGD_MIN_LEVEL=debug.
  const SECRET_RE = /(KEY|TOKEN|SECRET|PASS|CRED|AUTH|MONGO|URI|PASSWORD)/i;
  console.log(`DBG [worker] ENV dump (IS_PROD=${IS_PROD}):`);
  for (const k of Object.keys(process.env).sort()) {
    console.log(`DBG   ${k}=${SECRET_RE.test(k) ? (process.env[k] ? `<redacted:${process.env[k].length}>` : "") : process.env[k]}`);
  }

  await connectMongo();

  const pubsub = new PubSub({ projectId: GCP_PROJECT_ID });

  // The lease size IS the generation slot count — see worker/lease.js for why these were ever two
  // numbers and what it cost. maxExtensionMinutes keeps the lease auto-refreshed (up to 60 min) so a
  // long generation is never redelivered mid-run.
  // NEVER lease more messages than we can actually GENERATE. maxMessages defaulted to 2 in prod while
  // GEN_LIMIT (OLLAMA_NUM_PARALLEL) is 1, so a box leased a second message it could not start. That
  // message was then: invisible to every other box (leased, with the deadline auto-extended up to 60
  // min), and lost the moment this box was torn down — which is how a backlog of >1 left a message
  // sitting in the queue that nothing ever picked up. It also made an idle box look busy to Pub/Sub,
  // holding a lease while generating nothing.
  const maxMessages = GEN_LIMIT;   // one number, one source of truth (worker/lease.js)
  console.log(`  Flow control: maxMessages=${maxMessages} (= generation slots, OLLAMA_NUM_PARALLEL=${process.env.OLLAMA_NUM_PARALLEL ?? "unset"}), maxExtensionMinutes=60`);
  if (process.env.MAX_CONCURRENCY) {
    console.warn(`  \u26a0 MAX_CONCURRENCY=${process.env.MAX_CONCURRENCY} is IGNORED — lease size is OLLAMA_NUM_PARALLEL (${GEN_LIMIT}); a second knob is how the two drifted apart`);
  }

  // Split a comma list into individual names, but do NOT trim/normalize: each name is a
  // SUBSCRIPTION_NAME is a single subscription id — one model, one sub. The split keeps the
  // loop uniform so the fake sub (appended below in non-prod) uses the same path without a
  // special case. Pass the value verbatim; "cleaning" it would mask upstream config bugs.
  const subscriptionNames = SUBSCRIPTION_NAME.split(',');
  // A real worker joins the shared fake/canned subscription ONLY when asked (DRAIN_FAKE=1), for a
  // dev box running no dedicated fake worker. It must never be the default: with the dedicated fake
  // worker up, every real worker was a second subscriber on the same subscription, so one message
  // got delivered to two workers — two models answering it, the loser logged as
  // "completion no-op (superseded/duplicate)".
  if (!IS_PROD && process.env.DRAIN_FAKE === '1' && !subscriptionNames.includes(FAKE_SUBSCRIPTION)) {
    subscriptionNames.push(FAKE_SUBSCRIPTION);
  }

  // Idle self-shutdown: in prod the worker deletes its own MIG instance after IDLE_SHUTDOWN_MS with
  // no in-flight jobs (default 60s), so an idle GPU box stops billing without waiting on the
  // autoscaler's laggy (3–5 min) backlog metric. Disabled in dev — there's no MIG/metadata to
  // delete, and the waker owns the local container lifecycle.
  const idleMs = parseInt(process.env.IDLE_SHUTDOWN_MS, 10) || 60000;
  const idle = IS_PROD
    ? makeIdleShutdown({ idleMs, onIdle: () => selfDeleteFromMig(console) })
    : { onStart: () => Date.now(), onFinish: () => {}, armInitial: () => {}, isShuttingDown: () => false, inFlight: () => 0 };
  console.log(`  Idle shutdown: ${IS_PROD ? `${idleMs}ms` : "disabled (dev)"}`);

  // One structured line per transport event so "why did this box stop working" is answerable from the
  // log stream instead of inferred. `workerEvent` is the field to filter on.
  // The console method name is not a log level: logd reads severity from the payload, and once logship
  // merges stdout and stderr there is nothing else left to recover it from.
  const tlog = (event, subName, extra = {}, level = "log") => console[level](JSON.stringify({
    level: level === "log" ? "info" : level,
    message: `[worker/transport] ${event} ${subName}${extra.detail ? ` — ${extra.detail}` : ""}`,
    workerEvent: event, subscription: subName, ...extra,
  }));

  // Reopen-on-close lives in worker/reopen.js so a fake subscription can drive it in a test — the
  // emulator cannot force a stream closed, so this behaviour was otherwise only observable in prod.
  const loop = makeSubscriberLoop({
    open: (name) => pubsub.subscription(name, { flowControl: { maxMessages, maxExtensionMinutes: 60 } }),
    log: (event, name, extra, level) => tlog(event, name, extra, level),
    onGiveUp: (name, attempt) => {
      // The container runs with `--restart=always` (deploy.js), so exiting restarts the worker in place
      // within seconds — a fresh process on the same warm VM, not a ~90s MIG replacement. That is why
      // giving up is cheap. inFlight is logged because exiting drops whatever was generating; those
      // messages come back by redelivery rather than being lost.
      tlog("exiting", name, { attempt, inFlight: idle.inFlight?.() ?? null,
        detail: "--restart=always brings the worker straight back" }, "error");
      process.exit(1);
    },
    // A received `message` IS the success path (handleMessage logs "[worker] ← job …"). The wrapper
    // brackets every delivery with the idle-shutdown timer: onStart clears it (work arrived), and
    // onFinish in `finally` re-arms it on EVERY exit path (ack, nack, or a thrown handler) so a failed
    // job can never leave the worker alive-but-idle forever.
    onMessage: (m, subName) => {
      let jobId = m.id;
      try { jobId = JSON.parse(m.data.toString())?.jobId ?? m.id; } catch { /* keep m.id */ }
      // The self-delete is already requested — taking this job would destroy it mid-flight. Hand it
      // straight back so a live box gets it now, instead of after an ack-deadline timeout.
      if (idle.isShuttingDown?.()) {
        tlog("declined-shutting-down", subName, { jobId, detail: "self-delete already requested; nacked for another box" }, "warn");
        m.nack();
        return;
      }
      const startedAt = idle.onStart(jobId);
      Promise.resolve()
        .then(() => handleMessage(m))
        .catch((e) => console.error(`[worker] handler threw (kept alive): ${e?.stack || e?.message || e}`))
        .finally(() => idle.onFinish(jobId, startedAt));
    },
  });

  for (const subName of subscriptionNames) loop.listen(subName);

  idle.armInitial(); // a worker that boots and never receives a job still shuts down after idleMs
  console.log(`Model: ${OLLAMA_MODEL} @ ${OLLAMA_HOST}\n`);
}

// Consumer-level backstop: a long-lived Pub/Sub worker must NEVER die on a stray async rejection
// (a detached promise nobody awaited — exactly what the timer-driven Firestore flush was). Real
// failures are handled where they happen (fsWrite retries transients; handleMessage's try/catch
// fails the job + acks). This only catches a programmer slip so one escaped rejection LOGS instead
// of taking the whole consumer down. A backstop, not a license to skip handling errors.
process.on("unhandledRejection", (reason) => {
  console.error("[worker] ✗ UNHANDLED REJECTION (kept alive):", reason?.stack || reason?.message || reason);
});

// ---- Lifecycle instrumentation (debug why the worker stops) ----------------
// Log every way this process can end, with pid + timestamp, so a mid-run stop is never a mystery.
// Which line prints tells us the cause: a signal (who killed us), beforeExit (event loop drained —
// nothing kept us alive), or exit (final code). Temporary diagnostic.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"]) {
  process.on(sig, () => {
    console.error(`[worker] ⚠ received ${sig} at ${new Date().toISOString()} (pid ${process.pid}) — stack:\n${new Error().stack}`);
    process.exit(0);
  });
}
process.on("beforeExit", (code) => console.error(`[worker] ⚠ beforeExit code=${code} at ${new Date().toISOString()} (event loop DRAINED — nothing kept the process alive) pid=${process.pid}`));
process.on("exit", (code) => console.error(`[worker] ⚠ exit code=${code} at ${new Date().toISOString()} pid=${process.pid}`));

main().catch((err) => {
  console.error("Worker failed to start:", err.message);
  process.exit(1);
});
