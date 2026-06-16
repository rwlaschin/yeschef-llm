// Create the `orchestrate` topic and its PUSH subscription on startup, idempotently.
// Agents publish their completion message to `orchestrate` (kind: build | step); the
// subscription pushes them to /ai/events on this service.
//
// AI_BASE_URL is this function's public base including the /ai prefix, e.g.
//   https://us-central1-yeschef-c572a.cloudfunctions.net/ai
import { PubSub } from "@google-cloud/pubsub";
import { ORCHESTRATE_TOPIC } from "./topics.js";

const TOPIC = ORCHESTRATE_TOPIC;
const SUBSCRIPTION = `sub_${ORCHESTRATE_TOPIC}_push`;
const ACK_DEADLINE = 600;

export async function configurePubSub() {
  // Default to this function's deterministic public URL (the `ai` function in
  // us-central1), derived from the project; override with AI_BASE_URL if needed.
  const project = process.env.GCP_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  const base = process.env.AI_BASE_URL || (project && `https://us-central1-${project}.cloudfunctions.net/ai`);
  if (!base) throw new Error("Cannot resolve the /ai base URL — set AI_BASE_URL or GCP_PROJECT_ID");
  const pushEndpoint = `${base.replace(/\/$/, "")}/events`;

  const pubsub = new PubSub({ projectId: process.env.GCP_PROJECT_ID });

  const [topics] = await pubsub.getTopics();
  if (!topics.some((t) => t.name.endsWith(`/${TOPIC}`))) {
    await pubsub.createTopic(TOPIC);
    console.info(`[orchestrator] created topic: ${TOPIC}`);
  }

  const topic = pubsub.topic(TOPIC);
  const [subs] = await topic.getSubscriptions();
  const existing = subs.find((s) => s.name.endsWith(`/${SUBSCRIPTION}`));
  if (!existing) {
    await topic.createSubscription(SUBSCRIPTION, {
      pushConfig: { pushEndpoint },
      ackDeadlineSeconds: ACK_DEADLINE,
    });
    console.info(`[orchestrator] created subscription: ${SUBSCRIPTION} -> ${pushEndpoint}`);
    return;
  }

  const [meta] = await existing.getMetadata();
  if (meta.pushConfig?.pushEndpoint !== pushEndpoint) {
    await existing.modifyPushConfig({ pushEndpoint });
    console.info(`[orchestrator] updated push endpoint: ${SUBSCRIPTION} -> ${pushEndpoint}`);
  }
}
