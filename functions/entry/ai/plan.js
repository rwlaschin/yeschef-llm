// POST /ai/plan — launch a plan from a FREE-TEXT prompt: the planner composes the step list.
// This is NOT the only ingress, and claiming it was cost a full debugging session. Its sibling is
// /ai/menu, which takes the structured form and composes deterministically BEFORE publishing. Two
// ingresses because there are two ways to author a plan; that difference is the feature.
// Behind them they converge immediately — same auth (the global requireAuth preHandler in
// index.js), same `{action:"start"}` message on the same ORCHESTRATE_TOPIC, and a deliberately
// aligned llmResults doc shape (see the note in menu.js about mirroring this path's doc).
// The dashboard's local/production toggle only selects WHICH URL the browser hits.
//
// Callers: dashboard Request.vue → here. Dashboard MenuForm.vue and the YesChef app
// (src/query/hooks/llm.ts postMenuPlan) → /ai/menu.
//
// Thin: mint a jobId, publish a `start` message to the `orchestrate` topic, and return
// the jobId. The orchestrator (topic-fed) does the actual launch — see dispatch/start.js.
import { randomUUID } from "crypto";
import { PubSub } from "@google-cloud/pubsub";
import { ORCHESTRATE_TOPIC } from "../../lib/topics.js";

let _pubsub;
function pubsub() {
  if (!_pubsub) _pubsub = new PubSub({ projectId: process.env.GCP_PROJECT_ID });
  return _pubsub;
}

export async function post(req, reply) {
  const { userId, companyId, userPrompt, model, metadata } = req.body || {};
  console.log(`[ai/plan] ← userId=${userId} companyId=${companyId} model=${model} promptLen=${userPrompt?.length ?? 0}`);

  if (!userId || !companyId || !userPrompt || !model) {
    console.warn(`[ai/plan] 400 missing fields: userId=${!!userId} companyId=${!!companyId} userPrompt=${!!userPrompt} model=${!!model}`);
    return reply.code(400).send({ error: "Missing required fields: userId, companyId, userPrompt, model" });
  }

  const jobId = randomUUID();
  // A throwing publish previously produced a bare 500 with nothing after the `←` line, which is
  // indistinguishable from the job being accepted and never picked up. Log and RETHROW — visibility
  // only, framework error handling unchanged.
  try {
    await pubsub().topic(ORCHESTRATE_TOPIC).publishMessage({
      json: { action: "start", jobId, userId, companyId, userPrompt, model, metadata: metadata || {} },
    });
  } catch (err) {
    console.error(`[ai/plan] ✗ PUBLISH failed jobId=${jobId} topic="${ORCHESTRATE_TOPIC}": ${err?.message || err}`);
    throw err;
  }
  console.log(`[ai/plan] → published start to "${ORCHESTRATE_TOPIC}"  jobId=${jobId}`);

  return reply.send({ jobId });
}
