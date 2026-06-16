// POST /ai/plan — the single common ingress to launch a plan. Both the dashboard UI
// and YesChef POST here; the dashboard's local/production toggle only selects WHICH
// /ai/plan URL the browser hits. Implemented once → tested once.
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
  await pubsub().topic(ORCHESTRATE_TOPIC).publishMessage({
    json: { action: "start", jobId, userId, companyId, userPrompt, model, metadata: metadata || {} },
  });
  console.log(`[ai/plan] → published start to "${ORCHESTRATE_TOPIC}"  jobId=${jobId}`);

  return reply.send({ jobId });
}
