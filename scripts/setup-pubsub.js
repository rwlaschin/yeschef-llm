// ============================================================
// Pub/Sub Setup - Ollama LLM Infrastructure
// Idempotent — safe to call on every deploy or dev start.
// ============================================================

import { PubSub } from "@google-cloud/pubsub";
import { MODELS, subscriptionOf, deadLetterOf, FAKE_TOPIC, FAKE_SUBSCRIPTION, FAKE_DEAD_LETTER } from "../config/models.js";

const DEFAULT_SUB_CONFIG = {
  // Base redelivery window. PROD stays short (40s) so an in-flight unit on a VM lost to
  // scale-in, host maintenance, or a crash redelivers fast. DEV ONLY → 300s: the Pub/Sub
  // emulator ignores the client's lease extension (maxExtensionMinutes), so it redelivers at
  // exactly this deadline; 40s there double-runs slow (1–5 min) units. Real Pub/Sub honors the
  // extension, so prod is unaffected by this value beyond the instance-loss case.
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
// → passthrough). Pub/Sub counts EVERY delivery, including healthy redeliveries from instance loss
// (scale-in / host maintenance / crash), so this is set high — a long unit redelivered a few times
// must not dead-letter while still healthy.
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

  // Dead-lettering is carried out by Pub/Sub's OWN service agent, and it needs two grants or it silently
  // does nothing: publisher on the dead-letter topic, and subscriber on the source subscription. Neither
  // was granted in this project — so a message that exhausted maxDeliveryAttempts was never forwarded,
  // it just kept retrying, holding a lease and waking a box each time. dead_letter_message_count stayed
  // flat because the forward never even attempted.
  let agentMember;
  async function pubsubServiceAgent() {
    if (agentMember) return agentMember;
    const authClient = await client.auth.getClient();
    const token = await authClient.getAccessToken();
    const res = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}`, {
      headers: { Authorization: `Bearer ${token.token ?? token}` },
    });
    if (!res.ok) throw new Error(`resolve project number → ${res.status}`);
    agentMember = `serviceAccount:service-${(await res.json()).projectNumber}@gcp-sa-pubsub.iam.gserviceaccount.com`;
    return agentMember;
  }

  // Idempotent add-if-missing. The emulator has no IAM at all, so this is a no-op there.
  async function grantToAgent(resource, role, label) {
    if (process.env.PUBSUB_EMULATOR_HOST) return;
    const member = await pubsubServiceAgent();
    const [policy] = await resource.iam.getPolicy();
    policy.bindings ||= [];
    const binding = policy.bindings.find((b) => b.role === role);
    if (binding?.members?.includes(member)) return;
    if (binding) binding.members.push(member);
    else policy.bindings.push({ role, members: [member] });
    await resource.iam.setPolicy(policy);
    console.log(`  granted: ${role} on ${label} → pubsub service agent (dead-lettering requires it)`);
  }

  // A dead-letter TOPIC with no subscription is a black hole: "messages published to a topic with no
  // subscriptions are lost" (Google's own dead-letter guidance). All 8 dead-letter topics had zero
  // subscribers, so every message that exhausted its delivery attempts was DISCARDED — indistinguishable
  // from a job that silently never finished. This parks them instead, on a long retention, for offline
  // analysis. Nothing consumes it automatically: a message here means the transport gave up, which is a
  // human question, not something to auto-retry into the same failure.
  async function ensureDeadLetterSink(name) {
    const sink = `sub_${name}`;
    if (await subscriptionExists(sink)) {
      console.log(`  already exists: ${sink}`);
      return;
    }
    await client.topic(name).createSubscription(sink, {
      ackDeadlineSeconds: 60,
      // 7 days: long enough to notice and investigate on a Monday. The main subs keep 4h.
      messageRetentionDuration: { seconds: 7 * 24 * 3600 },
    });
    console.log(`  created: ${sink} — parks dead-lettered messages (was: silently discarded)`);
  }

  // Both halves of the dead-letter permission, applied every run so a new model tier is never missed.
  async function ensureDeadLetterPermissions(deadLetter, subscription) {
    await grantToAgent(client.topic(deadLetter), "roles/pubsub.publisher", deadLetter);
    await grantToAgent(client.subscription(subscription), "roles/pubsub.subscriber", subscription);
  }

  console.log(`\nPub/Sub setup [${projectId}] — ${models.length} model(s)\n`);
  for (const m of models) {
    console.log(`[${m.label}]`);
    await ensureTopic(deadLetterOf(m));
    await ensureDeadLetterSink(deadLetterOf(m));
    await ensureTopic(m.topic);
    await ensureSubscription({
      ...DEFAULT_SUB_CONFIG,
      topic: m.topic,
      subscription: subscriptionOf(m),
      deadLetter: deadLetterOf(m),
    });
    await ensureDeadLetterPermissions(deadLetterOf(m), subscriptionOf(m));
    console.log();
  }
  // Fake/canned transport — one shared topic + subscription for dev/test canned responses.
  console.log(`[Fake canned]`);
  await ensureTopic(FAKE_DEAD_LETTER);
  await ensureDeadLetterSink(FAKE_DEAD_LETTER);
  await ensureTopic(FAKE_TOPIC);
  await ensureSubscription({
    ...DEFAULT_SUB_CONFIG,
    topic: FAKE_TOPIC,
    subscription: FAKE_SUBSCRIPTION,
    deadLetter: FAKE_DEAD_LETTER,
  });
  await ensureDeadLetterPermissions(FAKE_DEAD_LETTER, FAKE_SUBSCRIPTION);
  console.log();
  console.log("Pub/Sub ready.\n");
}
