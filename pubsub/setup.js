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

export async function setup(projectId) {
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

  console.log(`\nPub/Sub setup [${projectId}]\n`);
  for (const m of MODELS) {
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
