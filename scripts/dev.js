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

const { MONGO_URI, MONGO_DB, MONGO_COLLECTION, OLLAMA_API_KEY } = process.env;
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "openclaw-dev-token";
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
  topic: m.topic,
  subscription: subscriptionOf(m),
  gateway: m.gateway || "",
}));
const imageTag = (m) => `yeschef-${m.name}:dev`;
const containerName = (m) => `yeschef-worker-${m.key}-dev`;

const processes = [];

function start(name, cmd, args, env = {}) {
  console.log(`Starting ${name}...`);
  // detached:true puts the child in its OWN process group. The terminal delivers
  // Ctrl-C (SIGINT) to the foreground group only — i.e. just this parent — so the
  // children are NOT killed out from under us. We trap the signal here and tear
  // them down deliberately (SIGTERM the group → wait → SIGKILL fallback → exit),
  // which is what lets the terminal be restored cleanly instead of left mid-line.
  const proc = spawn(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: true,
    detached: true,
  });
  proc.on("exit", (code) => {
    // Ignore exits caused by our own shutdown (SIGTERM/SIGKILL → null/non-zero).
    if (!shuttingDown && code !== 0) {
      console.error(`${name} exited with code ${code}`);
      shutdown();
    }
  });
  processes.push({ name, proc });
  return proc;
}

let shuttingDown = false;

// Kill the child's whole process group (negative pid). Because we spawned with
// detached:true, proc.pid is the group leader, so this also reaps the shell and
// any grandchildren (firebase's java, etc.) — a plain proc.kill() would orphan them.
function killGroup(proc, signal) {
  try { process.kill(-proc.pid, signal); }
  catch { try { proc.kill(signal); } catch { /* already gone */ } }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write("\n"); // line feed so ^C isn't left mid-line
  console.log("Shutting down...");

  // SIGTERM every child group, then WAIT for each to actually exit before we go
  // (SIGKILL fallback after 4s). Waiting is what restores the terminal cleanly.
  await Promise.all(
    processes.map(({ proc }) =>
      new Promise((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
        let killer;
        proc.once("exit", () => { clearTimeout(killer); resolve(); });
        killGroup(proc, "SIGTERM");
        killer = setTimeout(() => killGroup(proc, "SIGKILL"), 4000);
      })
    )
  );

  // Kill every worker container we started, so none linger after dev exits.
  removeWorkerContainers();

  process.stdout.write("\n"); // clean prompt on the next line
  process.exit(0);
}

// Remove ALL worker containers (this run + any leftovers from a previous one).
// Leftover containers are the bug behind "my message isn't handled": a stale
// container holding the name makes the waker think a worker is already up (so it
// never wakes a fresh one), and it may be bound to a now-deleted subscription.
function removeWorkerContainers() {
  try {
    const ids = execSync("docker ps -aq --filter name=yeschef-worker-", { stdio: "pipe" })
      .toString().trim().split("\n").filter(Boolean);
    if (ids.length) {
      execSync(`docker rm -f ${ids.join(" ")}`, { stdio: "ignore" });
      console.log(`Removed ${ids.length} worker container(s).`);
    }
  } catch { /* docker not running, or nothing to remove */ }
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
    gateway: m.gateway || "",
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

  // 0. Clean slate — remove any worker containers left over from a prior run
  //    (e.g. a hard kill that skipped shutdown). A stale one bound to an old
  //    subscription would otherwise block the waker from starting a fresh worker.
  removeWorkerContainers();

  // 1. Pub/Sub emulator
  start("Pub/Sub Emulator", "firebase", [
    "emulators:start",
    "--only=pubsub",
    `--project=${GCP_PROJECT_ID}`,
  ]);
  console.log("Waiting for Pub/Sub emulator...");
  await sleep(5000);

  // 2. Topics + subscriptions (emulator is ephemeral — every start).
  //    Dev provisions ONLY dev-capable models (the gpu:1 tiers: slim + the two
  //    OpenClaw tiers) — not the 70B (gpu:2) tiers, which need 2× L4.
  process.env.PUBSUB_EMULATOR_HOST = PUBSUB_EMULATOR_HOST;
  await setupPubSub(GCP_PROJECT_ID, devModels());

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
    gateway: m.gateway || "",
  }));
  start("Waker", "node", ["scripts/waker.js"], {
    PUBSUB_EMULATOR_HOST,
    GCP_PROJECT_ID,
    WAKER_MODELS: JSON.stringify(wakerModels),
    MONGO_URI,
    MONGO_DB,
    MONGO_COLLECTION,
    OLLAMA_API_KEY, // forwarded into each worker container for web_search/web_fetch
    OPENCLAW_GATEWAY_TOKEN, // shared token for the OpenClaw gateway (gateway tiers)
    DEPLOY_ENV: "dev", // worker loads inactive prompt_library entries too in dev
  });

  console.log("\n=== Dev environment ready ===");
  console.log(`  Pub/Sub Emulator : ${PUBSUB_EMULATOR_HOST}`);
  console.log(`  Firestore        : PROD (${process.env.FIREBASE_PROJECT_ID || GCP_PROJECT_ID})`);
  console.log(`  Models (on demand):`);
  for (const m of available) console.log(`    - ${m.model}  (${m.subscription} → ${containerName(m)})`);
  console.log(`  (70B/large omitted — needs 2× L4 GPUs)`);
  const ex = available[0]; // derive the example from the actual dev model — never hard-code
  console.log("\nSend a test job (publishes to the emulator topic):");
  console.log(`  PUBSUB_EMULATOR_HOST=${PUBSUB_EMULATOR_HOST} gcloud pubsub topics publish ${ex.topic} \\`);
  console.log(`    --message='{"jobId":"test-1","query":"List foods safe for a diabetic diet"}' \\`);
  console.log(`    --project=${GCP_PROJECT_ID}`);
  console.log(`\nRe-test cold start any time with:  docker stop ${containerName(ex)}\n`);
}

main().catch((err) => {
  console.error("Dev startup failed:", err.message);
  shutdown();
});
