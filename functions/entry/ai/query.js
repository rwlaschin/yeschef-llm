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

  // Every exit from this route logs. Previously only the success path did, so a rejected or
  // throwing query produced NO output at all and simply vanished — the caller saw a spinner and
  // the orchestrator log showed nothing. Mirrors the [ai/menu] idiom.
  console.log(
    `[ai/query] ← type=${type || QUERY_TYPE} subtype=${subtype || "-"} model=${model || "(default)"}` +
    ` fake=${!!fake} company=${companyId || "-"} queryLen=${typeof query === "string" ? query.length : 0}`,
  );

  if (!query || typeof query !== "string") {
    console.warn(`[ai/query] ✗ 400 query is required (got ${typeof query}) company=${companyId || "-"}`);
    return reply.code(400).send({ error: "query is required" });
  }

  // fake:true → canned topic (no Ollama, no delay), SAME transport as a real query.
  const topic = fake ? FAKE_TOPIC : resolveTopic(model);
  if (!topic) {
    console.warn(
      `[ai/query] ✗ 400 unknown or unavailable model "${model}" —` +
      ` isProdLike=${isProdLike()}, dev-eligible topics: ${MODELS.filter((m) => m.dev).map((m) => m.topic).join(", ")}`,
    );
    return reply.code(400).send({ error: `unknown or unavailable model "${model}"` });
  }
  console.log(`[ai/query] resolved topic="${topic}"${fake ? " (FAKE — canned, no model)" : ""}${model ? " (caller override)" : " (default tier)"}`);
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

  // The seed and the publish are the two awaits that can throw. Unlogged, a failure here surfaced
  // only as a bare 500 — indistinguishable from the job silently never being picked up. Log and
  // RETHROW so the framework's error handling is unchanged; this adds visibility, not behaviour.
  try {
    await db.collection("llmResults").doc(jobId).set({
      jobId, query, type: effectiveType, subtype: subtype || "", model: topic, fake: !!fake,
      status: "pending", response: "",
      uid: userId || "", companyId: companyId || "", organization: companyName || "",
      context: context || null, isDeleted: false,
      createdAt: FieldValue.serverTimestamp(), completedAt: null,
    });
  } catch (err) {
    console.error(`[ai/query] ✗ FIRESTORE seed failed jobId=${jobId}: ${err?.message || err}`);
    throw err;
  }

  try {
    await pubsub().topic(topic).publishMessage({
      json: { jobId, query: effectiveQuery, type: effectiveType, subtype: subtype || "", model: topic, fake: !!fake, style: genStyle },
    });
  } catch (err) {
    console.error(
      `[ai/query] ✗ PUBLISH failed jobId=${jobId} topic="${topic}": ${err?.message || err}` +
      ` — the job doc exists in 'pending' and will hang forever unless this is retried`,
    );
    throw err;
  }

  console.log(
    `[ai/query] ✓ jobId=${jobId} → "${topic}"${fake ? " (fake)" : ""} (company=${companyId || "-"}` +
    ` type=${effectiveType} subtype=${subtype || "-"} style=${genStyle})`,
  );
  return reply.send({ jobId });
}
