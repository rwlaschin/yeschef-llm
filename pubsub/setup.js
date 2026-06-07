// ============================================================
// Pub/Sub Setup - Ollama LLM Infrastructure
// Idempotent — safe to call on every deploy or dev start.
// ============================================================

import { PubSub } from "@google-cloud/pubsub";
import { MODELS, subscriptionOf, deadLetterOf } from "../config/models.js";

const DEFAULT_SUB_CONFIG = {
  ackDeadlineSeconds: 40,
  minRetryDelay: { seconds: 10 },
  maxRetryDelay: { seconds: 30 },
};

const MAX_DELIVERY_ATTEMPTS = 5;

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
    if (await subscriptionExists(cfg.subscription)) {
      console.log(`  already exists: ${cfg.subscription}`);
      return;
    }
    const deadLetterTopic = `projects/${projectId}/topics/${cfg.deadLetter}`;
    await client.topic(cfg.topic).createSubscription(cfg.subscription, {
      ackDeadlineSeconds: cfg.ackDeadlineSeconds,
      deadLetterPolicy: { deadLetterTopic, maxDeliveryAttempts: MAX_DELIVERY_ATTEMPTS },
      retryPolicy: {
        minimumBackoff: cfg.minRetryDelay,
        maximumBackoff: cfg.maxRetryDelay,
      },
    });
    console.log(`  created: ${cfg.subscription} (ack ${cfg.ackDeadlineSeconds}s, dead-letter → ${cfg.deadLetter})`);
  }

  console.log(`\nPub/Sub setup [${projectId}] — ${models.length} model(s)\n`);
  for (const m of models) {
    console.log(`[${m.key.toUpperCase()}]`);
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
  console.log("Pub/Sub ready.\n");
}
