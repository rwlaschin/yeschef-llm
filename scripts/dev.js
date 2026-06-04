// ============================================================
// Dev - local emulation of the PROD execution model, for the dev-capable models.
//
//   Pub/Sub emulator  +  a "waker" that docker-starts each model's pre-baked image.
//   Prod equivalent: GCE MIG autoscalers waking spot GPU VMs from baked images.
//
// Worker + Ollama + model run INSIDE each Docker image (model baked at build time
// → no runtime pull), matching prod. No native Ollama here.
//
// Dev runs the models that fit a dev box: slim (2B) and openclaw. The 70B/large
// model is omitted — it needs 2× L4 GPUs not present on a typical dev machine.
//
// Requires: Firebase CLI (Pub/Sub emulator) + Docker.
//
// Usage: npm run dev
// ============================================================

import dotenvFlow from "dotenv-flow";
import { spawn, execSync } from "child_process";
import { setTimeout as sleep } from "timers/promises";
import fs from "fs";
import ejs from "ejs";
import { setup as setupPubSub } from "../pubsub/setup.js";
import { devModels, subscriptionOf, imageOf } from "../config/models.js";

dotenvFlow.config();

const { MONGO_URI, MONGO_DB, MONGO_COLLECTION } = process.env;
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || "yeschef-c572a";
const PUBSUB_EMULATOR_HOST = "localhost:8085";

for (const [k, v] of Object.entries({ MONGO_URI, MONGO_DB, MONGO_COLLECTION })) {
  if (!v) throw new Error(`${k} env var is required — check .env or .env.dev`);
}

// Dev-capable models, derived from config/models.js (large/70B excluded via dev:false).
const DEV_MODELS = devModels().map((m) => ({
  key: m.key,
  name: imageOf(m),
  model: m.model,
  subscription: subscriptionOf(m),
}));
const imageTag = (m) => `yeschef-${m.name}:dev`;
const containerName = (m) => `yeschef-worker-${m.key}-dev`;

const processes = [];

function start(name, cmd, args, env = {}) {
  console.log(`Starting ${name}...`);
  const proc = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, ...env }, shell: true });
  proc.on("exit", (code) => {
    if (code !== 0) {
      console.error(`${name} exited with code ${code}`);
      shutdown();
    }
  });
  processes.push({ name, proc });
  return proc;
}

function shutdown() {
  console.log("\nShutting down...");
  for (const { name, proc } of processes) {
    console.log(`  Stopping ${name}`);
    proc.kill();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function sh(cmd) {
  return execSync(cmd, { stdio: "pipe" }).toString().trim();
}

function imageExists(tag) {
  try {
    return !!sh(`docker images -q ${tag}`);
  } catch {
    return false;
  }
}

// Build a model's image from the shared Dockerfile.ejs (bakes the model → no pull at run).
function buildImage(m) {
  const tag = imageTag(m);
  const template = fs.readFileSync("docker/Dockerfile.ejs", "utf-8");
  const dockerfile = ejs.render(template, {
    name: m.name,
    model: m.model,
    gpu: 1,
    parallel: 2,
    maxQueue: 5,
    subscriptions: [m.subscription],
  });
  console.log(`\nBuilding ${tag} — bakes ${m.model}; first build is slow.\n`);
  execSync(`echo '${dockerfile.replace(/'/g, "'\\''")}' | docker build -f - -t ${tag} .`, { stdio: "inherit" });
}

async function main() {
  console.log("\n=== Starting Dev Environment (Docker) ===\n");

  try {
    sh("docker info");
  } catch {
    throw new Error("Docker is not running. Start Docker Desktop and retry.");
  }

  // 1. Pub/Sub emulator
  start("Pub/Sub Emulator", "firebase", [
    "emulators:start",
    "--only=pubsub",
    `--project=${GCP_PROJECT_ID}`,
  ]);
  console.log("Waiting for Pub/Sub emulator...");
  await sleep(5000);

  // 2. Topics + subscriptions (emulator is ephemeral — every start)
  process.env.PUBSUB_EMULATOR_HOST = PUBSUB_EMULATOR_HOST;
  await setupPubSub(GCP_PROJECT_ID);

  // 3. Build each dev model image if missing. A failed build (e.g. openclaw not
  //    pullable) is non-fatal — that model is skipped, others still run.
  const available = [];
  for (const m of DEV_MODELS) {
    try {
      if (!imageExists(imageTag(m))) buildImage(m);
      else console.log(`✓ Image present: ${imageTag(m)}`);
      available.push(m);
    } catch (err) {
      console.warn(`⚠️  Skipping ${m.key} — image build failed: ${err.message}`);
    }
  }
  if (available.length === 0) throw new Error("No dev model images available — cannot start waker.");

  // 4. Waker — docker-starts each model's worker on backlog (emulates the MIG autoscaler).
  const wakerModels = available.map((m) => ({
    subscription: m.subscription,
    image: imageTag(m),
    container: containerName(m),
    model: m.model,
  }));
  start("Waker", "node", ["scripts/waker.js"], {
    PUBSUB_EMULATOR_HOST,
    GCP_PROJECT_ID,
    WAKER_MODELS: JSON.stringify(wakerModels),
    MONGO_URI,
    MONGO_DB,
    MONGO_COLLECTION,
  });

  console.log("\n=== Dev environment ready ===");
  console.log(`  Pub/Sub Emulator : ${PUBSUB_EMULATOR_HOST}`);
  console.log(`  Firestore        : PROD (${process.env.FIREBASE_PROJECT_ID || GCP_PROJECT_ID})`);
  console.log(`  Models (on demand):`);
  for (const m of available) console.log(`    - ${m.model}  (${m.subscription} → ${containerName(m)})`);
  console.log(`  (70B/large omitted — needs 2× L4 GPUs)`);
  console.log("\nSend a test job (publishes to the emulator topic):");
  console.log(`  PUBSUB_EMULATOR_HOST=${PUBSUB_EMULATOR_HOST} gcloud pubsub topics publish llama3_2b_v1 \\`);
  console.log(`    --message='{"jobId":"test-1","query":"List foods safe for a diabetic diet"}' \\`);
  console.log(`    --project=${GCP_PROJECT_ID}`);
  console.log("\nRe-test cold start any time with:  docker stop yeschef-worker-slim-dev\n");
}

main().catch((err) => {
  console.error("Dev startup failed:", err.message);
  shutdown();
});
