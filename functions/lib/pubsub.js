// Create the `orchestrate` topic and its PUSH subscription on startup, idempotently.
// Agents publish their completion message to `orchestrate` (kind: build | step); the
// subscription pushes them to /ai/events on this service.
//
// AI_BASE_URL is this function's public base including the /ai prefix, e.g.
//   https://us-central1-yeschef-c572a.cloudfunctions.net/ai
import { PubSub } from "@google-cloud/pubsub";
import { ORCHESTRATE_TOPIC } from "./topics.js";
import { MODELS, FAKE_TOPIC } from "../config/models.js";

const TOPIC = ORCHESTRATE_TOPIC;
const SUBSCRIPTION = `sub_${ORCHESTRATE_TOPIC}_push`;
const ACK_DEADLINE = 600;

export async function configurePubSub() {
  // Default to this function's deterministic public URL (the `ai` function in
  // us-central1), derived from the project; override with AI_BASE_URL if needed.
  const project = process.env.GCP_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  // The cloudfunctions.net fallback is PRODUCTION-ONLY. Outside production it must never apply:
  // a dev emulator that falls back points the LOCAL orchestrate subscription at the DEPLOYED
  // function, so every local job is pushed to prod and no local worker ever sees it — the failure
  // looks identical to "jobs stuck Running forever". Fail loudly instead of routing off-box.
  const isProd = process.env.NODE_ENV === "production";
  const base = process.env.AI_BASE_URL || (isProd && project && `https://us-central1-${project}.cloudfunctions.net/ai`);
  if (!base) {
    throw new Error(
      isProd
        ? "Cannot resolve the /ai base URL — set AI_BASE_URL or GCP_PROJECT_ID"
        : `AI_BASE_URL is required outside production (NODE_ENV=${process.env.NODE_ENV ?? "unset"}) — refusing to point the local orchestrate push subscription at the deployed function`,
    );
  }
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

// Capacity detect-message: ensure a detect PUSH subscription on EVERY model topic (fan-out — its own
// copy, so the worker's sub is untouched) → /ai/capacity-detect. Enumerated from config/models.js at
// startup/deploy, so a new model is covered on its own deploy — no separate listeners, no per-model
// wiring. This is the "shim": one endpoint fed by every model topic, publisher-agnostic.
export async function configureCapacityDetect() {
  // PRODUCTION ONLY. These push subscriptions drive /ai/capacity-detect, which starts model workers
  // — on a dev machine that means spinning GPU-tier containers up locally, which takes the machine
  // down. Dev must never have a detect_* subscription; absent is the correct state, not a gap.
  if (!/prod(uction)?/i.test(process.env.NODE_ENV || "")) return;
  const project = process.env.GCP_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  const base = process.env.AI_BASE_URL || (project && `https://us-central1-${project}.cloudfunctions.net/ai`);
  if (!base) return;
  const pushEndpoint = `${base.replace(/\/$/, "")}/capacity-detect`;
  const pubsub = new PubSub({ projectId: project });
  const topicNames = [...new Set([...MODELS.map((m) => m.topic), FAKE_TOPIC])];

  for (const t of topicNames) {
    const topic = pubsub.topic(t);
    const subName = `detect_${t}`;
    try {
      const [subs] = await topic.getSubscriptions();
      const existing = subs.find((s) => s.name.endsWith(`/${subName}`));
      if (!existing) {
        await topic.createSubscription(subName, { pushConfig: { pushEndpoint }, ackDeadlineSeconds: 60 });
        console.info(`[orchestrator] capacity detect sub ${subName} -> ${pushEndpoint}`);
      } else {
        const [meta] = await existing.getMetadata();
        if (meta.pushConfig?.pushEndpoint !== pushEndpoint) await existing.modifyPushConfig({ pushEndpoint });
      }
    } catch (e) {
      // Not an error: nothing here acts on it. Dev never provisions these topics on purpose
      // (capacity/autoscale must not spin workers up on a dev machine), so NOT_FOUND is the
      // expected state every boot. Logging-and-continuing at ERROR only labelled a swallowed
      // failure; if this ever needs to be actionable it needs a handler, not a louder level.
      console.log(`DBG [orchestrator] capacity detect sub ${subName} skipped: ${e.message}`);
    }
  }
}
