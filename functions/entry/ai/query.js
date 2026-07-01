// POST /ai/query — single-shot LLM query for the chat copilot (Ask Remy, AI field-suggest).
// The orchestrator is the SINGLE dispatch authority: it owns topic selection, so yeschef
// (the Next app) never hardcodes topic names and can't drift. Writes llmResults/{jobId};
// the worker streams the reply back into that doc; the client reads it via onSnapshot.
import { randomUUID } from "crypto";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { PubSub } from "@google-cloud/pubsub";
import { MODELS, FAKE_TOPIC } from "../../config/models.js";

let _pubsub;
const pubsub = () => (_pubsub ??= new PubSub({ projectId: process.env.GCP_PROJECT_ID }));

// Default query tier = the cheapest dev-capable model. Topic name lives HERE (config/models.js
// is the single source of truth) — callers never name a topic.
const DEFAULT_QUERY_TOPIC = (MODELS.find((m) => m.dev) || MODELS[0]).topic;

// Message TYPE for the copilot = "task", NOT "query": the prompt_library maps the heavy
// menu/recipe/order-form OUTPUT TEMPLATE onto "query", which would prepend ~8k tokens of
// YAML schema to every chat turn. "task" has no mapped system prompt → a lightweight,
// general single-shot answer (worker falls through to buildStandardMessages either way).
const QUERY_TYPE = "task";

export async function post(req, reply) {
  const { query, context, history, userId, companyId, companyName, fake, style } = req.body || {};
  if (!query || typeof query !== "string") return reply.code(400).send({ error: "query is required" });

  // fake:true → canned topic (no Ollama, no delay), SAME transport as a real query.
  const topic = fake ? FAKE_TOPIC : DEFAULT_QUERY_TOPIC;
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

  const db = getFirestore();
  const jobId = randomUUID();
  await db.collection("llmResults").doc(jobId).set({
    jobId, query, type: QUERY_TYPE, model: topic, fake: !!fake,
    status: "pending", response: "",
    uid: userId || "", companyId: companyId || "", organization: companyName || "",
    context: context || null, isDeleted: false,
    createdAt: FieldValue.serverTimestamp(), completedAt: null,
  });
  await pubsub().topic(topic).publishMessage({
    json: { jobId, query: effectiveQuery, type: QUERY_TYPE, model: topic, fake: !!fake, style: genStyle },
  });
  console.log(`[ai/query] jobId=${jobId} → "${topic}"${fake ? " (fake)" : ""} (company=${companyId || "-"})`);
  return reply.send({ jobId });
}
