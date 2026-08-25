// ============================================================
// Dev - local emulation of the PROD execution model, for the dev-capable models.
//
//   Pub/Sub emulator + the /ai orchestrator. Model workers are started separately.
//
//   The Docker path — a "waker" that docker-starts each model's pre-baked image, mirroring
//   the GCE MIG autoscaler — is still here behind `--only=workers`. It is NOT part of the
//   default because two workers on the SAME subscription are two
//   subscribers on one queue: Pub/Sub splits messages between them, so a job lands on
//   whichever grabbed it first. Start one or the other, never both.
//
// On the Docker path, worker + Ollama + model run INSIDE each image (model baked at build
// time → no runtime pull), matching prod. Dev runs the models that fit a dev box: slim (2B)
// and openclaw. The 70B/large model is omitted — it needs 2× L4 GPUs not present on a
// typical dev machine.
//
// Requires: Firebase CLI (Pub/Sub emulator). Docker only for `--only=workers`.
//
// Usage: npm run dev
// ============================================================

import dotenvFlow from "dotenv-flow";
import { spawn, execSync } from "child_process";
import { setTimeout as sleep } from "timers/promises";
import crypto from "node:crypto";
import fs from "fs";
import { renderDockerfile } from "../docker/render.js";
import { setup as setupPubSub } from "./setup-pubsub.js";
import { killEmulators } from "./kill-emulators.js";
import { devModels, subscriptionOf, imageOf, containerOf, FAKE_SUBSCRIPTION, parallelOf } from "../config/models.js";

dotenvFlow.config();

// Which part to run.
//   --only=all      (default) the /ai orchestrator + Pub/Sub emulator + the canned worker. No Docker.
//   --only=ai       the /ai orchestrator + Pub/Sub emulator. No Docker.
//   --only=fake     ONLY the canned worker — the test-data generator. No Docker, no Ollama, no
//                   image builds. This is what E2E and UI work should run against.
//   --only=workers  the waker + real model containers + image builds. Needs Docker.
//                   Pair with DEV_QUICK=1 to limit it to the smallest model (llama3.1:8b).
// Split so a process manager can restart one without dropping the others: rebuilding a model image
// shouldn't take the orchestrator down, and restarting /ai shouldn't kill warm containers.
// Validated FIRST, before any env requirement, so a typo'd flag reports the typo.
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").split("=")[1] || "all";
if (!["all", "ai", "workers", "fake"].includes(ONLY)) {
  throw new Error(`--only must be ai|fake|workers|all, got "${ONLY}"`);
}
const RUN_AI = ONLY === "all" || ONLY === "ai";
// Docker workers are OPT-IN, never part of the default. Two workers on one subscription are
// two subscribers on one queue — Pub/Sub
// splits the messages between them, so each job lands on whichever grabbed it first.
const RUN_WORKERS = ONLY === "workers";

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

// DEV_QUICK=1 (`npm run dev:quick`, `npm run dev:workers:8b`) → narrow every model-driven step to
// the single smallest dev model, for a fast, low-resource boot when you're just exercising the
// pipeline: it provisions only that model's topics, and on the Docker path builds/wakes only it.
// "Smallest" = the raw (non-gateway) dev model with the least baker/disk footprint, i.e.
// llama3.1:8b. The fake worker is unaffected — it always starts below.
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
    parallel: parallelOf(m),
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
    // Derived from config/models.js and transported to the worker as OLLAMA_NUM_PARALLEL.
    parallel: parallelOf(m),
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

// The Pub/Sub emulator is EPHEMERAL: its subscriptions are recreated on every /ai start, and the
// worker's subscriber stream does not retry after "Subscription does not exist" — it closes for
// good and then sits there deaf, silently swallowing every fake job while callers wait forever.
// So block until the subscription is actually there before spawning the worker.
async function waitForFakeSubscription(timeoutMs = 90_000) {
  const { PubSub } = await import("@google-cloud/pubsub");
  process.env.PUBSUB_EMULATOR_HOST = PUBSUB_EMULATOR_HOST;
  const ps = new PubSub({ projectId: GCP_PROJECT_ID });
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    try {
      const [exists] = await ps.subscription(FAKE_SUBSCRIPTION).exists();
      if (exists) return true;
    } catch { /* emulator not up yet */ }
    if (!announced) { console.log(`Waiting for ${FAKE_SUBSCRIPTION} (provisioned by the /ai half)...`); announced = true; }
    await sleep(1000);
  }
  return false;
}

async function startFakeWorker() {
  if (!(await waitForFakeSubscription())) {
    throw new Error(`${FAKE_SUBSCRIPTION} never appeared — is the /ai half running? (npm run dev:ai)`);
  }
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
}

async function main() {
  console.log(`\n=== Starting Dev Environment (${ONLY}) ===\n`);

  // The canned worker is CPU-only — no Docker, no Ollama, no model images (fake-canned-mode.md).
  // Running it alone is what makes E2E and UI work fast, so it must not be gated behind any of that.
  if (ONLY === "fake") {
    await startFakeWorker();
    console.log("\n=== Fake/canned worker ready ===");
    console.log(`  Draining : ${FAKE_SUBSCRIPTION}`);
    console.log("  Fake jobs return deterministic canned output — no inference.\n");
    return;
  }

  // Only --only=workers touches Docker, so no other mode — the default included — may require
  // Docker Desktop to be running.
  if (RUN_WORKERS) {
    try {
      sh("docker info");
    } catch {
      throw new Error("Docker is not running. Start Docker Desktop and retry.");
    }

    // 0. Clean slate — remove any worker containers left over from a prior run
    //    (e.g. a hard kill that skipped shutdown). A stale one bound to an old
    //    subscription would otherwise block the waker from starting a fresh worker.
    removeWorkerContainers();
  }

  // 0a. Free any emulator ports a prior run orphaned. A crash, a hard Ctrl-C, or a
  //     Docker-down exit can leave the firebase emulator (and its detached `java`
  //     child) bound to its port with no clean handle — which makes the NEXT
  //     `npm run dev` die with "port taken". Clearing them here makes startup
  //     self-healing, the same way removeWorkerContainers() handles stale workers.
  //     Only the /ai half owns those ports, so --only=workers must NOT clear them — it would kill
  //     a perfectly healthy orchestrator running as its own process.
  const freed = RUN_AI ? killEmulators() : 0;
  if (freed) console.log("Freed orphaned emulator port holder(s) from a prior run.");

  // 0b. The orchestrator (/ai) runs in the functions emulator alongside Pub/Sub.
  //     Install its deps on first run (the emulator needs functions/node_modules).
  if (RUN_AI && !fs.existsSync("functions/node_modules")) {
    console.log("Installing orchestrator (functions) deps...");
    execSync("npm install", { cwd: "functions", stdio: "inherit" });
  }

  // 1. Pub/Sub emulator + the /ai orchestrator (functions emulator), together.
  //    The orchestrator's startup creates the `orchestrate` topic + a push sub to
  //    its own /ai/events. Firestore stays PROD (no Firestore emulator) — the
  //    function writes there via the inherited GOOGLE_APPLICATION_CREDENTIALS, same as the workers.
  if (RUN_AI) {
    start("Emulators (Pub/Sub + /ai orchestrator)", "firebase", [
      "emulators:start",
      "--only=pubsub,functions",
      `--project=${GCP_PROJECT_ID}`,
    ], {
      GCP_PROJECT_ID,
      FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || GCP_PROJECT_ID,
      // WITHOUT THIS THE /ai FUNCTION TALKS TO REAL GCP PUB/SUB. We start the Pub/Sub emulator two
      // lines up and then have to TELL the function to use it — the client library only switches on
      // this env var. Omitting it made configurePubSub() create `sub_orchestrate_push` in the real
      // project, pushing every LOCAL job's completion to the DEPLOYED /ai/events instead of
      // localhost. Nothing advanced the cursor, so jobs sat at status "running" forever with no
      // error — the exact symptom pubsub.js:19-23 warns about. The guard there refuses to CREATE a
      // prod-pointing sub, but it cannot delete one that already exists, so this must not regress.
      PUBSUB_EMULATOR_HOST,
      AI_BASE_URL, // point the orchestrate push sub at the local /ai/events
      MONGO_URI, // the /ai function reads/writes the Step Library (plan_library) in Mongo
      MONGO_DB,
    });
    console.log("Waiting for emulators (Pub/Sub + functions)...");
    await sleep(8000);
  }

  // 2. Topics + subscriptions (emulator is ephemeral — every start).
  //    Dev provisions ONLY dev-capable models (the gpu:1 tiers: slim + the two
  //    OpenClaw tiers) — not the 70B (gpu:2) tiers, which need 2× L4.
  //    Both halves need the emulator host, but only the /ai half PROVISIONS — with --only=workers
  //    the topics already exist, and re-running setup would race the live orchestrator.
  process.env.PUBSUB_EMULATOR_HOST = PUBSUB_EMULATOR_HOST;
  if (RUN_AI) await setupPubSub(GCP_PROJECT_ID, selectedModels());

  // The canned worker is not a model worker — nothing else drains its subscription, so it keeps
  // starting on the default path exactly as it always has. `--only=ai` still leaves it out.
  if (ONLY === "all") await startFakeWorker();

  if (!RUN_WORKERS) {
    console.log("\n=== /ai orchestrator ready ===");
    console.log(`  Pub/Sub Emulator : ${PUBSUB_EMULATOR_HOST}`);
    console.log(`  Orchestrator /ai : ${AI_BASE_URL}`);
    console.log(`  Firestore        : PROD (${process.env.FIREBASE_PROJECT_ID || GCP_PROJECT_ID})`);
    console.log("  Model workers    : start separately, or use `npm run dev:workers`.");
    return;
  }

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

  // 4b. Fake/canned worker — see startFakeWorker(). Runs on this path too, so `--only=workers`
  //     still covers the canned path; `--only=fake` runs it alone, with no Docker and no builds.
  await startFakeWorker();

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
