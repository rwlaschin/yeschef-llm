// Auto-provision the capacity recorder's log sink on ORCHESTRATOR STARTUP (idempotent) — so it comes
// up with the endpoint, never a manual step. Mirrors configurePubSub(): ensure the topic, ensure the
// Cloud Logging sink routing completed worker-create operations to it, and grant the sink's writer
// identity permission to publish. No-op off-GCE (metadata token unavailable → dev/local).
import { PubSub } from "@google-cloud/pubsub";

const META = "http://metadata.google.internal/computeMetadata/v1";
const TOPIC = "capacity_create_events";
const SINK = "capacity-create-sink";
// Completed worker-MIG create operations, any outcome. The recorder classifies ok vs stockout from
// status.message and drops non-ollama instances (WORKER_RE) — the sink can over-deliver harmlessly.
const FILTER = 'protoPayload.methodName="v1.compute.instances.insert" AND protoPayload.resourceName:"-mig-" AND operation.last=true';

async function adcToken() {
  const r = await fetch(`${META}/instance/service-accounts/default/token`, {
    headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(1000),
  });
  if (!r.ok) throw new Error(`metadata token ${r.status}`);
  return JSON.parse(await r.text()).access_token;
}

// Log-based counter metric on detect-message events, labeled by topic (extracted from the structured
// jsonPayload the recorder emits). Gives Cloud Monitoring a per-topic detect rate — chartable +
// alertable — alongside the Mongo scoreboard. Auto-provisioned on startup, idempotent. No-op off-GCE.
export async function configureCapacityMetric() {
  const project = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  if (!project) return;
  let token;
  try { token = await adcToken(); } catch { return; }
  const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const body = {
    name: "capacity_detect",
    description: "Capacity manager: detect-message events, per model topic.",
    filter: 'jsonPayload.capacityEvent="detect"',
    metricDescriptor: {
      metricKind: "DELTA", valueType: "INT64",
      labels: [{ key: "topic", valueType: "STRING", description: "model topic" }],
    },
    labelExtractors: { topic: "EXTRACT(jsonPayload.topic)" },
  };
  const got = await fetch(`https://logging.googleapis.com/v2/projects/${project}/metrics/capacity_detect`, { headers: H });
  if (got.ok) {
    await fetch(`https://logging.googleapis.com/v2/projects/${project}/metrics/capacity_detect`, { method: "PUT", headers: H, body: JSON.stringify(body) });
  } else {
    const c = await fetch(`https://logging.googleapis.com/v2/projects/${project}/metrics`, { method: "POST", headers: H, body: JSON.stringify(body) });
    if (c.ok) console.info("[orchestrator] created log-based metric: capacity_detect");
    else console.error(`[orchestrator] capacity metric create ${c.status} ${(await c.text()).slice(0, 200)}`);
  }
}

export async function configureCapacitySink() {
  const project = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  if (!project) return;
  let token;
  try { token = await adcToken(); } catch { return; } // off-GCE → skip (no real logging to route)

  const pubsub = new PubSub({ projectId: project });
  const [topics] = await pubsub.getTopics();
  if (!topics.some((t) => t.name.endsWith(`/${TOPIC}`))) {
    await pubsub.createTopic(TOPIC);
    console.info(`[orchestrator] created topic: ${TOPIC}`);
  }

  const destination = `pubsub.googleapis.com/projects/${project}/topics/${TOPIC}`;
  const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // Ensure the sink (create if missing; capture its writer identity).
  let writer;
  const got = await fetch(`https://logging.googleapis.com/v2/projects/${project}/sinks/${SINK}`, { headers: H });
  if (got.ok) {
    const s = await got.json();
    writer = s.writerIdentity;
    if (s.filter !== FILTER || s.destination !== destination) {
      await fetch(`https://logging.googleapis.com/v2/projects/${project}/sinks/${SINK}?updateMask=filter,destination`,
        { method: "PUT", headers: H, body: JSON.stringify({ name: SINK, destination, filter: FILTER }) });
      console.info(`[orchestrator] updated capacity sink`);
    }
  } else {
    const created = await fetch(`https://logging.googleapis.com/v2/projects/${project}/sinks`,
      { method: "POST", headers: H, body: JSON.stringify({ name: SINK, destination, filter: FILTER }) });
    if (!created.ok) throw new Error(`sink create ${created.status} ${(await created.text()).slice(0, 200)}`);
    writer = (await created.json()).writerIdentity;
    console.info(`[orchestrator] created capacity sink → ${TOPIC}`);
  }

  // Grant the sink writer publish rights on the topic (else logs are silently dropped). Idempotent.
  if (writer) {
    const topic = pubsub.topic(TOPIC);
    const [policy] = await topic.iam.getPolicy();
    policy.bindings ||= [];
    const binding = policy.bindings.find((b) => b.role === "roles/pubsub.publisher");
    if (!binding) policy.bindings.push({ role: "roles/pubsub.publisher", members: [writer] });
    else if (!binding.members.includes(writer)) binding.members.push(writer);
    else return; // already granted
    await topic.iam.setPolicy(policy);
    console.info(`[orchestrator] granted ${writer} publisher on ${TOPIC}`);
  }
}
