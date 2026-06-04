// ============================================================
// Dev Waker — emulates the prod GCE MIG autoscaler, for MULTIPLE models.
//
// Watches each model's Pub/Sub *emulator* subscription. When a message is waiting
// AND that model's worker container is down, it `docker start`s the pre-baked
// image (Ollama + worker + model). It NEVER acks/consumes — the worker inside the
// container is the sole consumer that pulls + acks.
//
// Models come from WAKER_MODELS (JSON array of { subscription, image, container,
// model }). Falls back to single-model env vars if WAKER_MODELS is unset.
//
// Prod equivalent: a MIG autoscaler per model, scaling spot GPU VMs on the
// `num_undelivered_messages` metric. Here, `docker start` stands in.
//
// Dev-only: requires PUBSUB_EMULATOR_HOST.
// Re-test cold start with:  docker stop <container>
// ============================================================

import pubsubLib from "@google-cloud/pubsub";
import { execSync } from "child_process";
import { setTimeout as sleep } from "timers/promises";

const { PubSub, v1 } = pubsubLib;

const {
  GCP_PROJECT_ID,
  PUBSUB_EMULATOR_HOST,
  WAKER_MODELS,
  WAKER_POLL_MS = "3000",
  // shared, passed through to every container
  MONGO_URI,
  MONGO_DB,
  MONGO_COLLECTION,
  FIREBASE_PROJECT_ID,
  GOOGLE_APPLICATION_CREDENTIALS, // SA key for writing to PROD Firestore in dev
  DOCKER_GPU, // e.g. "all" if an NVIDIA GPU is present; leave unset on Mac (CPU)
} = process.env;

const pollMs = parseInt(WAKER_POLL_MS, 10);

// Model list comes from WAKER_MODELS (JSON). Required — no fallback.
function resolveModels() {
  if (!WAKER_MODELS) throw new Error("WAKER_MODELS not set — required, no fallback");
  return JSON.parse(WAKER_MODELS);
}

function sh(cmd) {
  return execSync(cmd, { stdio: "pipe" }).toString().trim();
}

function containerRunning(container) {
  try {
    return !!sh(`docker ps -q --filter name=^${container}$ --filter status=running`);
  } catch {
    return false;
  }
}

function containerExists(container) {
  try {
    return !!sh(`docker ps -aq --filter name=^${container}$`);
  } catch {
    return false;
  }
}

function startContainer(m) {
  if (containerExists(m.container)) {
    console.log(`[waker:${m.model}] warm start: docker start ${m.container}`);
    sh(`docker start ${m.container}`);
    return;
  }
  console.log(`[waker:${m.model}] cold start: docker run ${m.image}`);
  const env = [
    `PUBSUB_EMULATOR_HOST=host.docker.internal:8085`,
    `GCP_PROJECT_ID=${GCP_PROJECT_ID}`,
    `SUBSCRIPTION_NAME=${m.subscription}`,
    `OLLAMA_MODEL=${m.model}`,
    `OLLAMA_HOST=http://localhost:11434`,
    `MONGO_URI=${MONGO_URI}`,
    `MONGO_DB=${MONGO_DB}`,
    `MONGO_COLLECTION=${MONGO_COLLECTION}`,
    `FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID || GCP_PROJECT_ID}`,
  ];
  if (GOOGLE_APPLICATION_CREDENTIALS) env.push(`GOOGLE_APPLICATION_CREDENTIALS=/secrets/sa.json`);
  const envFlags = env.map((e) => `-e ${e}`).join(" ");
  const credMount = GOOGLE_APPLICATION_CREDENTIALS
    ? `-v "${GOOGLE_APPLICATION_CREDENTIALS}":/secrets/sa.json:ro`
    : "";
  const gpuFlag = DOCKER_GPU ? `--gpus ${DOCKER_GPU}` : "";
  // Mount live worker code over the baked copy so worker edits apply on a
  // container restart — no image rebuild needed in dev.
  const workerMount = `-v "${process.cwd()}/worker":/app/worker`;
  sh(
    `docker run -d --name ${m.container} ` +
      `--add-host=host.docker.internal:host-gateway ` +
      `${gpuFlag} ${envFlags} ${credMount} ${workerMount} ${m.image}`
  );
}

async function hasBacklog(subClient, subPath) {
  const [res] = await subClient.pull({ subscription: subPath, maxMessages: 1, returnImmediately: true });
  const msgs = res.receivedMessages || [];
  if (msgs.length === 0) return false;
  await subClient.modifyAckDeadline({
    subscription: subPath,
    ackIds: msgs.map((m) => m.ackId),
    ackDeadlineSeconds: 0, // release immediately so the worker can pull it
  });
  return true;
}

async function main() {
  if (!PUBSUB_EMULATOR_HOST) {
    throw new Error("PUBSUB_EMULATOR_HOST not set — the waker is a dev-only emulation");
  }
  const models = resolveModels();
  // Build the low-level subscriber client from the high-level PubSub class's own
  // emulator-aware options (servicePath/port/insecure SSL, derived from
  // PUBSUB_EMULATOR_HOST). This reuses the library's exact logic and avoids the
  // gax ":443" endpoint-parsing pitfall.
  const pubsub = new PubSub({ projectId: GCP_PROJECT_ID });
  const subClient = new v1.SubscriberClient(pubsub.options);

  console.log(`[waker] emulator ${PUBSUB_EMULATOR_HOST}; watching ${models.length} model(s):`);
  for (const m of models) console.log(`  - ${m.model}  (${m.subscription} → ${m.container})`);
  console.log(`[waker] prod equivalent → GCE MIG autoscaler per model on Pub/Sub backlog\n`);

  for (;;) {
    for (const m of models) {
      try {
        if (containerRunning(m.container)) continue; // worker owns its sub while up
        const subPath = subClient.subscriptionPath(GCP_PROJECT_ID, m.subscription);
        if (await hasBacklog(subClient, subPath)) {
          console.log(`[waker:${m.model}] backlog detected → waking worker`);
          startContainer(m);
        }
      } catch (err) {
        console.error(`[waker:${m.model}] error:`, err.message);
      }
    }
    await sleep(pollMs);
  }
}

main().catch((e) => {
  console.error("[waker] fatal:", e.message);
  process.exit(1);
});
