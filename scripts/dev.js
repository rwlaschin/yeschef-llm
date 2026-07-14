// ============================================================
// Dev - local emulation of the PROD execution model, for the dev-capable models.
//
//   Pub/Sub emulator  +  a "waker" that docker-starts each model's pre-baked image.
//   Prod equivalent: GCE MIG autoscalers waking GPU VMs from baked images.
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
import { renderDockerfile } from "../docker/render.js";
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

// `npm run dev:quick` (DEV_QUICK=1) → run ONLY the single smallest dev model + the fake worker,
// for a fast, low-resource boot when you're just exercising the pipeline. "Smallest" = the raw
// (non-gateway) dev model with the least baker/disk footprint, i.e. llama3.1:8b. The fake worker
// is unaffected — it always starts below.
const QUICK = process.env.DEV_QUICK === "1" || process.env.DEV_QUICK === "true";
function selectedModels() {
  const dev = devModels();
  if (!QUICK) return dev;
  const smallest = dev
    .filter((m) => !m.gateway)
    .sort((a, b) => a.diskGb - b.diskGb)[0] ?? dev[0];
  return [smallest];
}

// Dev-capable models, derived from config/models.js (large/70B excluded via dev:false).
// Sorted so llama3.1:8b builds first (smallest/fastest) — the build loop below is sequential
// and blocking, so this ordering only affects HOW SOON the 8b images finish within that wait,
// not whether anything starts early; the Waker still waits for the whole loop either way.
const DEV_MODELS = selectedModels()
  .map((m) => ({
    name: imageOf(m),
    model: m.model,
    topic: m.topic,
    subscription: subscriptionOf(m),
    gateway: m.gateway || "",
  }))
  .sort((a, b) => (b.model === "llama3.1:8b") - (a.model === "llama3.1:8b"));
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
    // A child dying is NOT grounds to tear down the whole stack. In dev there is no watchdog:
    // one helper (waker/fake worker/a model container) exiting must NEVER kill the emulators or
    // interrupt a job in flight. Just LOG it — the surviving processes keep running, and the user
    // decides when to stop (Ctrl-C → shutdown). Our own shutdown SIGTERMs children (code null),
    // which is expected and silent.
    if (!shuttingDown && code !== 0) {
      console.error(`${name} exited with code ${code} — left the rest of the stack running (not shutting down).`);
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

async function shutdown(reason = "unknown") {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write("\n"); // line feed so ^C isn't left mid-line
  console.log(`Shutting down... (trigger: ${reason}) at ${new Date().toISOString()}`);

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
      // GRACEFUL, never `-f`: `docker stop` sends the worker SIGTERM and lets it exit cleanly
      // (finish the in-flight round) before we remove it. Force-removing (`rm -f` = SIGKILL) is
      // what killed running queries mid-inference — never do that to a worker container.
      execSync(`docker stop ${ids.join(" ")}`, { stdio: "ignore" });
      execSync(`docker rm ${ids.join(" ")}`, { stdio: "ignore" });
      console.log(`Stopped + removed ${ids.length} worker container(s).`);
    }
  } catch { /* docker not running, or nothing to remove */ }
}

process.on("SIGINT", () => shutdown("SIGINT to dev.js"));
process.on("SIGTERM", () => shutdown("SIGTERM to dev.js"));

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
function buildDockerfileVars(m) {
  return {
    name: m.name,
    model: m.model,
    gpu: 1,
    // ENV-sourced (dotenv-flow: .env.dev → .env), not hard-coded. Changing the value in
    // .env.dev changes the recipe hash → the image auto-rebuilds on next `npm run dev`.
    parallel: process.env.OLLAMA_NUM_PARALLEL || 2,
    maxQueue: process.env.OLLAMA_MAX_QUEUE || 5,
    subscription: m.subscription,
    gateway: m.gateway || "",
  };
}

// The image's "recipe" = a short hash of its rendered Dockerfile PLUS the package.json fields the
// image actually installs (dependencies + devDependencies). Stamped on the image as a label at
// build time, then compared on startup: if a model's recipe changed in config/models.js, the
// Dockerfile changed, or a dep changed, the hash differs and we rebuild automatically.
// We hash ONLY the dep maps — NOT the whole file — because the Dockerfile just COPYs package.json
// and runs `npm install`, so scripts/version/engines/etc. don't affect the built image. Hashing
// them would force a multi-GB model re-bake on every unrelated edit (e.g. adding an npm script).
// The engine (Node version) is baked by the Dockerfile's setup_NN.x line, which is already hashed
// via renderDockerfile — package.json `engines` is only an assertion, so excluding it is safe.
const recipeHash = (m) => {
  const pkg = JSON.parse(fs.readFileSync("package.json"));
  return crypto
    .createHash("sha256")
    .update(renderDockerfile(buildDockerfileVars(m)))
    .update(JSON.stringify({ dependencies: pkg.dependencies, devDependencies: pkg.devDependencies }))
    .digest("hex")
    .slice(0, 12);
};
function imageRecipeHash(tag) {
  try { return sh(`docker inspect --format '{{ index .Config.Labels "yeschef.recipe" }}' ${tag}`); }
  catch { return ""; }
}

// Build a model's image from the shared Dockerfile.ejs (bakes the model → no pull at run),
// stamping the recipe hash so a later run can tell when config has drifted from the baked image.
function buildImage(m) {
  const tag = imageTag(m);
  const dockerfile = renderDockerfile(buildDockerfileVars(m));
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
    // /ai/categorize uses the HOST's native Ollama (small model, always up).
    CATEGORIZE_OLLAMA_HOST: process.env.CATEGORIZE_OLLAMA_HOST || "http://localhost:11434",
    CATEGORIZE_OLLAMA_MODEL: process.env.CATEGORIZE_OLLAMA_MODEL || "llama3.2:3b",
  });
  console.log("Waiting for emulators (Pub/Sub + functions)...");
  await sleep(8000);

  // 2. Topics + subscriptions (emulator is ephemeral — every start).
  //    Dev provisions ONLY dev-capable models (the gpu:1 tiers: slim + the two
  //    OpenClaw tiers) — not the 70B (gpu:2) tiers, which need 2× L4.
  process.env.PUBSUB_EMULATOR_HOST = PUBSUB_EMULATOR_HOST;
  await setupPubSub(GCP_PROJECT_ID, selectedModels());

  if (DEV_MODELS.length === 0) throw new Error("No dev models configured — nothing for the waker to watch.");

  // 3. Waker — docker-starts each model's worker on backlog (emulates the MIG autoscaler). Started
  //    BEFORE step 4's builds finish, not after: the waker polls per-model in its own loop with a
  //    try/catch around each model (scripts/waker.js), so a model whose image isn't built yet just
  //    logs and retries next poll — it never blocks on, or crashes because of, the OTHER models. So
  //    the moment the FIRST image (llama3.1:8b, built first — see DEV_MODELS sort above) is ready,
  //    the waker can wake it immediately, while the rest keep building sequentially in step 4 below.
  const wakerModels = DEV_MODELS.map((m) => ({
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
  });

  // 4. Build each dev model image if MISSING or STALE, sequentially (one `docker build` at a time —
  //    concurrent builds contend for the same disk/CPU). Stale = its baked recipe (model tag / gateway
  //    / Dockerfile) no longer matches config — so changing a model in config/models.js auto-rebuilds
  //    that image here, no manual `docker rmi`. (Worker code is mounted, not baked, so code edits never
  //    trigger a rebuild.) A failed build is non-fatal — skip that model; the waker (already running,
  //    watching ALL of DEV_MODELS from step 3 above) will just keep retrying that one model's backlog
  //    check and logging an error until/unless its image ever becomes available.
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

  console.log("\n=== Dev environment ready ===");
  console.log(`  Pub/Sub Emulator : ${PUBSUB_EMULATOR_HOST}`);
  console.log(`  Orchestrator /ai : ${AI_BASE_URL}`);
  console.log(`  Firestore        : PROD (${process.env.FIREBASE_PROJECT_ID || GCP_PROJECT_ID})`);
  console.log(`  Models (on demand):`);
  for (const m of available) console.log(`    - ${m.model}  (${m.subscription} → ${containerName(m)})`);
  console.log(`  (70B/large omitted — needs 2× L4 GPUs)`);
  if (available.length === 0) { console.log("\n(No images built yet — waker is running and will pick them up as they finish.)\n"); return; }
  const ex = available[0]; // derive the example from the actual dev model — never hard-code
  console.log("\nSend a test job (publishes to the emulator topic):");
  console.log(`  PUBSUB_EMULATOR_HOST=${PUBSUB_EMULATOR_HOST} gcloud pubsub topics publish ${ex.topic} \\`);
  console.log(`    --message='{"jobId":"test-1","query":"Please give me a random greeting in any language"}' \\`);
  console.log(`    --project=${GCP_PROJECT_ID}`);
  console.log(`\nRe-test cold start any time with:  docker stop ${containerName(ex)}\n`);
}

main().catch((err) => {
  console.error("Dev startup failed:", err.message);
  shutdown(`main() threw: ${err.message}`);
});
