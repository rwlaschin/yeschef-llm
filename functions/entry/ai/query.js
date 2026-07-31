// POST /ai/query — single-shot LLM query for the chat copilot (Ask Remy, AI field-suggest).
// The orchestrator is the SINGLE dispatch authority: it owns topic selection, so yeschef
// (the Next app) never hardcodes topic names and can't drift. Writes llmResults/{jobId};
// the worker streams the reply back into that doc; the client reads it via onSnapshot.
import { randomUUID } from "crypto";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { PubSub } from "@google-cloud/pubsub";
import { MODELS, FAKE_TOPIC, byTopic } from "../../config/models.js";
import { isProdLike } from "./capacity/actuate.js";

let _pubsub;
const pubsub = () => (_pubsub ??= new PubSub({ projectId: process.env.GCP_PROJECT_ID }));

// Default query tier = the cheapest gpu:1 model, every env. In prod that's the cost model's
// "LLM Worker — Q&A / Remy" line: g2-standard-8 (1× L4, on-demand) — Remy does NOT default to
// the 2×L4 70B tier, a separate (~3×) line item. Topic names live HERE (config/models.js is
// the single source of truth) — callers never HAVE to name a topic, but may pass `model`
// (a topic) to override, e.g. to send one query to the 70B; see resolveTopic.
const DEFAULT_QUERY_TOPIC = (MODELS.find((m) => m.dev) || MODELS[0]).topic;

// Requested topic → the topic to dispatch to, or null if the request is invalid here:
// unknown topic, or a prod-only (gpu:2) tier outside production, where it isn't provisioned.
export function resolveTopic(requested) {
  if (!requested) return DEFAULT_QUERY_TOPIC;
  const m = byTopic(requested);
  if (!m || (!isProdLike() && !m.dev)) return null;
  return m.topic;
}

// Message TYPE for the copilot = "task", NOT "query": the prompt_library maps the heavy
// menu/recipe/order-form OUTPUT TEMPLATE onto "query", which would prepend ~8k tokens of
// YAML schema to every chat turn. "task" has no mapped system prompt → a lightweight,
// general single-shot answer (worker falls through to buildStandardMessages either way).
const QUERY_TYPE = "task";

export async function post(req, reply) {
  const { query, context, history, userId, companyId, companyName, fake, style, subtype, type, model } = req.body || {};
  if (!query || typeof query !== "string") return reply.code(400).send({ error: "query is required" });

  // fake:true → canned topic (no Ollama, no delay), SAME transport as a real query.
  const topic = fake ? FAKE_TOPIC : resolveTopic(model);
  if (!topic) return reply.code(400).send({ error: `unknown or unavailable model "${model}"` });
  // Copilot output style → temperature (worker maps style→temp). type:"task" defaults to
  // "structured" (temp ~0.1, near-deterministic → identical answers). The copilot wants
  // variety, so default to "unstructured" (~0.7); callers may override per request.
  const genStyle = style || "unstructured";

  const ctx = context || {};
  const preamble = [
    companyName ? `Company: ${companyName}.` : "",
    ctx.page ? `Page: ${ctx.page}.` : "",
    ctx.section ? `Section in focus: ${ctx.section}.` : "",
    Array.isArray(history) && history.length ? `Earlier questions: ${history.slice(-5).join(" | ")}.` : "",
  ].filter(Boolean).join(" ");
  const effectiveQuery = preamble ? `${preamble}\n\n${query}` : query;
  const effectiveType = type || QUERY_TYPE;

  const db = getFirestore();
  const jobId = randomUUID();
  await db.collection("llmResults").doc(jobId).set({
    jobId, query, type: effectiveType, subtype: subtype || "", model: topic, fake: !!fake,
    status: "pending", response: "",
    uid: userId || "", companyId: companyId || "", organization: companyName || "",
    context: context || null, isDeleted: false,
    createdAt: FieldValue.serverTimestamp(), completedAt: null,
  });
  await pubsub().topic(topic).publishMessage({
    json: { jobId, query: effectiveQuery, type: effectiveType, subtype: subtype || "", model: topic, fake: !!fake, style: genStyle },
  });
  console.log(`[ai/query] jobId=${jobId} → "${topic}"${fake ? " (fake)" : ""} (company=${companyId || "-"})`);
  return reply.send({ jobId });
}
