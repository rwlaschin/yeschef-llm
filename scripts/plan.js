// scripts/plan.js — FAST planner-prompt iteration loop.
//
// The planner normally runs as a full job: publish → waker poll → docker container → CPU Ollama →
// Firestore → cascade. That round-trip is why one plan takes ~11 minutes, and almost none of it is
// the prompt. This script throws ALL of that away. It assembles the EXACT same planner messages the
// worker builds (reuses worker/steps/planner.js + config/models.js, reads the live prompt_library /
// llmtools / model_config from Mongo), calls Ollama once, and prints the plan with a per-step audit
// of the two things that keep breaking: `subtype` and `contexts`.
//
// Two speedups stack:
//   1. No pipeline — no pub/sub, no waker, no docker, no Firestore, no cascade.
//   2. Point it at NATIVE host Ollama (GPU/Metal), not the CPU docker container. The M4 GPU is
//      available to `ollama serve` on the host — only Docker can't see it. Same model, GPU instead
//      of CPU. One-time: `ollama pull llama3.1:8b` so the host has the model.
//
// Usage:
//   node scripts/plan.js "Plan two weeks of dinners for a gluten-free family of four"
//   PLAN_MODEL=llama3.1:8b PLAN_OLLAMA_HOST=http://localhost:11434 node scripts/plan.js "<query>"
//   PLAN_TOPIC=llama3_1_8b_v1 node scripts/plan.js "<query>"     # which model topic the steps target
//
// Env (falls back to the worker's .env via dotenv-flow):
//   PLAN_OLLAMA_HOST  Ollama base url        (default http://localhost:11434 — native host = GPU)
//   PLAN_MODEL        model to run           (default: real model for PLAN_TOPIC, e.g. llama3.1:8b)
//   PLAN_TOPIC        model TOPIC for steps  (default llama3_1_8b_v1 — only shown in the prompt)
//   PLAN_NUM_CTX      context window         (default 16384)
//   MONGO_URI/MONGO_DB                        (from .env.dev, same as the worker)

import dotenvFlow from "dotenv-flow";
// Match `npm run dev` (cross-env NODE_ENV=dev) so .env.dev loads by default.
dotenvFlow.config({ node_env: process.env.NODE_ENV || "dev" });

import { MongoClient } from "mongodb";
import { buildPlannerMessages } from "../worker/steps/planner.js";
import { SUBTYPES, DEFAULT_TOOLS, byTopic, defaultSampler } from "../config/models.js";

const {
  MONGO_URI,
  MONGO_DB = "yeschef",
  PLAN_OLLAMA_HOST = "http://localhost:11434",
  PLAN_TOPIC = "llama3_1_8b_v1",
  PLAN_NUM_CTX = "16384",
} = process.env;

const TOPIC = PLAN_TOPIC;
const MODEL = process.env.PLAN_MODEL || byTopic(TOPIC)?.model || "llama3.1:8b";
const query = process.argv.slice(2).join(" ").trim();

if (!query) {
  console.error('Usage: node scripts/plan.js "<your planning request>"');
  process.exit(1);
}
if (!MONGO_URI) {
  console.error("MONGO_URI not set (expected from .env.dev). Cannot read the planner prompt.");
  process.exit(1);
}

// ── Same prompt assembly the worker uses (mirrors worker/index.js helpers) ──────────────────────
const mongo = new MongoClient(MONGO_URI);

// toolLine: identical to worker/index.js — DB tools store schema in `definition`, defaults use {name,description}.
const toolLine = (t) => {
  const fn = t.definition?.function || t.definition || {};
  return `- ${fn.name || t.name || "unknown"}: ${fn.description || t.description || ""}`;
};

async function makeDeps(db) {
  const prompts = await db.collection("prompt_library").find({ isDeleted: { $ne: true } }).toArray();
  const dbTools = await db.collection("llmtools").find({ isDeleted: { $ne: true } }).toArray();
  // sampler: defaultSampler() → model_config `_default` doc → per-model doc (later wins), same as worker.
  const cfg = await db.collection("model_config").find({ _id: { $in: ["_default", MODEL] } }).toArray();
  const params = Object.fromEntries(cfg.map((d) => [d._id, d.params || {}]));
  const sampler = { ...defaultSampler(), ...(params._default || {}), ...(params[MODEL] || {}) };

  const systemPromptFor = async (type) =>
    prompts
      .filter((p) => p.mapping && p.mapping[type] != null)
      .sort((a, b) => { const x = String(a.mapping[type]), y = String(b.mapping[type]); return x < y ? -1 : x > y ? 1 : 0; })
      .map((p) => p.content)
      .filter(Boolean)
      .map((c) => c.replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1"))
      .join("\n\n");

  const getTools = async () => (dbTools.length ? dbTools : DEFAULT_TOOLS).map(toolLine).join("\n");
  const getSubtypes = async () => SUBTYPES.map((s) => `- ${s.name}: ${s.description}`).join("\n");

  return { deps: { systemPromptFor, getTools, getSubtypes }, sampler, promptCount: prompts.length };
}

// ── Plan inspection ─────────────────────────────────────────────────────────────────────────────
const unfence = (text) => { const m = String(text).match(/```(?:yaml)?\s*([\s\S]*?)```/i); return (m ? m[1] : text).trim(); };
const VALID_SUBTYPES = new Set(SUBTYPES.map((s) => s.name));
const VALID_TOOLS = new Set(DEFAULT_TOOLS.map((t) => t.name));

async function auditPlan(rawYaml) {
  let parse;
  try { ({ parse } = await import("yaml")); } catch { /* yaml not at root — fall back to raw only */ }
  if (!parse) { console.log("\n(install `yaml` at the repo root for the parsed per-step audit)"); return; }

  let plan;
  try { plan = parse(rawYaml); } catch (e) { console.log(`\n⚠️  YAML parse failed: ${e.message}`); return; }
  if (!Array.isArray(plan)) { console.log("\n⚠️  Plan is not a YAML list."); return; }

  console.log(`\n── Per-step audit (${plan.length} step${plan.length === 1 ? "" : "s"}) ─────────────────────────────`);
  let bad = 0;
  plan.forEach((s, i) => {
    const subtype = s?.subtype;
    const tools = Array.isArray(s?.tools) ? s.tools : [];
    const contexts = Array.isArray(s?.contexts) ? s.contexts : (s?.contexts != null ? [s.contexts] : []);
    const flags = [];
    if (!VALID_SUBTYPES.has(subtype)) {
      flags.push(VALID_TOOLS.has(subtype) ? `✗ subtype="${subtype}" is a TOOL, not a subtype` : `✗ unknown subtype="${subtype}"`);
      bad++;
    }
    // contexts naming a prior step are the point of multi-step plans; lone [] or [0] on a late step is the recurring bug.
    if (i > 0 && contexts.length <= 1) flags.push(`· contexts=${JSON.stringify(contexts)} (only ${contexts.length} — expected to pull more on a later step?)`);
    const tail = flags.length ? "   " + flags.join("  ") : "";
    console.log(`  [${i}] subtype=${String(subtype).padEnd(12)} kind=${String(s?.kind ?? "").padEnd(11)} tools=${JSON.stringify(tools).padEnd(20)} contexts=${JSON.stringify(contexts)}${tail}`);
  });
  console.log(bad ? `\n${bad} step(s) have an invalid subtype.` : `\nAll subtypes valid.`);
}

// ── Run ─────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  const t0 = Date.now();
  await mongo.connect();
  const db = mongo.db(MONGO_DB);
  const { deps, sampler, promptCount } = await makeDeps(db);

  const payload = { model: TOPIC, query, type: "planner" };
  const messages = await buildPlannerMessages(payload, "", deps);

  console.error(`▸ model=${MODEL}  host=${PLAN_OLLAMA_HOST}  topic=${TOPIC}  prompts_loaded=${promptCount}  num_ctx=${PLAN_NUM_CTX}`);
  console.error(`▸ query: ${query}\n`);

  const res = await fetch(`${PLAN_OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false, // planner runs tool-free; one shot, no streaming needed for iteration
      options: { ...sampler, num_ctx: parseInt(PLAN_NUM_CTX, 10), num_predict: parseInt(process.env.OLLAMA_NUM_PREDICT || "-1", 10) },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`Ollama /api/chat failed: ${res.status} ${res.statusText}\n${body}`);
    console.error(`\nIf this is a 404 "model not found": the host Ollama doesn't have ${MODEL} yet → \`ollama pull ${MODEL}\``);
    await mongo.close();
    process.exit(1);
  }
  const data = await res.json();
  const raw = data.message?.content ?? "";
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(unfence(raw));
  await auditPlan(unfence(raw));
  console.log(`\n⏱  ${secs}s total (model ${MODEL} @ ${PLAN_OLLAMA_HOST})`);
  await mongo.close();
})().catch(async (e) => { console.error(e); try { await mongo.close(); } catch {} process.exit(1); });
