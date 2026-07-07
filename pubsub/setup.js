// ============================================================
// Pub/Sub Setup - Ollama LLM Infrastructure
// Idempotent — safe to call on every deploy or dev start.
// ============================================================

import { PubSub } from "@google-cloud/pubsub";
import { MODELS, subscriptionOf, deadLetterOf, FAKE_TOPIC, FAKE_SUBSCRIPTION, FAKE_DEAD_LETTER } from "../config/models.js";

const DEFAULT_SUB_CONFIG = {
  // Base redelivery window. PROD stays short (40s) so a preempted SPOT VM's in-flight
  // unit redelivers fast. DEV ONLY → 300s: the Pub/Sub emulator ignores the client's
  // lease extension (maxExtensionMinutes), so it redelivers at exactly this deadline;
  // 40s there double-runs slow (1–5 min) units. Real Pub/Sub honors the extension, so
  // prod is unaffected by this value beyond the spot-death case.
  ackDeadlineSeconds: process.env.NODE_ENV === "dev" ? 300 : 40,
  minRetryDelay: { seconds: 10 },
  maxRetryDelay: { seconds: 30 },
  // Messages nobody pulls expire after 4 hours — prevents zombie jobs floating forever
  // when workers are down. 7-day default would let a stuck message linger for days.
  messageRetentionDuration: { seconds: 4 * 3600 },
};

// Dead-letter is a TRANSPORT backstop only — the natural terminal sink for messages that can never
// reach a clean terminal write (unparseable payload, repeated crash before any Firestore write). It
// is NOT the give-up authority: that is semantic, owned by the orchestrator (attempts[step] → MAX_GEN
// → passthrough). Pub/Sub counts EVERY delivery, including healthy redeliveries from spot preemption,
// so this is set high — a long unit preempted a few times must not dead-letter while still healthy.
// See docs/design/worker-dispatch.md.
const MAX_DELIVERY_ATTEMPTS = 50;

// `models` defaults to the full registry (prod provisions everything). Dev passes
// only its dev-capable models so we don't create topics/subs for tiers that can't
// run here (large/70B, un-wired OpenClaw) — which would otherwise let the dashboard
// queue messages no worker will ever consume.
export async function setup(projectId, models = MODELS) {
  const client = new PubSub({ projectId });

  async function topicExists(name) {
    const [topics] = await client.getTopics();
    return topics.some((t) => t.name.endsWith(`/${name}`));
  }

  async function subscriptionExists(name) {
    const [subs] = await client.getSubscriptions();
    return subs.some((s) => s.name.endsWith(`/${name}`));
  }

  async function ensureTopic(name) {
    if (await topicExists(name)) {
      console.log(`  already exists: ${name}`);
      return client.topic(name);
    }
    const [topic] = await client.createTopic(name);
    console.log(`  created: ${name}`);
    return topic;
  }

  async function ensureSubscription(cfg) {
    const deadLetterTopic = `projects/${projectId}/topics/${cfg.deadLetter}`;
    const subConfig = {
      ackDeadlineSeconds: cfg.ackDeadlineSeconds,
      deadLetterPolicy: { deadLetterTopic, maxDeliveryAttempts: MAX_DELIVERY_ATTEMPTS },
      retryPolicy: { minimumBackoff: cfg.minRetryDelay, maximumBackoff: cfg.maxRetryDelay },
      messageRetentionDuration: cfg.messageRetentionDuration,
    };
    if (await subscriptionExists(cfg.subscription)) {
      const sub = client.subscription(cfg.subscription);
      await sub.setMetadata(subConfig);
      console.log(`  updated: ${cfg.subscription}`);
      return;
    }
    await client.topic(cfg.topic).createSubscription(cfg.subscription, subConfig);
    console.log(`  created: ${cfg.subscription} (ack ${cfg.ackDeadlineSeconds}s, dead-letter → ${cfg.deadLetter})`);
  }

  console.log(`\nPub/Sub setup [${projectId}] — ${models.length} model(s)\n`);
  for (const m of models) {
    console.log(`[${m.label}]`);
    await ensureTopic(deadLetterOf(m));
    await ensureTopic(m.topic);
    await ensureSubscription({
      ...DEFAULT_SUB_CONFIG,
      topic: m.topic,
      subscription: subscriptionOf(m),
      deadLetter: deadLetterOf(m),
    });
    console.log();
  }
  // Fake/canned transport — one shared topic + subscription for dev/test canned responses.
  console.log(`[Fake canned]`);
  await ensureTopic(FAKE_DEAD_LETTER);
  await ensureTopic(FAKE_TOPIC);
  await ensureSubscription({
    ...DEFAULT_SUB_CONFIG,
    topic: FAKE_TOPIC,
    subscription: FAKE_SUBSCRIPTION,
    deadLetter: FAKE_DEAD_LETTER,
  });
  console.log();
  console.log("Pub/Sub ready.\n");
}
