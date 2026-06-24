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
import crypto from "node:crypto";
import fs from "fs";
import ejs from "ejs";
import { setup as setupPubSub } from "../pubsub/setup.js";
import { killEmulators } from "./kill-emulators.js";
import { devModels, subscriptionOf, imageOf, containerOf, FAKE_SUBSCRIPTION } from "../config/models.js";

dotenvFlow.config();

const { MONGO_URI, MONGO_DB, MONGO_COLLECTION, OLLAMA_API_KEY } = process.env;
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "openclaw-dev-token";
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || "yeschef-c572a";

// Emulator ports come from firebase.json (the single source of truth) so the printed
// test command + the orchestrator URL never go stale when ports change. Defaults match
// firebase.json's current values in case the file/keys are missing.
function emulatorPort(name, fallback) {
  try {
    const cfg = JSON.parse(fs.readFileSync(new URL("../firebase.json", import.meta.url), "utf8"));
    return cfg.emulators?.[name]?.port ?? fallback;
  } catch {
    return fallback;
  }
}
const PUBSUB_EMULATOR_HOST = `localhost:${emulatorPort("pubsub", 8185)}`;
const FUNCTIONS_EMULATOR_PORT = emulatorPort("functions", 5101);
// The orchestrator's local URL (the `ai` function in the functions emulator). The
// orchestrator points its `orchestrate` push subscription at <this>/events.
const AI_BASE_URL = `http://localhost:${FUNCTIONS_EMULATOR_PORT}/${GCP_PROJECT_ID}/us-central1/ai`;

for (const [k, v] of Object.entries({ MONGO_URI, MONGO_DB, MONGO_COLLECTION })) {
  if (!v) throw new Error(`${k} env var is required — check .env or .env.dev`);
}

// Dev-capable models, derived from config/models.js (large/70B excluded via dev:false).
const DEV_MODELS = devModels().map((m) => ({
  name: imageOf(m),
  model: m.model,
  topic: m.topic,
  subscription: subscriptionOf(m),
  gateway: m.gateway || "",
}));
const imageTag = (m) => `yeschef-${m.name}:dev`;
const containerName = containerOf; // single source of truth — see config/models.js

const processes = [];

// Prefix each line of a child stream with a local HH:MM:SS.mmm stamp, then forward
// it to our own stdout/stderr. Buffers partial lines so a stamp never lands mid-line.
function stampLines(src, dest) {
  if (!src) return;
  let buf = "";
  src.setEncoding("utf8");
  src.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop(); // keep the trailing partial line for the next chunk
    const ts = () => new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    // Leave blank lines bare — a lone timestamp on an empty line is just noise.
    for (const line of lines) dest.write(line === "" ? "\n" : `${ts()} ${line}\n`);
  });
  src.on("end", () => { if (buf) dest.write(`${new Date().toISOString().slice(11, 23)} ${buf}\n`); });
}

function start(name, cmd, args, env = {}) {
  console.log(`Starting ${name}...`);
  // detached:true puts the child in its OWN process group. The terminal delivers
  // Ctrl-C (SIGINT) to the foreground group only — i.e. just this parent — so the
  // children are NOT killed out from under us. We trap the signal here and tear
  // them down deliberately (SIGTERM the group → wait → SIGKILL fallback → exit),
  // which is what lets the terminal be restored cleanly instead of left mid-line.
  const proc = spawn(cmd, args, {
    // stdin inherited; stdout/stderr piped so we can stamp each line with a local
    // timestamp (the emulator/worker/ollama lines have none, which makes timing
    // bugs — e.g. Pub/Sub ack-deadline redelivery — impossible to read from a log).
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...process.env, ...env },
    shell: true,
    detached: true,
  });
  stampLines(proc.stdout, process.stdout);
  stampLines(proc.stderr, process.stderr);
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

// The rendered Dockerfile for a model — encodes everything BAKED into its image (the model tag,
// gateway, parallel/maxQueue, and the template itself). Worker code is mounted at run-time, so
// it's NOT in here — which is exactly why editing worker code does NOT trigger a rebuild, but
// changing a model (or the Dockerfile) DOES.
function renderDockerfile(m) {
  const template = fs.readFileSync("docker/Dockerfile.ejs", "utf-8");
  return ejs.render(template, {
    name: m.name,
    model: m.model,
    gpu: 1,
    // ENV-sourced (dotenv-flow: .env.dev → .env), not hard-coded. Changing the value in
    // .env.dev changes the recipe hash → the image auto-rebuilds on next `npm run dev`.
    parallel: process.env.OLLAMA_NUM_PARALLEL || 2,
    maxQueue: process.env.OLLAMA_MAX_QUEUE || 5,
    subscriptions: [m.subscription],
    gateway: m.gateway || "",
  });
}

// The image's "recipe" = a short hash of its rendered Dockerfile PLUS package.json. Stamped on the
// image as a label at build time, then compared on startup: if a model's recipe changed in
// config/models.js (or the Dockerfile changed), the hash differs and we rebuild automatically.
// package.json is included because the Dockerfile only COPYs it (the text never changes) — without
// hashing its CONTENTS, adding/bumping a dep wouldn't flip the image to stale and `npm install`
// would never re-run.
const recipeHash = (m) =>
  crypto.createHash("sha256").update(renderDockerfile(m)).update(fs.readFileSync("package.json")).digest("hex").slice(0, 12);
function imageRecipeHash(tag) {
  try { return sh(`docker inspect --format '{{ index .Config.Labels "yeschef.recipe" }}' ${tag}`); }
  catch { return ""; }
}

// Build a model's image from the shared Dockerfile.ejs (bakes the model → no pull at run),
// stamping the recipe hash so a later run can tell when config has drifted from the baked image.
function buildImage(m) {
  const tag = imageTag(m);
  const dockerfile = renderDockerfile(m);
  console.log(`\nBuilding ${tag} — bakes ${m.model}; first build is slow.\n`);
  execSync(
    `echo '${dockerfile.replace(/'/g, "'\\''")}' | docker build -f - -t ${tag} --label yeschef.recipe=${recipeHash(m)} .`,
    { stdio: "inherit" }
  );
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

  // 0a. Free any emulator ports a prior run orphaned. A crash, a hard Ctrl-C, or a
  //     Docker-down exit can leave the firebase emulator (and its detached `java`
  //     child) bound to its port with no clean handle — which makes the NEXT
  //     `npm run dev` die with "port taken". Clearing them here makes startup
  //     self-healing, the same way removeWorkerContainers() handles stale workers.
  const freed = killEmulators();
  if (freed) console.log("Freed orphaned emulator port holder(s) from a prior run.");

  // 0b. The orchestrator (/ai) runs in the functions emulator alongside Pub/Sub.
  //     Install its deps on first run (the emulator needs functions/node_modules).
  if (!fs.existsSync("functions/node_modules")) {
    console.log("Installing orchestrator (functions) deps...");
    execSync("npm install", { cwd: "functions", stdio: "inherit" });
  }

  // 1. Pub/Sub emulator + the /ai orchestrator (functions emulator), together.
  //    The orchestrator's startup creates the `orchestrate` topic + a push sub to
  //    its own /ai/events. Firestore stays PROD (no Firestore emulator) — the
  //    function writes there via the inherited GOOGLE_APPLICATION_CREDENTIALS, same as the workers.
  start("Emulators (Pub/Sub + /ai orchestrator)", "firebase", [
    "emulators:start",
    "--only=pubsub,functions",
    `--project=${GCP_PROJECT_ID}`,
  ], {
    GCP_PROJECT_ID,
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || GCP_PROJECT_ID,
    AI_BASE_URL, // point the orchestrate push sub at the local /ai/events
    MONGO_URI, // the /ai function reads/writes the Step Library (plan_library) in Mongo
    MONGO_DB,
    DEPLOY_ENV: "dev",
  });
  console.log("Waiting for emulators (Pub/Sub + functions)...");
  await sleep(8000);

  // 2. Topics + subscriptions (emulator is ephemeral — every start).
  //    Dev provisions ONLY dev-capable models (the gpu:1 tiers: slim + the two
  //    OpenClaw tiers) — not the 70B (gpu:2) tiers, which need 2× L4.
  process.env.PUBSUB_EMULATOR_HOST = PUBSUB_EMULATOR_HOST;
  await setupPubSub(GCP_PROJECT_ID, devModels());

  // 3. Build each dev model image if MISSING or STALE. Stale = its baked recipe (model tag /
  //    gateway / Dockerfile) no longer matches config — so changing a model in config/models.js
  //    auto-rebuilds that image here, no manual `docker rmi`. (Worker code is mounted, not baked,
  //    so code edits never trigger a rebuild.) A failed build is non-fatal — skip that model.
  const available = [];
  for (const m of DEV_MODELS) {
    try {
      const tag = imageTag(m);
      if (!imageExists(tag)) {
        buildImage(m);
      } else if (imageRecipeHash(tag) !== recipeHash(m)) {
        console.log(`↻ ${tag} is STALE (model/recipe changed in config) — rebuilding`);
        buildImage(m);
      } else {
        console.log(`✓ Image present: ${tag}`);
      }
      available.push(m);
    } catch (err) {
      console.warn(`⚠️  Skipping ${m.model} — image build failed: ${err.message}`);
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
    BRAVE_API_KEY: process.env.BRAVE_API_KEY,   // optional web_search pool provider
    TAVILY_API_KEY: process.env.TAVILY_API_KEY, // optional web_search pool provider
    OPENCLAW_GATEWAY_TOKEN, // shared token for the OpenClaw gateway (gateway tiers)
    DEPLOY_ENV: "dev", // worker loads inactive prompt_library entries too in dev
  });

  // 4b. Fake/canned worker — a bare node worker (no Docker, no Ollama) that drains the shared
  //     fake subscription and returns canned responses. Fake jobs (fake:true) must NOT wake a
  //     heavy model container, so they get their own lightweight runner that's always up. Boots
  //     on Mongo + Pub/Sub only; Ollama is never touched on the canned path (see worker/index.js).
  start("Fake worker", "node", ["worker/index.js"], {
    PUBSUB_EMULATOR_HOST,
    GCP_PROJECT_ID,
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || GCP_PROJECT_ID,
    SUBSCRIPTION_NAME: FAKE_SUBSCRIPTION,
    MONGO_URI,
    MONGO_DB,
    MONGO_COLLECTION,
    OLLAMA_MODEL: "canned",            // log-only on the fake path; the model is never called
    OLLAMA_HOST: "http://127.0.0.1:0", // unused on the fake path
    DEPLOY_ENV: "dev",
  });

  console.log("\n=== Dev environment ready ===");
  console.log(`  Pub/Sub Emulator : ${PUBSUB_EMULATOR_HOST}`);
  console.log(`  Orchestrator /ai : ${AI_BASE_URL}`);
  console.log(`  Firestore        : PROD (${process.env.FIREBASE_PROJECT_ID || GCP_PROJECT_ID})`);
  console.log(`  Models (on demand):`);
  for (const m of available) console.log(`    - ${m.model}  (${m.subscription} → ${containerName(m)})`);
  console.log(`  (70B/large omitted — needs 2× L4 GPUs)`);
  const ex = available[0]; // derive the example from the actual dev model — never hard-code
  console.log("\nSend a test job (publishes to the emulator topic):");
  console.log(`  PUBSUB_EMULATOR_HOST=${PUBSUB_EMULATOR_HOST} gcloud pubsub topics publish ${ex.topic} \\`);
  console.log(`    --message='{"jobId":"test-1","query":"Please give me a random greeting in any language"}' \\`);
  console.log(`    --project=${GCP_PROJECT_ID}`);
  console.log(`\nRe-test cold start any time with:  docker stop ${containerName(ex)}\n`);
}

main().catch((err) => {
  console.error("Dev startup failed:", err.message);
  shutdown();
});
