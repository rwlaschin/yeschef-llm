// ============================================================
// Deploy — GCE spot MIG with baked custom GCE images (no boot-time Docker pull).
//
//   1. build the Docker image (Ollama + worker + baked model) → Artifact Registry
//   2. bake a GCE custom image: launch a baker VM, docker pull, stop VM, snapshot
//   3. instance template: SPOT, GPU L4(s), custom image; startup just runs the container
//   4. managed instance group + autoscaler on Pub/Sub backlog (min 0 → max N)
//
// One VM per replica. GPU count comes from the model's "machine description":
//   gpu:1 → 1× L4 (g2-standard-8),  gpu:2 → 2× L4 (g2-standard-24, one box).
//
// Spot + scale-to-zero + no cluster fee. Preemption is safe: the worker acks only
// after the final Firestore write, so a preempted job is redelivered and another
// spot VM finishes it (jobId idempotency guards partial writes).
//
// Applies for real by default. Pass --dry-run to only PRINT the gcloud/docker
// commands without executing them (preview the plan).
// ============================================================

import dotenvFlow from "dotenv-flow";
import { execSync, exec } from "child_process";
import fs from "fs";
import crypto from "crypto";
import { renderDockerfile } from "../docker/render.js";
import { setup as setupPubSub } from "../pubsub/setup.js";
import { MODELS, subscriptionOf, imageOf, FAKE_SUBSCRIPTION } from "../config/models.js";

dotenvFlow.config();

const _log = console.log.bind(console);
console.log = (...args) => _log(`[${new Date().toLocaleTimeString()}]`, ...args);

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
const USE_SPOT = args.some((a) => a === "--spot");
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
      run(`gcloud builds submit . --project=${GCP_PROJECT_ID} --region=${GCP_REGION} --config=${cbName}`);
    } finally {
      try { fs.unlinkSync(cbName); } catch {}
    }
  }
  run(`gcloud artifacts docker tags add ${tag} ${tagLatest} --project=${GCP_PROJECT_ID}`);
  return tag;
}

// gpu count → g2 machine type (L4s on a single box)
const MACHINE_BY_GPU = { 1: "g2-standard-8", 2: "g2-standard-24" };

const DEFAULTS = { parallel: 2, maxQueue: 5, gpu: 1, maxReplicas: 7 };

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
  // ENV-sourced (dotenv-flow: .env.production → .env), DEFAULTS fallback. Feeds BOTH the baked
  // Dockerfile ENV (renderDockerfile) and the runtime `docker run -e` in the VM startup script.
  parallel: process.env.OLLAMA_NUM_PARALLEL || DEFAULTS.parallel,
  maxQueue: process.env.OLLAMA_MAX_QUEUE || DEFAULTS.maxQueue,
}));
// Deploy every GPU model except OpenClaw (Llama 3.3 70B) — held back for now. deployFake (the
// fake/canned worker) runs independently of this filter.
const IMAGES = IMAGES_ALL.filter((img) => img.name !== "ollama-openclaw-llama3-3-70b-v1");

function run(cmd) {
  if (!APPLY) {
    console.log(`\n[dry-run] ${cmd}\n`);
    return;
  }
  console.log(`\n> ${cmd}\n`);
  execSync(cmd, { stdio: "inherit" });
}

// Async variant for parallel Cloud Build submissions — streams stdout/stderr live.
function runAsync(cmd) {
  if (!APPLY) { console.log(`\n[dry-run] ${cmd}\n`); return Promise.resolve(); }
  console.log(`\n> ${cmd}\n`);
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { maxBuffer: 50 * 1024 * 1024 });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Exit ${code}: ${cmd.slice(0, 100)}`))
    );
  });
}


function esc(s) {
  return s.replace(/'/g, "'\\''");
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
function cleanupOldTemplates(modelName, keep = 3) {
  let names;
  try {
    names = execSync(
      `gcloud compute instance-templates list --project=${GCP_PROJECT_ID} ` +
        `--filter="name~'^${modelName}-tmpl-'" --sort-by="~creationTimestamp" --format="value(name)"`,
      { stdio: "pipe" }
    ).toString().trim().split("\n").filter(Boolean);
  } catch { return; }
  for (const name of names.slice(keep)) {
    try { execSync(`gcloud compute instance-templates delete ${name} --project=${GCP_PROJECT_ID} --quiet`, { stdio: "pipe" }); }
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
  let bakerZone = null;
  for (const zone of BAKER_ZONES) {
    try {
      console.log(`  Trying baker zone: ${zone}...`);
      execSync(
        `gcloud compute instances create ${bakerName} --project=${GCP_PROJECT_ID} --zone=${zone} ` +
        `--machine-type=e2-standard-4 --image-family=common-cu129-ubuntu-2204-nvidia-580 --image-project=deeplearning-platform-release ` +
        `--boot-disk-size=${img.diskGb}GB --boot-disk-type=pd-ssd ` +
        `--network=${GCP_NETWORK} --scopes=cloud-platform --service-account=${GCP_SERVICE_ACCOUNT} ` +
        // Without this, a startup-script death is invisible until the 20-min timeout —
        // serial-port-1 output is the only trace of a baker VM that never signals bake-done.
        `--metadata=startup-script='${esc(bakerStartupScript(tag, GCP_REGION))}',serial-port-logging-enable=true,enable-guest-attributes=TRUE`,
        { stdio: "pipe" }  // pipe so we can catch error text; errors print below
      );
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
    // Poll instance metadata until the baker signals it's done (up to 20 min)
    console.log(`  Waiting for baker VM to pull image (this takes a few minutes)...`);
    const deadline = Date.now() + 60 * 60 * 1000;
    let bakeDone = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30_000));
      try {
        // Read the baker's guest attribute bake/status ("true" = done, "failed" = startup died).
        // Not-yet-set → get-guest-attributes errors → caught below → keep polling.
        const meta = execSync(
          `gcloud compute instances get-guest-attributes ${bakerName} --zone=${bakerZone} --project=${GCP_PROJECT_ID} --query-path=bake/status --format="value(value)"`,
          { stdio: "pipe" }
        ).toString().trim();
        if (meta === "true") { console.log("  ✓ Baker done."); bakeDone = true; break; }
        // The baker's ERR trap sets bake/status=failed the instant its startup script dies — stop
        // waiting NOW rather than polling out the full deadline for a bake that's already dead.
        if (meta === "failed") { console.log("  ✗ Baker signaled startup failure — aborting bake."); break; }
      } catch { /* attribute not set yet — still booting/pulling */ }
    }
    // A timed-out baker must fail loud, not get snapshotted anyway — a silent timeout here
    // previously baked broken (Docker-less) images into every model's GCE image undetected.
    if (!bakeDone) {
      // Best-effort cleanup — a failed bake must not leak a running (billed) VM the way a
      // process-wide crash used to when this threw before reaching the stop/delete below.
      try { execSync(`gcloud compute instances delete ${bakerName} --zone=${bakerZone} --project=${GCP_PROJECT_ID} --quiet`, { stdio: "pipe" }); }
      catch { /* best-effort — surface the real failure below regardless */ }
      throw new Error(
        `Baker VM ${bakerName} never signaled bake-done within 60 min — its startup script likely failed (VM deleted). ` +
        `Check serial logs from a fresh bake attempt if this recurs.`
      );
    }

    // Stop baker VM so we can snapshot its disk
    run(`gcloud compute instances stop ${bakerName} --zone=${bakerZone} --project=${GCP_PROJECT_ID}`);

    // Disk name matches instance name on COS
    const diskName = execSync(
      `gcloud compute instances describe ${bakerName} --zone=${bakerZone} --project=${GCP_PROJECT_ID} --format="value(disks[0].source.basename())"`,
      { stdio: "pipe" }
    ).toString().trim();

    // Create GCE custom image from the baker's disk (images are global — zone doesn't matter)
    run(
      `gcloud compute images create ${imageName} --project=${GCP_PROJECT_ID} ` +
      `--source-disk=${diskName} --source-disk-zone=${bakerZone} ` +
      `--family=${img.name} --description="Pre-baked Docker image: ${tag}"`
    );

    // Delete baker VM + disk
    run(`gcloud compute instances delete ${bakerName} --zone=${bakerZone} --project=${GCP_PROJECT_ID} --quiet`);
  }

  return imageName;
}

// The FAKE/canned worker is part of the STANDARD deploy — no separate command. It's a CPU-only
// always-up VM running docker/Dockerfile.fake: no GPU, no model, no baker/bake. It drains
// FAKE_SUBSCRIPTION and returns canned output through the same Pub/Sub → Firestore path as a real
// worker. Disabling the GPU workers (edit MODELS / the IMAGES filter) does not affect this.
async function deployFake() {
  const name = "worker-fake-canned-v1";
  const dockerfile = fs.readFileSync("docker/Dockerfile.fake", "utf-8");
  const hash = contentHash(dockerfile);                     // rebuilds when Dockerfile.fake/worker/config change
  const tagHash = `${REGISTRY}/${name}:${hash}`;
  const tagLatest = `${REGISTRY}/${name}:latest`;
  const vm = name;

  console.log(`\n==== ${name} (CPU, always-up) hash=${hash} ====`);

  if (APPLY && imageExistsInRegistry(tagHash)) {
    console.log(`  ✓ Image unchanged (${hash}) — skipping build.`);
  } else {
    const cbName = `cloudbuild.${name}.yaml`;
    fs.writeFileSync(
      cbName,
      `steps:\n- name: 'gcr.io/cloud-builders/docker'\n` +
        `  args: ['build', '-f', 'docker/Dockerfile.fake', '-t', '${tagHash}', '.']\n` +
        `  timeout: 600s\nimages:\n- '${tagHash}'\ntimeout: 600s\n`
    );
    try {
      run(`gcloud builds submit . --project=${GCP_PROJECT_ID} --region=${GCP_REGION} --config=${cbName}`);
    } finally {
      try { fs.unlinkSync(cbName); } catch {}
    }
  }
  run(`gcloud artifacts docker tags add ${tagHash} ${tagLatest} --project=${GCP_PROJECT_ID}`);

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

  // Recreate so the VM always runs the newest image — BUT if the image is unchanged and the VM is
  // already RUNNING, leave it alone (a GPU-only redeploy must not bounce a healthy fake worker).
  if (APPLY) {
    let status = null;
    try {
      status = execSync(`gcloud compute instances describe ${vm} --zone=${GCP_ZONE} --project=${GCP_PROJECT_ID} --format="value(status)"`, { stdio: "pipe" }).toString().trim();
    } catch { /* not present yet */ }
    if (status === "RUNNING" && imageExistsInRegistry(tagHash)) {
      console.log(`  ✓ Fake worker already running on current image — leaving it untouched.`);
      return;
    }
    if (status) run(`gcloud compute instances delete ${vm} --zone=${GCP_ZONE} --project=${GCP_PROJECT_ID} --quiet`);
  }
  run(
    `gcloud compute instances create ${vm} --project=${GCP_PROJECT_ID} --zone=${GCP_ZONE} ` +
      `--machine-type=e2-small --image-family=cos-stable --image-project=cos-cloud ` +
      `--boot-disk-size=20GB --network=${GCP_NETWORK} ` +
      `--scopes=cloud-platform --service-account=${GCP_SERVICE_ACCOUNT} ` +
      `--metadata=startup-script='${esc(startup)}',serial-port-logging-enable=true`
  );
  console.log(`  ✓ Fake worker → VM ${vm} draining ${FAKE_SUBSCRIPTION}`);
}

async function deploy() {
  console.log(`\nDeploy — GCE ${USE_SPOT ? "SPOT" : "on-demand"} MIG (DLVM + Docker)  ${APPLY ? "(APPLY)" : "(DRY-RUN)"}`);
  console.log(`Version : ${VERSION}   Project: ${GCP_PROJECT_ID}   Zone: ${GCP_ZONE}`);
  console.log(`Registry: ${REGISTRY}\n`);

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
    run(
      `gcloud artifacts repositories create ollama --repository-format=docker ` +
        `--location=${GCP_REGION} --project=${GCP_PROJECT_ID}`
    );
  }
  run(`gcloud auth configure-docker ${GCP_REGION}-docker.pkg.dev --quiet`);

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
      template:    `${img.name}-tmpl-${VERSION}`.slice(0, 61),
      mig:         `${img.name}-mig`,
    };
  });

  // ── Phase 1: All images — fire every Cloud Build job in parallel, await each in turn ──
  const cloudBuildJobs = [];
  for (const p of plan) {
    const { img, dockerfile, hash, tagHash, tagLatest } = p;
    console.log(`\n==== ${img.name} (gpu=${img.gpu}, ${p.machineType}) hash=${hash} — queuing Cloud Build ====`);
    if (!APPLY) {
      run(`gcloud builds submit . --project=${GCP_PROJECT_ID} --region=${GCP_REGION} --config=cloudbuild.${img.name}.yaml`);
      run(`gcloud artifacts docker tags add ${tagHash} ${tagLatest} --project=${GCP_PROJECT_ID}`);
      cloudBuildJobs.push({ p, promise: Promise.resolve() });
    } else if (!imageExistsInRegistry(tagHash)) {
      const dfName = `Dockerfile.${img.name}.build`;
      const cbName = `cloudbuild.${img.name}.yaml`;
      fs.writeFileSync(dfName, dockerfile);
      // A 44 GB model (70B) needs a bigger Cloud Build disk than the 100 GB default to hold the
      // built image; small models use the default. No CPU/machine bump — the ollama.com model
      // download is the cost, and a bigger builder doesn't speed an external download.
      const buildOpts = img.diskGb >= 200 ? `options:\n  diskSizeGb: 300\n` : "";
      fs.writeFileSync(
        cbName,
        `steps:\n- name: 'gcr.io/cloud-builders/docker'\n` +
          `  args: ['build', '-f', '${dfName}', '-t', '${tagHash}', '.']\n` +
          `  timeout: 3600s\n${buildOpts}images:\n- '${tagHash}'\ntimeout: 3600s\n`
      );
      const promise = runAsync(
        `gcloud builds submit . --project=${GCP_PROJECT_ID} --region=${GCP_REGION} --config=${cbName}`
      ).finally(() => {
        try { fs.unlinkSync(dfName); } catch {}
        try { fs.unlinkSync(cbName); } catch {}
      });
      cloudBuildJobs.push({ p, promise });
    } else {
      console.log(`  ✓ Image unchanged (${hash}) — skipping build.`);
      cloudBuildJobs.push({ p, promise: Promise.resolve() });
    }
  }

  // Pipeline: as each build finishes, immediately tag + bake + deploy that image.
  // Don't wait for all builds — start processing each one as soon as it's ready.
  // allSettled, not all: one model's failure (e.g. a baker VM error) must not abort the
  // Node process mid-flight for the OTHER 6 — that's exactly what orphaned baker VMs
  // stuck running for hours after an earlier IOPS error killed the process outright.
  const results = await Promise.allSettled(cloudBuildJobs.map(async ({ p, promise }) => {
    const { img, hash, tagHash, tagLatest, machineType, template, mig } = p;
    console.log(`\nAwaiting Cloud Build: ${img.name}...`);
    await timedPhase(img.name, "cloudbuild", () => promise);
    run(`gcloud artifacts docker tags add ${tagHash} ${tagLatest} --project=${GCP_PROJECT_ID}`);
    console.log(`  ✓ ${img.name} done.`);

    // Cleanup: remove old digest tags (keep current hash + latest only).
    run(
      `gcloud artifacts docker images list ${REGISTRY}/${img.name} ` +
        `--include-tags --format="value(version,tags)" --project=${GCP_PROJECT_ID} | ` +
        `grep -v "${hash}" | grep -v "latest" | awk '{print $1}' | ` +
        `xargs -I{} gcloud artifacts docker images delete ` +
        `${REGISTRY}/${img.name}@{} --project=${GCP_PROJECT_ID} --quiet 2>/dev/null || true`
    );

    // Bake GCE custom image — Docker layers pre-loaded, no boot-time pull.
    const gceImage = await timedPhase(img.name, "bake", () => bakeGCEImage(img, tagHash, hash, machineType));

    // Instance template — GPU VM on baked custom image.
    // Boot disk is Hyperdisk Balanced with provisioned throughput: model load into VRAM is
    // disk-throughput-bound, and pd-ssd/pd-standard throughput scales with size (a 60GB
    // pd-ssd caps at ~30MB/s → minutes to load). 400MB/s loads a 5GB model in ~13s and
    // costs ~$0.02/hr of VM runtime.
    run(
      `gcloud compute instance-templates create ${template} --project=${GCP_PROJECT_ID} ` +
        `--machine-type=${machineType} ` +
        `--image=${gceImage} --image-project=${GCP_PROJECT_ID} ` +
        `--boot-disk-size=${img.diskGb}GB --boot-disk-type=hyperdisk-balanced ` +
        `--boot-disk-provisioned-iops=10000 --boot-disk-provisioned-throughput=400 ` +
        `--accelerator=type=nvidia-l4,count=${img.gpu} --maintenance-policy=TERMINATE ` +
        (USE_SPOT ? `--provisioning-model=SPOT --instance-termination-action=STOP ` : "") +
        `--network=${GCP_NETWORK} --scopes=cloud-platform --service-account=${GCP_SERVICE_ACCOUNT} ` +
        `--metadata=startup-script='${esc(vmStartupScript(img, tagHash))}',serial-port-logging-enable=true`
    );

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
      } catch {}
    }

    // MIG + autoscaler on Pub/Sub backlog (scale 0 → maxReplicas).
    let migExists = false;
    try {
      execSync(
        `gcloud compute instance-groups managed describe ${mig} ` +
          `--project=${GCP_PROJECT_ID} --region=${GCP_REGION} --format="value(name)"`,
        { stdio: "pipe" }
      );
      migExists = true;
    } catch { /* doesn't exist yet */ }

    if (migExists) {
      // set-instance-template only changes the recipe for instances created AFTER this call —
      // it does NOT touch already-running ones. A broken instance from a bad deploy would sit
      // there serving (or failing to serve) traffic indefinitely, undetected, through every
      // later "successful" deploy. rolling-action actually replaces existing instances: brings
      // up a new one on the new template BEFORE removing an old one (max-unavailable=0), so a
      // broken new template surfaces as a stuck rollout instead of silently orphaning nothing.
      run(
        `gcloud compute instance-groups managed set-instance-template ${mig} ` +
          `--project=${GCP_PROJECT_ID} --region=${GCP_REGION} --template=${template}`
      );
      run(
        `gcloud compute instance-groups managed rolling-action start-update ${mig} ` +
          `--project=${GCP_PROJECT_ID} --region=${GCP_REGION} --version=template=${template} ` +
          `--max-surge=1 --max-unavailable=0`
      );
    } else {
      run(
        `gcloud compute instance-groups managed create ${mig} --project=${GCP_PROJECT_ID} ` +
          `--region=${GCP_REGION} --template=${template} --size=0 ` +
          `--zones=${GCP_REGION}-a,${GCP_REGION}-b,${GCP_REGION}-c`
      );
    }
    cleanupOldTemplates(img.name);
    run(
      `gcloud compute instance-groups managed set-autoscaling ${mig} --project=${GCP_PROJECT_ID} ` +
        `--region=${GCP_REGION} --min-num-replicas=0 --max-num-replicas=${img.maxReplicas} ` +
        `--update-stackdriver-metric=pubsub.googleapis.com/subscription/num_undelivered_messages ` +
        `--stackdriver-metric-filter='resource.type="pubsub_subscription" AND resource.label.subscription_id="${img.subscription}"' ` +
        `--stackdriver-metric-single-instance-assignment=1`
    );

    console.log(`\nPrepared: ${img.name} → ${tagHash}, MIG ${mig} (spot ${img.gpu}× L4, 0→${img.maxReplicas})`);
    return img.name;
  }));

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

deploy().catch((err) => {
  console.error("Deploy failed:", err.message);
  process.exit(1);
});
