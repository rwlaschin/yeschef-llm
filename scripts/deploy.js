// ============================================================
// Deploy — GCE MIG with baked custom GCE images (no boot-time Docker pull).
//
//   1. build the Docker image (Ollama + worker + baked model) → Artifact Registry
//   2. bake a GCE custom image: launch a baker VM, docker pull, stop VM, snapshot
//   3. instance template: GPU L4(s), custom image; startup just runs the container
//   4. managed instance group + autoscaler on Pub/Sub backlog (min 0 → max N)
//
// One VM per replica. GPU count comes from the model's "machine description":
//   gpu:1 → 1× L4 (g2-standard-8),  gpu:2 → 2× L4 (g2-standard-24, one box).
//
// Scale-to-zero + no cluster fee. The worker acks only after the final Firestore write,
// so an instance lost to scale-in, host maintenance, or a crash leaves its job unacked —
// Pub/Sub redelivers it and another VM finishes it (jobId idempotency guards partial writes).
//
// Applies for real by default. Pass --dry-run to only PRINT the gcloud/docker
// commands without executing them (preview the plan).
// ============================================================

import dotenvFlow from "dotenv-flow";
import { execSync, exec } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import util from "util";
import crypto from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import { fileURLToPath } from "url";
import { renderDockerfile } from "../docker/render.js";
import { setup as setupPubSub } from "./setup-pubsub.js";
import { MODELS, subscriptionOf, imageOf, FAKE_SUBSCRIPTION, parallelOf } from "../config/models.js";
import { getWorkerRegions } from "../functions/entry/ai/capacity/regions.js";

dotenvFlow.config();

// Per-image async context — carries the running model's capture-log fd through the parallel GPU
// pipeline so run()/runAsync()/console.log route THAT image's verbose gcloud output to its own temp
// log file instead of interleaving on the terminal (the terminal shows only the status region). No
// store elsewhere (fake worker, setup, dry-run) → output goes to the terminal exactly as before.
const als = new AsyncLocalStorage();

const _log = console.log.bind(console);
const _stamp = () => `[${new Date().toLocaleTimeString()}]`;
console.log = (...args) => {
  const store = als.getStore();
  if (store && store.logFd != null) {
    try { fs.writeSync(store.logFd, `${_stamp()} ${util.format(...args)}\n`); } catch { /* logging only */ }
    return;
  }
  _log(_stamp(), ...args);
};

const {
  GCP_PROJECT_ID,
  GCP_REGION = "us-central1",
  GCP_ZONE,
  GCP_NETWORK = "default",
  GCP_SERVICE_ACCOUNT, // VM identity; needs Firestore + Pub/Sub access (ADC in prod)
  MONGO_URI,
  MONGO_DB,
  MONGO_COLLECTION,
  FIREBASE_PROJECT_ID,
  OLLAMA_API_KEY, // worker requires this for every non-fake tier (web_search/web_fetch) — no key, no boot
} = process.env;

// Applies for real by default. Pass --dry-run to only print the commands (no execution).
const args = process.argv.slice(2);
const DRY_RUN = args.some((a) => a === "--dry-run" || a === "--dry-run=1" || a === "--dry-run=true");
const APPLY = !DRY_RUN;

for (const [k, v] of Object.entries({
  GCP_PROJECT_ID, GCP_ZONE, GCP_SERVICE_ACCOUNT, MONGO_URI, MONGO_DB, MONGO_COLLECTION, OLLAMA_API_KEY,
})) {
  if (!v) throw new Error(`${k} env var is required`);
}

const REGISTRY = `${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/ollama`;
const VERSION = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19).toLowerCase();

// Hash the files that affect the image content: Dockerfile template + all worker/config code.
// If the hash tag already exists in Artifact Registry, the build is skipped (nothing changed).
function contentHash(dockerfile) {
  const hash = crypto.createHash("sha256");
  hash.update(dockerfile);
  for (const dir of ["worker", "config"]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir, { recursive: true }).sort()) {
      const full = `${dir}/${f}`;
      if (fs.statSync(full).isFile()) hash.update(fs.readFileSync(full));
    }
  }
  return hash.digest("hex").slice(0, 12);
}

// Validate a model name exists in Ollama's registry before building.
// Uses the OCI manifest endpoint — 200 = exists, 404 = bad model name.
function validateOllamaModel(model) {
  const [name, tag = "latest"] = model.split(":");
  const url = `https://registry.ollama.ai/v2/library/${name}/manifests/${tag}`;
  try {
    execSync(`curl -sf -o /dev/null -w "%{http_code}" "${url}" | grep -q "^200$"`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function imageExistsInRegistry(tag) {
  try {
    execSync(`gcloud artifacts docker images describe ${tag} --project=${GCP_PROJECT_ID} --quiet`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

const BASE_DOCKERFILE_PATH = "docker/Dockerfile.base";

// Shared base image (Ollama + Node 22 + git/curl) that every per-model Dockerfile.prod.ejs
// FROMs — built ONCE per unique Dockerfile.base content instead of 7x (once per model) per
// deploy. Content-hash keyed: only rebuilds when Dockerfile.base itself changes (staleness
// trade-off is documented in that file). Returns the image tag to use as `baseImage`.
async function ensureBaseImage() {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(BASE_DOCKERFILE_PATH)).digest("hex").slice(0, 12);
  const tag = `${REGISTRY}/ollama-base:${hash}`;
  const tagLatest = `${REGISTRY}/ollama-base:latest`;

  if (!APPLY) {
    console.log(`[dry-run] ensure base image ${tag}`);
    return tag;
  }

  if (imageExistsInRegistry(tag)) {
    console.log(`\n✓ Base image unchanged (${hash}) — skipping build.`);
  } else {
    console.log(`\n==== ollama-base hash=${hash} — building shared base image ====`);
    const cbName = "cloudbuild.ollama-base.yaml";
    fs.writeFileSync(
      cbName,
      `steps:\n- name: 'gcr.io/cloud-builders/docker'\n` +
        `  args: ['build', '-f', '${BASE_DOCKERFILE_PATH}', '-t', '${tag}', '.']\n` +
        `  timeout: 1200s\nimages:\n- '${tag}'\ntimeout: 1200s\n`
    );
    try {
      await run(`gcloud builds submit . --project=${GCP_PROJECT_ID} --region=${GCP_REGION} --config=${cbName}`);
    } finally {
      try { fs.unlinkSync(cbName); } catch {}
    }
  }
  await run(`gcloud artifacts docker tags add ${tag} ${tagLatest} --project=${GCP_PROJECT_ID}`);
  return tag;
}

// gpu count → g2 machine type (L4s on a single box)
const MACHINE_BY_GPU = { 1: "g2-standard-8", 2: "g2-standard-24" };

// Generation slots come from config/models.js (parallelOf) — the same number the worker leases against
// and the autoscaler sizes on. Not redefined here.
const DEFAULTS = { maxQueue: 5, gpu: 1, maxReplicas: 7 };

// Derived from the single source of truth (config/models.js).
// gpu = the model's "machine description" (L4s on one VM).
const IMAGES_ALL = MODELS.map((m) => ({
  name: imageOf(m),
  subscription: subscriptionOf(m),
  model: m.model,
  gpu: m.gpu,
  diskGb: m.diskGb,
  dev: m.dev,         // true = also runs in dev; false = prod-only (build on Cloud Build)
  gateway: m.gateway || null,
  // The model owns its generation capacity. This derived value is baked into the image and passed
  // to the runtime container as OLLAMA_NUM_PARALLEL; no deploy environment can override it.
  parallel: parallelOf(m),
  maxQueue: process.env.OLLAMA_MAX_QUEUE || DEFAULTS.maxQueue,
}));
// Deploy every GPU model except OpenClaw (Llama 3.3 70B) — held back for now. deployFake (the
// fake/canned worker) runs independently of this filter.
const IMAGES = IMAGES_ALL.filter((img) => img.name !== "ollama-openclaw-llama3-3-70b-v1");

// Async so the caller's `await` yields to the event loop while gcloud runs — that's what keeps the
// progress table's 1s timer ticking during long mutations (a synchronous execSync would block the
// loop and freeze the "elapsed" clock, making a live deploy look hung). Delegates to runAsync, which
// already captures to the per-image log fd (or streams to the terminal). EVERY caller must await it.
function run(cmd) {
  return runAsync(cmd);
}

// Async variant for parallel Cloud Build submissions. Inside a per-image pipeline the child's
// stdout/stderr are captured to that image's log fd; otherwise streamed live to the terminal.
function runAsync(cmd) {
  if (!APPLY) { console.log(`\n[dry-run] ${cmd}\n`); return Promise.resolve(); }
  console.log(`\n> ${cmd}\n`);
  const fd = als.getStore()?.logFd;
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { maxBuffer: 50 * 1024 * 1024 });
    if (fd != null) {
      child.stdout.on("data", (d) => { try { fs.writeSync(fd, d); } catch { /* logging only */ } });
      child.stderr.on("data", (d) => { try { fs.writeSync(fd, d); } catch { /* logging only */ } });
    } else {
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
    }
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Exit ${code}: ${cmd.slice(0, 100)}`))
    );
  });
}


function esc(s) {
  return s.replace(/'/g, "'\\''");
}

// Every baker/worker VM lands in the same VPC with full cloud-platform scope under the deploy SA.
const VM_NET_FLAGS = `--network=${GCP_NETWORK} --scopes=cloud-platform --service-account=${GCP_SERVICE_ACCOUNT}`;

// startup-script + serial logging, shared by every VM create. `extra` appends more --metadata keys
// (the baker adds enable-guest-attributes=TRUE for its bake/status signalling).
const vmMetadataFlag = (script, extra = "") =>
  `--metadata=startup-script='${esc(script)}',serial-port-logging-enable=true${extra}`;

// ── Shared build / template / MIG primitives (used by BOTH deployFake and the GPU pipeline) ──────
// Pure DRY: behaviour is identical to the inline logic they replaced. Each call site passes its own
// differences (Dockerfile, machine type, region/zones, surge, create command) as args.

// Build the image if its content-hash tag is absent — skip when it already exists (nothing changed).
// Writes a temp cloudbuild config (and, when `dfName` is given, the rendered Dockerfile), submits
// the build, and cleans the temp files up. Returns { tagHash, tagLatest, build } where `build` is a
// Promise for the submission — already-resolved when skipped, in dry-run, or for a synchronous submit.
function ensureImage({ name, hash, cbYaml, dfName = null, dockerfile = null, async: useAsync = false }) {
  const tagHash = `${REGISTRY}/${name}:${hash}`;
  const tagLatest = `${REGISTRY}/${name}:latest`;
  if (APPLY && imageExistsInRegistry(tagHash)) {
    console.log(`  ✓ Image unchanged (${hash}) — skipping build.`);
    return { tagHash, tagLatest, build: Promise.resolve() };
  }
  const cbName = `cloudbuild.${name}.yaml`;
  if (dfName) fs.writeFileSync(dfName, dockerfile);
  fs.writeFileSync(cbName, cbYaml);
  const submit = `gcloud builds submit . --project=${GCP_PROJECT_ID} --region=${GCP_REGION} --config=${cbName}`;
  const cleanup = () => {
    if (dfName) { try { fs.unlinkSync(dfName); } catch { /* best-effort */ } }
    try { fs.unlinkSync(cbName); } catch { /* best-effort */ }
  };
  // Both paths return a build promise; the caller awaits `.build`. cleanup() runs via .finally so the
  // temp cloudbuild yaml survives until `gcloud builds submit` is done reading it (awaiting run() and
  // deleting synchronously would race the still-running submit).
  return { tagHash, tagLatest, build: run(submit).finally(cleanup) };
}

// Create the (content-hash-keyed, stable-named) instance template if it doesn't already exist — an
// unchanged redeploy would otherwise hit ALREADY_EXISTS on create. `hashNote` is appended to the
// skip log (GPU tiers include the hash, the fake tier doesn't) so the message is unchanged.
async function ensureTemplate({ template, createCmd, hashNote = "" }) {
  let exists = false;
  try {
    execSync(`gcloud compute instance-templates describe ${template} --project=${GCP_PROJECT_ID} --format="value(name)"`, { stdio: "pipe" });
    exists = true;
  } catch { /* doesn't exist yet */ }
  if (exists) {
    console.log(`  ✓ Template ${template} already exists${hashNote} — skipping create.`);
    return;
  }
  await run(createCmd);
}

// Point a MIG at `template`: create it (via the caller's create command) if absent, otherwise roll
// it onto the template — but ONLY when it isn't already on it. set-instance-template alone changes
// the recipe for FUTURE instances only, so rolling-action (max-unavailable=0: a new box comes up
// before an old one is removed) is what actually replaces running instances; skipping both when the
// MIG is already on this (hash-identical) template is what stops an unchanged redeploy from need-
// lessly recreating every VM (cost + stockout risk).
async function ensureMigOnTemplate({ mig, region, template, surge, createCmd, skipMsg }) {
  let migExists = false;
  try {
    execSync(`gcloud compute instance-groups managed describe ${mig} --project=${GCP_PROJECT_ID} --region=${region} --format="value(name)"`, { stdio: "pipe" });
    migExists = true;
  } catch { /* doesn't exist yet */ }

  if (!migExists) { await run(createCmd); return; }

  let currentTmpl = "";
  try {
    currentTmpl = execSync(
      `gcloud compute instance-groups managed describe ${mig} --project=${GCP_PROJECT_ID} --region=${region} --format="value(instanceTemplate)"`,
      { stdio: "pipe" }
    ).toString().trim().split("/").pop() || "";
  } catch { /* fall through to roll */ }
  if (currentTmpl === template) {
    if (skipMsg) console.log(skipMsg);
    return;
  }
  await run(`gcloud compute instance-groups managed set-instance-template ${mig} --project=${GCP_PROJECT_ID} --region=${region} --template=${template}`);
  await run(`gcloud compute instance-groups managed rolling-action start-update ${mig} --project=${GCP_PROJECT_ID} --region=${region} --version=template=${template} --max-surge=${surge} --max-unavailable=0`);
}

// One re-rendered status region for the parallel worker pipeline. The per-image gcloud streams are
// captured to temp log files (see run/runAsync), so the terminal shows ONLY this compact status: a
// TTY redraws an in-place table (elapsed ticks ~1s); a non-TTY/CI stream emits one summary line
// every ~10s plus per-image phase/done/fail milestones (never a 60s silent gap, never per-image
// spam). On a failure the offending image's captured log is dumped so the error is visible. Fully
// disabled (no fds, no timer, all methods no-ops) under dry-run, where run() prints the plan instead.
export function createProgress(names, { enabled }) {
  const tty = enabled && !!process.stdout.isTTY;
  const t0 = Date.now();
  const items = new Map();
  for (const name of names) {
    const logPath = enabled ? path.join(os.tmpdir(), `deploy-${name}-${process.pid}.log`) : null;
    items.set(name, {
      phase: "queued",
      state: "run",                 // run | done | failed
      startTs: Date.now(),
      logPath,
      logFd: logPath ? fs.openSync(logPath, "a") : null,
    });
  }
  let timer = null, lastLines = 0, lastSummaryTs = 0;

  const mmss = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  const label = (it) => (it.state === "done" ? "✓ done" : it.state === "failed" ? "✗ failed" : it.phase);

  const renderTty = () => {
    const now = Date.now();
    const width = Math.max(6, ...[...items.keys()].map((n) => n.length));
    const lines = [`Workers — ${mmss(now - t0)} elapsed`];
    for (const [name, it] of items) {
      lines.push(`  ${name.padEnd(width)}  ${label(it).padEnd(9)}  ${mmss(now - it.startTs)}`);
    }
    let out = lastLines ? `\x1b[${lastLines}A\x1b[0J` : "";  // move up + clear, then redraw in place
    out += lines.join("\n") + "\n";
    process.stdout.write(out);
    lastLines = lines.length;
  };

  const summary = () => {
    const c = {};
    for (const it of items.values()) {
      const k = it.state === "done" ? "done" : it.state === "failed" ? "failed" : it.phase;
      c[k] = (c[k] || 0) + 1;
    }
    return Object.entries(c).map(([k, v]) => `${k} ${v}`).join(" · ");
  };
  const renderNonTty = (force) => {
    const now = Date.now();
    if (!force && now - lastSummaryTs < 10_000) return;
    lastSummaryTs = now;
    _log(`${_stamp()} … ${summary()} (${mmss(now - t0)} elapsed)`);
  };

  return {
    logFd: (name) => items.get(name)?.logFd ?? null,
    phase(name, phase) {
      const it = items.get(name); if (!it) return;
      it.phase = phase;
      if (enabled && !tty) _log(`${_stamp()} ▶ ${name} → ${phase}`);
    },
    done(name) {
      const it = items.get(name); if (!it) return;
      it.state = "done";
      if (enabled && !tty) _log(`${_stamp()} ✓ ${name} done (${mmss(Date.now() - it.startTs)})`);
    },
    fail(name) {
      const it = items.get(name); if (!it) return;
      it.state = "failed";
      if (enabled && it.logFd != null) {
        try {
          const body = fs.readFileSync(it.logPath, "utf-8");
          _log(`\n===== ${name} FAILED — captured log =====\n${body}\n===== end ${name} log =====\n`);
          if (tty) lastLines = 0;   // the dump broke the in-place table; next render draws fresh below it
        } catch { /* no log to dump */ }
      }
      if (enabled && !tty) _log(`${_stamp()} ✗ ${name} failed (${mmss(Date.now() - it.startTs)})`);
    },
    start() {
      if (!enabled) return;
      if (tty) { renderTty(); timer = setInterval(renderTty, 1000); }
      else { renderNonTty(true); timer = setInterval(() => renderNonTty(false), 1000); }
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (!enabled) return;
      if (tty) renderTty(); else renderNonTty(true);
      for (const it of items.values()) {
        if (it.logFd != null) { try { fs.closeSync(it.logFd); } catch { /* best-effort */ } }
        if (it.logPath) { try { fs.unlinkSync(it.logPath); } catch { /* best-effort */ } }
      }
    },
  };
}

// Autoscale a MIG on its Pub/Sub subscription backlog: 0 → maxReplicas, full scale-in after a 60s
// window. `singleInstanceAssignment` = how many undelivered messages one instance covers; set it to
// the model's declared concurrency so the autoscaler provisions 1 box per N messages,
// NOT 1 box per message (the old =1 over-provisioned by the concurrency factor). SHARED by the GPU
// tiers AND the fake tier so their scaling policy can't drift.
function setMigAutoscaling({ mig, region, subscription, maxReplicas, singleInstanceAssignment = 1 }) {
  const assign = Math.max(1, parseInt(singleInstanceAssignment, 10) || 1);
  return run(
    `gcloud compute instance-groups managed set-autoscaling ${mig} --project=${GCP_PROJECT_ID} ` +
      `--region=${region} --min-num-replicas=0 --max-num-replicas=${maxReplicas} ` +
      `--update-stackdriver-metric=pubsub.googleapis.com/subscription/num_undelivered_messages ` +
      `--stackdriver-metric-filter='resource.type="pubsub_subscription" AND resource.label.subscription_id="${subscription}"' ` +
      `--stackdriver-metric-single-instance-assignment=${assign} ` +
      `--scale-in-control=max-scaled-in-replicas-percent=100,time-window=60`
  );
}

// Emit a start/finish pair per phase — NOT a single post-hoc duration log. A single
// end-of-phase log is blind to a hung or killed process: no start record means no way to
// even tell it began, let alone diagnose where it died. ident+action+time lets the dashboard
// show a start with no matching finish as a visibly open, never-closed span.
function logEvent(model, phase, action, extra = {}) {
  if (!APPLY) return;
  const payload = JSON.stringify({ model, phase, action, ts: new Date().toISOString(), ...extra }).replace(/'/g, "'\\''");
  try {
    execSync(`gcloud logging write deploy_phases '${payload}' --payload-type=json --severity=INFO --project=${GCP_PROJECT_ID}`, { stdio: "pipe" });
  } catch { /* observability only — never fail the deploy over a logging hiccup */ }
}

// Runs fn, logging a "start" event before it begins and a "finish" event in a finally (so
// finish fires on success AND on a thrown error — only a hard process kill leaves a start
// with no finish, which is exactly the signal we want for "it blew up silently").
async function timedPhase(model, phase, fn) {
  logEvent(model, phase, "start");
  const t0 = Date.now();
  let status = "success";
  try {
    return await fn();
  } catch (err) {
    status = "failed";
    throw err;
  } finally {
    logEvent(model, phase, "finish", { durationSec: (Date.now() - t0) / 1000, status });
  }
}

// Startup script for baked GCE VMs — Docker image is already on disk; no pull needed.
// DLVM base image ships with NVIDIA drivers + nvidia-container-toolkit pre-installed,
// so no GPU driver step is needed at boot. Just run the container.
function vmStartupScript(img, tag) {
  return [
    "#!/bin/bash",
    "set -e",
    `docker run -d --name worker --restart=on-failure \\`,
    `  --log-driver=gcplogs --log-opt gcp-project=${GCP_PROJECT_ID} \\`,
    `  --runtime=nvidia --gpus all \\`,
    `  -e GCP_PROJECT_ID=${GCP_PROJECT_ID} \\`,
    `  -e FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID || GCP_PROJECT_ID} \\`,
    `  -e SUBSCRIPTION_NAME=${img.subscription} \\`,
    `  -e OLLAMA_MODEL=${img.model} \\`,
    `  -e OLLAMA_API_KEY=${OLLAMA_API_KEY} \\`,
    `  -e OLLAMA_HOST=http://localhost:11434 \\`,
    `  -e OLLAMA_NUM_PARALLEL=${img.parallel} \\`,
    `  -e OLLAMA_MAX_QUEUE=${img.maxQueue} \\`,
    `  -e MONGO_URI='${esc(MONGO_URI)}' \\`,
    `  -e MONGO_DB=${MONGO_DB} \\`,
    `  -e MONGO_COLLECTION=${MONGO_COLLECTION} \\`,
    `  ${tag}`,
  ].join("\n");
}

// Startup script for the one-time baker VM — CPU-only VM, just pulls the Docker image layers.
// No GPU needed to download; GPU drivers are installed at runtime on each prod VM boot (fast).
function bakerStartupScript(tag, region) {
  return [
    "#!/bin/bash",
    "set -e",
    `ZONE=$(curl -sf "http://metadata.google.internal/computeMetadata/v1/instance/zone" -H "Metadata-Flavor: Google" | awk -F/ '{print $NF}')`,
    `NAME=$(curl -sf "http://metadata.google.internal/computeMetadata/v1/instance/name" -H "Metadata-Flavor: Google")`,
    // Completion is signaled via GUEST ATTRIBUTES (a PUT to the local metadata server) — NOT
    // `gcloud add-metadata`, which failed on the baker ("Could not fetch resource": no core/project
    // set + a compute API round-trip) so bake-done never landed and the deploy timed out every run.
    // A guest-attribute PUT needs no gcloud, no project/zone, no IAM — it can't fail that way.
    // Any error below trips this ERR trap → status=failed, so the deploy aborts immediately instead
    // of polling out the full deadline (and leaving a leaked baker billing).
    `GA="http://metadata.google.internal/computeMetadata/v1/instance/guest-attributes/bake/status"`,
    `trap 'curl -s -X PUT --data failed -H "Metadata-Flavor: Google" "$GA" >/dev/null 2>&1 || true' ERR`,
    // The DLVM image ships NVIDIA drivers + nvidia-container-toolkit but NOT Docker itself
    // (verified: `which docker` fails on a stock baker). Install it and wire the nvidia
    // runtime into Docker's daemon so `docker run --runtime=nvidia` works once this disk is baked.
    // Fresh Ubuntu boots run unattended-upgrades in the background holding the dpkg lock —
    // apt-get install fails immediately (not a wait, a hard error) if it hits that window,
    // and `set -e` kills the whole script right there with no signal ever written. Wait it out.
    `for i in $(seq 1 60); do fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break; sleep 5; done`,
    `DEBIAN_FRONTEND=noninteractive apt-get update -y`,
    `DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io`,
    `nvidia-ctk runtime configure --runtime=docker`,
    `systemctl restart docker`,
    `docker-credential-gcr configure-docker --registries=${region}-docker.pkg.dev || \\`,
    `  gcloud auth configure-docker ${region}-docker.pkg.dev --quiet`,
    `docker pull ${tag}`,
    // Success → guest attribute bake/status=true (the deploy polls get-guest-attributes for this).
    `curl -s -X PUT --data true -H "Metadata-Flavor: Google" "$GA"`,
  ].join("\n");
}

// Keep only the newest N instance-templates per model, deleting the rest. Every deploy
// created a brand-new template and never cleaned up the old one — 8+ had piled up for a
// single model going back over a week. Best-effort per-template: a template still actively
// referenced elsewhere fails to delete without blocking cleanup of the others.
async function cleanupOldTemplates(modelName, keep = 3) {
  let names;
  try {
    names = execSync(
      `gcloud compute instance-templates list --project=${GCP_PROJECT_ID} ` +
        `--filter="name~'^${modelName}-tmpl-'" --sort-by="~creationTimestamp" --format="value(name)"`,
      { stdio: "pipe" }
    ).toString().trim().split("\n").filter(Boolean);
  } catch { return; }
  // run() prints the plan under dry-run and no-ops; a still-referenced/already-gone delete just rejects.
  for (const name of names.slice(keep)) {
    try { await run(`gcloud compute instance-templates delete ${name} --project=${GCP_PROJECT_ID} --quiet`); }
    catch { /* still referenced, or already gone — skip */ }
  }
}

// Check if a GCE custom image with this name already exists — skip rebake if so.
function gceImageExists(name) {
  try {
    execSync(`gcloud compute images describe ${name} --project=${GCP_PROJECT_ID} --format="value(name)"`, { stdio: "pipe" });
    return true;
  } catch { return false; }
}

// Bake a GCE custom image from a Docker image already in Artifact Registry.
// Returns the GCE image name to use in the instance template.
async function bakeGCEImage(img, tag, hash, machineType) {
  const imageName = `${img.name}-img-${hash}`;
  if (gceImageExists(imageName)) {
    console.log(`  ✓ GCE image ${imageName} already exists — skipping bake.`);
    return imageName;
  }

  const bakerName = `${img.name}-baker-${VERSION}`.slice(0, 61).replace(/[^a-z0-9-]/g, "-");
  console.log(`  Baking GCE image for ${img.name} (baker VM: ${bakerName})...`);

  // Baker only needs to docker pull — no GPU needed (DLVM ships NVIDIA drivers pre-installed).
  // e2-standard-4 over e2-medium: the pull is network/CPU-bound (single multi-GB layer + a SHA256
  // verify), and e2-medium's shared-core 2 Gbps cap made that step the slowest part of a bake.
  // e2-standard-4's ~8 Gbps cap + dedicated vCPUs cut it dramatically for ~4x the hourly rate on
  // a run lasting minutes — a wash on cost, a large win on wall-clock. GCE images are global
  // resources, so the baker can run in any region/zone. Try a wide spread to avoid stockouts.
  const BAKER_ZONES = [
    `${GCP_REGION}-b`, `${GCP_REGION}-c`, `${GCP_REGION}-f`, `${GCP_REGION}-a`,
    "us-east1-b", "us-east1-c", "us-east1-d",
    "us-east4-a", "us-east4-b", "us-east4-c",
    "us-west1-a", "us-west1-b", "us-west1-c",
    "us-west2-a", "us-west2-b",
  ];
  const bakerCreateCmd = (zone) =>
    `gcloud compute instances create ${bakerName} --project=${GCP_PROJECT_ID} --zone=${zone} ` +
    `--machine-type=e2-standard-4 --image-family=common-cu129-ubuntu-2204-nvidia-580 --image-project=deeplearning-platform-release ` +
    `--boot-disk-size=${img.diskGb}GB --boot-disk-type=pd-ssd ` +
    `${VM_NET_FLAGS} ` +
    // enable-guest-attributes carries the baker's bake/status signal. Without serial logging a
    // startup-script death is invisible until the bake deadline — serial-port-1 is the only trace.
    vmMetadataFlag(bakerStartupScript(tag, GCP_REGION), ",enable-guest-attributes=TRUE");
  let bakerZone = null;
  for (const zone of BAKER_ZONES) {
    // Dry-run: run() prints the create for the first zone (the APPLY-gated poll/snapshot below no-ops).
    if (!APPLY) { await run(bakerCreateCmd(zone)); bakerZone = zone; break; }
    try {
      console.log(`  Trying baker zone: ${zone}...`);
      // pipe (not run()) so stderr text is captured for the stockout classification that drives retry.
      execSync(bakerCreateCmd(zone), { stdio: "pipe" });
      bakerZone = zone;
      console.log(`  ✓ Baker VM created in ${zone}`);
      break;
    } catch (e) {
      const stderr = (e.stderr || e.stdout || e.message || "").toString();
      process.stderr.write(stderr + "\n");
      if (
        stderr.includes("ZONE_RESOURCE_POOL_EXHAUSTED") ||
        stderr.includes("RESOURCE_NOT_READY") ||
        stderr.includes("stockout")
      ) {
        console.log(`  Zone ${zone} exhausted, trying next...`);
        continue;
      }
      throw new Error(`Baker VM creation failed in ${zone}: ${stderr}`);
    }
  }
  if (!bakerZone) throw new Error(`All zones (${BAKER_ZONES.join(", ")}) exhausted for baker VM — try again later`);

  if (APPLY) {
    // Poll the baker's guest attribute bake/status until done. Deadline scales with image size:
    // a 70B model (diskGb ≥ 200) pull + SHA256 verify routinely exceeds an hour, so a flat short
    // timeout would abort a healthy large bake. Small models finish in minutes.
    const bakeDeadlineMin = img.diskGb >= 200 ? 120 : 30;
    console.log(`  Waiting for baker VM to pull image (up to ${bakeDeadlineMin} min for this ${img.diskGb}GB image)...`);
    const deadline = Date.now() + bakeDeadlineMin * 60 * 1000;
    let bakeDone = false, bakerGone = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30_000));
      try {
        // bake/status: "true" = done, "failed" = startup died. Not-yet-set → this errors → catch.
        const meta = execSync(
          `gcloud compute instances get-guest-attributes ${bakerName} --zone=${bakerZone} --project=${GCP_PROJECT_ID} --query-path=bake/status --format="value(value)"`,
          { stdio: "pipe" }
        ).toString().trim();
        if (meta === "true") { console.log("  ✓ Baker done."); bakeDone = true; break; }
        // The baker's ERR trap sets bake/status=failed the instant its startup script dies — stop
        // waiting NOW rather than polling out the full deadline for a bake that's already dead.
        if (meta === "failed") { console.log("  ✗ Baker signaled startup failure — aborting bake."); break; }
      } catch {
        // get-guest-attributes failed for one of two reasons: the attribute isn't set yet (VM still
        // booting/pulling → keep polling), or the VM NO LONGER EXISTS (its ERR trap self-deleted, or
        // it was killed → the bake is already over and no signal can ever arrive). Distinguish them
        // by a cheap existence check — a missing VM must break immediately, not wait out the deadline
        // (that dead-wait is what hung a whole deploy for an hour).
        try {
          execSync(`gcloud compute instances describe ${bakerName} --zone=${bakerZone} --project=${GCP_PROJECT_ID} --format="value(name)"`, { stdio: "pipe" });
          /* VM still there → attribute just not set yet → keep polling */
        } catch { bakerGone = true; console.log("  ✗ Baker VM is gone — bake already ended; not waiting."); break; }
      }
    }
    // A timed-out/failed/vanished baker must fail loud, not get snapshotted anyway — a silent timeout
    // here previously baked broken (Docker-less) images into every model's GCE image undetected.
    if (!bakeDone) {
      // Best-effort cleanup — a failed bake must not leak a running (billed) VM.
      if (!bakerGone) {
        try { execSync(`gcloud compute instances delete ${bakerName} --zone=${bakerZone} --project=${GCP_PROJECT_ID} --quiet`, { stdio: "pipe" }); }
        catch { /* best-effort — surface the real failure below regardless */ }
      }
      throw new Error(
        bakerGone
          ? `Baker VM ${bakerName} disappeared before signaling bake-done — its startup script died. Check serial logs from a fresh attempt.`
          : `Baker VM ${bakerName} never signaled bake-done within ${bakeDeadlineMin} min — startup script likely stalled. Check serial logs.`
      );
    }

    // Stop baker VM so we can snapshot its disk
    await run(`gcloud compute instances stop ${bakerName} --zone=${bakerZone} --project=${GCP_PROJECT_ID}`);

    // Disk name matches instance name on COS
    const diskName = execSync(
      `gcloud compute instances describe ${bakerName} --zone=${bakerZone} --project=${GCP_PROJECT_ID} --format="value(disks[0].source.basename())"`,
      { stdio: "pipe" }
    ).toString().trim();

    // Create GCE custom image from the baker's disk (images are global — zone doesn't matter)
    await run(
      `gcloud compute images create ${imageName} --project=${GCP_PROJECT_ID} ` +
      `--source-disk=${diskName} --source-disk-zone=${bakerZone} ` +
      `--family=${img.name} --description="Pre-baked Docker image: ${tag}"`
    );

    // Delete baker VM + disk
    await run(`gcloud compute instances delete ${bakerName} --zone=${bakerZone} --project=${GCP_PROJECT_ID} --quiet`);
  }

  return imageName;
}

// The FAKE/canned worker is part of the STANDARD deploy — no separate command. It's a CPU-only
// worker running docker/Dockerfile.fake: no GPU, no model, no baker/bake. It drains
// FAKE_SUBSCRIPTION and returns canned output through the same Pub/Sub → Firestore path as a real
// worker. Like the GPU tiers it runs behind a MIG + autoscaler on its own subscription backlog
// (min 0 → scale-to-zero), so an idle fake worker shuts itself off within the ~60s cooldown
// instead of billing 24/7. Disabling the GPU workers (edit MODELS / the IMAGES filter) does not
// affect this.
async function deployFake() {
  const name = "worker-fake-canned-v1";
  const dockerfile = fs.readFileSync("docker/Dockerfile.fake", "utf-8");
  const hash = contentHash(dockerfile);                     // rebuilds when Dockerfile.fake/worker/config change
  const tagHash = `${REGISTRY}/${name}:${hash}`;
  const tagLatest = `${REGISTRY}/${name}:latest`;
  const template = `${name}-tmpl-${hash}`;
  const mig = `${name}-mig`;

  console.log(`\n==== ${name} (CPU MIG, scale-to-zero) hash=${hash} ====`);

  await ensureImage({
    name, hash, async: false,
    cbYaml:
      `steps:\n- name: 'gcr.io/cloud-builders/docker'\n` +
      `  args: ['build', '-f', 'docker/Dockerfile.fake', '-t', '${tagHash}', '.']\n` +
      `  timeout: 600s\nimages:\n- '${tagHash}'\ntimeout: 600s\n`,
  }).build;
  await run(`gcloud artifacts docker tags add ${tagHash} ${tagLatest} --project=${GCP_PROJECT_ID}`);

  // Container-Optimized OS ships Docker, so boot = pull + run. --restart=always keeps the worker
  // up across container crashes; Mongo URI is single-quoted (esc) so its commas survive the shell.
  const startup = [
    "#!/bin/bash",
    "set -e",
    // COS mounts / (and /root) read-only, so the gcr credential helper can't write its default
    // $HOME/.docker/config.json → the pull runs unauthenticated and Artifact Registry denies it.
    // Point HOME at writable tmpfs so configure-docker + pull share a writable docker config.
    "export HOME=/tmp",
    `docker-credential-gcr configure-docker --registries=${GCP_REGION}-docker.pkg.dev || true`,
    `docker pull ${tagHash}`,
    `docker run -d --name worker --restart=always \\`,
    `  --log-driver=gcplogs --log-opt gcp-project=${GCP_PROJECT_ID} \\`,
    `  -e GCP_PROJECT_ID=${GCP_PROJECT_ID} \\`,
    `  -e FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID || GCP_PROJECT_ID} \\`,
    `  -e SUBSCRIPTION_NAME=${FAKE_SUBSCRIPTION} \\`,
    `  -e MONGO_URI='${esc(MONGO_URI)}' \\`,
    `  -e MONGO_DB=${MONGO_DB} \\`,
    `  -e MONGO_COLLECTION=${MONGO_COLLECTION} \\`,
    `  ${tagHash}`,
  ].join("\n");

  // Retire the legacy always-up standalone VM if a pre-MIG deploy left one behind — the MIG below
  // replaces it. (Read-only describe is safe in dry-run; the delete goes through APPLY-gated run.)
  let legacyVm = "";
  try {
    legacyVm = execSync(`gcloud compute instances describe ${name} --zone=${GCP_ZONE} --project=${GCP_PROJECT_ID} --format="value(name)"`, { stdio: "pipe" }).toString().trim();
  } catch { /* no legacy VM */ }
  if (legacyVm) await run(`gcloud compute instances delete ${name} --zone=${GCP_ZONE} --project=${GCP_PROJECT_ID} --quiet`);

  // CPU instance template — cos-stable, no GPU; boot pulls + runs the fake image. The template name
  // is content-hash keyed (stable), so an unchanged redeploy would hit ALREADY_EXISTS on create —
  // ensureTemplate skips it when it's already there (same hash = identical template).
  await ensureTemplate({
    template,
    createCmd:
      // --verbosity=error: the 20GB boot disk is intentional (tiny canned image, e2-micro) —
      // silence gcloud's <200GB I/O-performance WARNING on every new template.
      `gcloud compute instance-templates create ${template} --project=${GCP_PROJECT_ID} --verbosity=error ` +
      `--machine-type=e2-micro --image-family=cos-stable --image-project=cos-cloud ` +
      `--boot-disk-size=20GB ${VM_NET_FLAGS} ` +
      vmMetadataFlag(startup),
  });

  // MIG + autoscaler on the fake subscription backlog (0 → maxReplicas). Same mechanism as the GPU
  // tiers — including the same replica ceiling — so fake test runs can exercise multi-instance
  // scaling (a fanned-out step lands N messages → N fake workers), not just a single serial box. So
  // an idle fake worker scales to zero within the 60s cooldown instead of billing around the clock.
  // Regional MIG spans 3 zones — fixed max-surge must be 0 or ≥ zone count, so surge=3 (one per zone).
  await ensureMigOnTemplate({
    mig, region: GCP_REGION, template, surge: 3,
    createCmd:
      `gcloud compute instance-groups managed create ${mig} --project=${GCP_PROJECT_ID} ` +
      `--region=${GCP_REGION} --template=${template} --size=0 ` +
      `--zones=${GCP_REGION}-a,${GCP_REGION}-b,${GCP_REGION}-c`,
    skipMsg: `  ✓ ${mig} in ${GCP_REGION} already on ${template} — no roll.`,
  });
  await setMigAutoscaling({ mig, region: GCP_REGION, subscription: FAKE_SUBSCRIPTION, maxReplicas: DEFAULTS.maxReplicas });
  console.log(`  ✓ Fake worker → MIG ${mig} (e2-micro, 0→${DEFAULTS.maxReplicas}) draining ${FAKE_SUBSCRIPTION}`);
}

async function deploy() {
  console.log(`\nDeploy — GCE MIG (DLVM + Docker)  ${APPLY ? "(APPLY)" : "(DRY-RUN)"}`);
  console.log(`Version : ${VERSION}   Project: ${GCP_PROJECT_ID}   Zone: ${GCP_ZONE}`);
  console.log(`Registry: ${REGISTRY}\n`);

  // Resolve the live worker-MIG topology from the DB/GCP (falls back to the seed off-GCE). Single
  // source shared with rollback.js — the hardcoded list is only a bootstrap seed now.
  const WORKER_REGIONS = await getWorkerRegions();
  console.log(`Worker regions: ${WORKER_REGIONS.map(([r]) => r).join(", ")} — all size 0, steered by the capacity loop\n`);

  // 1. Pub/Sub topics + subscriptions
  if (APPLY) await setupPubSub(GCP_PROJECT_ID);
  else console.log("[dry-run] setupPubSub(...)");

  // 2. Artifact Registry + docker auth (check first — avoid noisy ALREADY_EXISTS error)
  let repoExists = false;
  try {
    execSync(
      `gcloud artifacts repositories describe ollama --location=${GCP_REGION} --project=${GCP_PROJECT_ID} --format="value(name)"`,
      { stdio: "pipe" }
    );
    repoExists = true;
  } catch { /* doesn't exist yet */ }
  if (!repoExists) {
    await run(
      `gcloud artifacts repositories create ollama --repository-format=docker ` +
        `--location=${GCP_REGION} --project=${GCP_PROJECT_ID}`
    );
  }
  await run(`gcloud auth configure-docker ${GCP_REGION}-docker.pkg.dev --quiet`);

  // Fake/canned worker — part of the standard deploy (CPU, no GPU/baker). Deploys first so a later
  // model failure doesn't block it, and so it's up even when the GPU workers are disabled.
  await deployFake();

  // 2a. Shared base image (Ollama + Node + git/curl) — built once, reused by all 7 per-model
  // builds below instead of each re-running apt-get/node-install from scratch.
  const baseImage = await ensureBaseImage();

  // Dry-run only: validate all model names exist in Ollama's registry before building.
  if (!APPLY) {
    console.log("Validating model names against Ollama registry...");
    const invalid = IMAGES.filter((m) => !validateOllamaModel(m.model));
    if (invalid.length) {
      throw new Error(`Unknown Ollama model(s): ${invalid.map((m) => m.model).join(", ")}`);
    }
    console.log(`  ✓ All ${IMAGES.length} models confirmed in Ollama registry.\n`);
  }

  // Pre-compute per-image metadata.
  const plan = IMAGES.map((base) => {
    const img = { ...DEFAULTS, ...base };
    const dockerfile = renderDockerfile({ ...img, baseImage });
    const hash = contentHash(dockerfile);
    return {
      img,
      dockerfile,
      hash,
      tagHash:     `${REGISTRY}/${img.name}:${hash}`,
      tagLatest:   `${REGISTRY}/${img.name}:latest`,
      machineType: MACHINE_BY_GPU[img.gpu] || MACHINE_BY_GPU[1],
      template:    `${img.name}-tmpl-${hash}`.slice(0, 61),
      mig:         `${img.name}-mig`,
    };
  });

  // ── Phase 1: All images — fire every Cloud Build job in parallel, await each in turn ──
  // Progress region + per-image capture logs (APPLY only; a no-op under dry-run so the plan prints).
  const progress = createProgress(plan.map((p) => p.img.name), { enabled: APPLY });
  progress.start();

  const cloudBuildJobs = [];
  for (const p of plan) {
    const { img, dockerfile, hash, tagHash, tagLatest, machineType } = p;
    const dfName = `Dockerfile.${img.name}.build`;
    // Large models (70B ≈ 44 GB) need a bigger builder disk AND a longer timeout: the ollama.com
    // model download + image push doesn't finish inside the 100 GB / 1 h default (it timed out
    // mid-push). 300 GB / 2 h covers it. No CPU bump — the external download is the cost, and a
    // bigger builder doesn't speed it. Small models keep the defaults.
    const isLarge = img.diskGb >= 200;
    const buildOpts = isLarge ? `options:\n  diskSizeGb: 300\n` : "";
    const buildTimeout = isLarge ? 7200 : 3600;
    const cbYaml =
      `steps:\n- name: 'gcr.io/cloud-builders/docker'\n` +
      `  args: ['build', '-f', '${dfName}', '-t', '${tagHash}', '.']\n` +
      `  timeout: ${buildTimeout}s\n${buildOpts}images:\n- '${tagHash}'\ntimeout: ${buildTimeout}s\n`;
    als.run({ name: img.name, logFd: progress.logFd(img.name) }, () => {
      console.log(`\n==== ${img.name} (gpu=${img.gpu}, ${machineType}) hash=${hash} — queuing Cloud Build ====`);
      progress.phase(img.name, "building");
      const { build } = ensureImage({ name: img.name, hash, dfName, dockerfile, cbYaml, async: true });
      cloudBuildJobs.push({ p, promise: build });
      // Dry-run parity: the plan previews the tag-add here as well as after the (no-op) build below.
      if (!APPLY) run(`gcloud artifacts docker tags add ${tagHash} ${tagLatest} --project=${GCP_PROJECT_ID}`);
    });
  }

  // Pipeline: as each build finishes, immediately tag + bake + deploy that image.
  // Don't wait for all builds — start processing each one as soon as it's ready.
  // allSettled, not all: one model's failure (e.g. a baker VM error) must not abort the
  // Node process mid-flight for the OTHER 6 — that's exactly what orphaned baker VMs
  // stuck running for hours after an earlier IOPS error killed the process outright.
  const results = await Promise.allSettled(cloudBuildJobs.map(({ p, promise }) => {
    const { img, hash, tagHash, tagLatest, machineType, template, mig } = p;
    // Run each image's pipeline inside its own capture context so its verbose gcloud output lands
    // in that image's log file (terminal shows only the status region). On failure the log is dumped.
    return als.run({ name: img.name, logFd: progress.logFd(img.name) }, async () => {
     try {
      console.log(`\nAwaiting Cloud Build: ${img.name}...`);
      await timedPhase(img.name, "cloudbuild", () => promise);
      await run(`gcloud artifacts docker tags add ${tagHash} ${tagLatest} --project=${GCP_PROJECT_ID}`);
      console.log(`  ✓ ${img.name} done.`);

      // Cleanup: remove old digest tags (keep current hash + latest only).
      await run(
        `gcloud artifacts docker images list ${REGISTRY}/${img.name} ` +
          `--include-tags --format="value(version,tags)" --project=${GCP_PROJECT_ID} | ` +
          `grep -v "${hash}" | grep -v "latest" | awk '{print $1}' | ` +
          `xargs -I{} gcloud artifacts docker images delete ` +
          `${REGISTRY}/${img.name}@{} --project=${GCP_PROJECT_ID} --quiet 2>/dev/null || true`
      );

      // Bake GCE custom image — Docker layers pre-loaded, no boot-time pull.
      progress.phase(img.name, "baking");
      const gceImage = await timedPhase(img.name, "bake", () => bakeGCEImage(img, tagHash, hash, machineType));

      // Instance template — GPU VM on the baked custom image. Boot disk is Hyperdisk Balanced with
      // provisioned throughput: model load into VRAM is disk-throughput-bound (a 60GB pd-ssd caps at
      // ~30MB/s → minutes; 400MB/s loads a 5GB model in ~13s at ~$0.02/hr). Hash-keyed name → skip
      // create when unchanged (byte-identical template) so an unchanged redeploy doesn't roll the VMs.
      progress.phase(img.name, "deploying");
      await ensureTemplate({
        template, hashNote: ` (${hash})`,
        createCmd:
          `gcloud compute instance-templates create ${template} --project=${GCP_PROJECT_ID} ` +
          `--machine-type=${machineType} ` +
          `--image=${gceImage} --image-project=${GCP_PROJECT_ID} ` +
          `--boot-disk-size=${img.diskGb}GB --boot-disk-type=hyperdisk-balanced ` +
          `--boot-disk-provisioned-iops=10000 --boot-disk-provisioned-throughput=400 ` +
          `--accelerator=type=nvidia-l4,count=${img.gpu} --maintenance-policy=TERMINATE ` +
          `${VM_NET_FLAGS} ` +
          vmMetadataFlag(vmStartupScript(img, tagHash)),
      });

      // Clean up legacy Zonal MIG if it exists to avoid conflicts.
      // Errors are expected if it's already deleted or never existed.
      if (APPLY) {
        try {
          execSync(
            `gcloud compute instance-groups managed delete ${mig} ` +
              `--project=${GCP_PROJECT_ID} --zone=${GCP_ZONE} --quiet 2>/dev/null`,
            { stdio: "ignore" }
          );
          console.log(`\nDeleted legacy Zonal MIG ${mig}`);
        } catch { /* already deleted or never existed */ }
      }

      await cleanupOldTemplates(img.name);

      // MIG + autoscaler on Pub/Sub backlog (scale 0 → maxReplicas), one per L4 region so a
      // region-wide stockout in any single region can't stall the whole model. All regions'
      // autoscalers watch the SAME subscription (see WORKER_REGIONS note re: burst over-provisioning).
      for (const [region, zones] of WORKER_REGIONS) {
        // Fixed max-surge must be 0 or ≥ the region's zone count (percent surge is rejected on
        // scale-to-zero MIGs), so surge = zones.length: one fresh instance per zone.
        const surge = zones.length;
        const zoneList = zones.map((z) => `${region}-${z}`).join(",");

        await ensureMigOnTemplate({
          mig, region, template, surge,
          // Explicit L4 zones so a fixed max-surge stays legal (surge must be 0 or ≥ zone count),
          // with target-distribution-shape=ANY so the MIG places wherever L4 capacity exists among
          // those zones instead of forcing an even spread — dodges single-zone stockouts.
          createCmd:
            `gcloud compute instance-groups managed create ${mig} --project=${GCP_PROJECT_ID} ` +
            `--region=${region} --template=${template} --size=0 ` +
            `--zones=${zoneList} --target-distribution-shape=ANY`,
          skipMsg: `  ✓ ${mig} in ${region} already on ${template} — no roll.`,
        });

        // NO autoscaler in ANY region — the capacity control loop owns MIG sizing directly
        // (functions/entry/ai/capacity/actuate.js: avail IS the MIG target size, start/shrink/release
        // set it). GCE rejects resize with 412 on an autoscaled MIG, so an autoscaler here doesn't
        // just duplicate the loop, it BLOCKS it: shrink can never drain the region, and every
        // self-deleted worker gets recreated to meet the autoscaler's target.
        // run() prints the plan under dry-run and no-ops; a missing autoscaler just rejects → ignore.
        try {
          await run(`gcloud compute instance-groups managed stop-autoscaling ${mig} --project=${GCP_PROJECT_ID} --region=${region}`);
        } catch { /* no autoscaler to stop — fine */ }
        console.log(`  ✓ ${img.name} MIG ${mig} in ${region} (size 0, no autoscaler — capacity loop steers)`);
      }

      console.log(`\nPrepared: ${img.name} → ${tagHash} across ${WORKER_REGIONS.length} region(s) (${img.gpu}× L4, 0→${img.maxReplicas})`);
      progress.done(img.name);
      return img.name;
     } catch (err) {
      progress.fail(img.name);   // dumps this image's captured log so the error is visible
      throw err;
     }
    });
  }));

  progress.stop();

  const failed = results
    .map((r, i) => ({ r, name: plan[i].img.name }))
    .filter(({ r }) => r.status === "rejected");

  console.log(`\n${results.length - failed.length}/${results.length} models prepared successfully.`);
  if (failed.length) {
    for (const { r, name } of failed) console.error(`  ✗ ${name}: ${r.reason?.message || r.reason}`);
  }

  console.log(`\n${APPLY ? "Deploy complete" : "Dry-run complete (pass --dry-run=0 to execute)"} @ ${VERSION}\n`);

  // Refresh the stale-artifacts gauge (custom.googleapis.com/registry/stale_artifacts) — a deploy is
  // exactly when image/template junk changes. Best-effort: never fail the deploy over the gauge.
  if (APPLY) { try { execSync("node scripts/audit-images.mjs --prune", { stdio: "inherit" }); } catch {} }

  if (failed.length) throw new Error(`${failed.length}/${results.length} model(s) failed to deploy — see above.`);
}

// Run only when invoked directly (`node scripts/deploy.js`, as npm run deploy:workers does) — NOT
// when imported (e.g. a test importing createProgress), which would otherwise trigger a real deploy.
const invokedDirectly =
  process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

// Force exit on success too: setupPubSub / the Mongo read leave open gRPC + socket handles, so Node's
// event loop never drains and the process hangs after "Deploy complete" (all real work is already
// done by the time deploy() resolves). Without this, every deploy leaks a stuck process.
if (invokedDirectly) {
  deploy()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Deploy failed:", err.message);
      process.exit(1);
    });
}
