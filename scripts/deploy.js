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
import { MODELS, subscriptionOf, imageOf } from "../config/models.js";

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
} = process.env;

// Applies for real by default. Pass --dry-run to only print the commands (no execution).
const args = process.argv.slice(2);
const DRY_RUN = args.some((a) => a === "--dry-run" || a === "--dry-run=1" || a === "--dry-run=true");
const USE_SPOT = args.some((a) => a === "--spot");
const APPLY = !DRY_RUN;

for (const [k, v] of Object.entries({
  GCP_PROJECT_ID, GCP_ZONE, GCP_SERVICE_ACCOUNT, MONGO_URI, MONGO_DB, MONGO_COLLECTION,
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

// gpu count → g2 machine type (L4s on a single box)
const MACHINE_BY_GPU = { 1: "g2-standard-8", 2: "g2-standard-24" };

const DEFAULTS = { parallel: 2, maxQueue: 5, gpu: 1, maxReplicas: 7 };

// Derived from the single source of truth (config/models.js).
// gpu = the model's "machine description" (L4s on one VM).
const IMAGES = MODELS.map((m) => ({
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
    `docker-credential-gcr configure-docker --registries=${region}-docker.pkg.dev || \\`,
    `  gcloud auth configure-docker ${region}-docker.pkg.dev --quiet`,
    `docker pull ${tag}`,
    // Signal completion by writing a metadata key the deploy script polls
    `gcloud compute instances add-metadata "$NAME" --zone="$ZONE" --metadata=bake-done=true`,
  ].join("\n");
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

  // Baker only needs to docker pull — use e2-medium (cheap). DLVM base image has NVIDIA
  // drivers pre-installed so the baker itself doesn't need a GPU. GCE images are global
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
        `--machine-type=e2-medium --image-family=common-cu129-ubuntu-2204-nvidia-580 --image-project=deeplearning-platform-release ` +
        `--boot-disk-size=${img.diskGb}GB --boot-disk-type=pd-ssd ` +
        `--network=${GCP_NETWORK} --scopes=cloud-platform --service-account=${GCP_SERVICE_ACCOUNT} ` +
        `--metadata=startup-script='${esc(bakerStartupScript(tag, GCP_REGION))}'`,
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
    const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30_000));
      try {
        const val = execSync(
          `gcloud compute instances describe ${bakerName} --zone=${bakerZone} --project=${GCP_PROJECT_ID} --format="value(metadata.items[bake-done])"`,
          { stdio: "pipe" }
        ).toString().trim();
        if (val === "true") { console.log("  ✓ Baker done."); break; }
      } catch { /* still booting */ }
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
    const dockerfile = renderDockerfile(img);
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
      fs.writeFileSync(
        cbName,
        `steps:\n- name: 'gcr.io/cloud-builders/docker'\n` +
          `  args: ['build', '-f', '${dfName}', '-t', '${tagHash}', '.']\n` +
          `  timeout: 3600s\nimages:\n- '${tagHash}'\ntimeout: 3600s\n`
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
  await Promise.all(cloudBuildJobs.map(async ({ p, promise }) => {
    const { img, hash, tagHash, tagLatest, machineType, template, mig } = p;
    console.log(`\nAwaiting Cloud Build: ${img.name}...`);
    await promise;
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
    const gceImage = await bakeGCEImage(img, tagHash, hash, machineType);

    // Instance template — SPOT GPU VM on baked custom image.
    run(
      `gcloud compute instance-templates create ${template} --project=${GCP_PROJECT_ID} ` +
        `--machine-type=${machineType} ` +
        `--image=${gceImage} --image-project=${GCP_PROJECT_ID} ` +
        `--accelerator=type=nvidia-l4,count=${img.gpu} --maintenance-policy=TERMINATE ` +
        (USE_SPOT ? `--provisioning-model=SPOT --instance-termination-action=STOP ` : "") +
        `--network=${GCP_NETWORK} --scopes=cloud-platform --service-account=${GCP_SERVICE_ACCOUNT} ` +
        `--metadata=startup-script='${esc(vmStartupScript(img, tagHash))}'`
    );

    // MIG + autoscaler on Pub/Sub backlog (scale 0 → maxReplicas).
    let migExists = false;
    try {
      execSync(
        `gcloud compute instance-groups managed describe ${mig} ` +
          `--project=${GCP_PROJECT_ID} --zone=${GCP_ZONE} --format="value(name)"`,
        { stdio: "pipe" }
      );
      migExists = true;
    } catch { /* doesn't exist yet */ }

    if (migExists) {
      run(
        `gcloud compute instance-groups managed set-instance-template ${mig} ` +
          `--project=${GCP_PROJECT_ID} --zone=${GCP_ZONE} --template=${template}`
      );
    } else {
      run(
        `gcloud compute instance-groups managed create ${mig} --project=${GCP_PROJECT_ID} ` +
          `--zone=${GCP_ZONE} --template=${template} --size=0`
      );
    }
    run(
      `gcloud compute instance-groups managed set-autoscaling ${mig} --project=${GCP_PROJECT_ID} ` +
        `--zone=${GCP_ZONE} --min-num-replicas=0 --max-num-replicas=${img.maxReplicas} ` +
        `--update-stackdriver-metric=pubsub.googleapis.com/subscription/num_undelivered_messages ` +
        `--stackdriver-metric-filter='resource.type="pubsub_subscription" AND resource.label.subscription_id="${img.subscription}"' ` +
        `--stackdriver-metric-single-instance-assignment=1`
    );

    console.log(`\nPrepared: ${img.name} → ${tagHash}, MIG ${mig} (spot ${img.gpu}× L4, 0→${img.maxReplicas})`);
  }));

  console.log(`\n${APPLY ? "Deploy complete" : "Dry-run complete (pass --dry-run=0 to execute)"} @ ${VERSION}\n`);
}

deploy().catch((err) => {
  console.error("Deploy failed:", err.message);
  process.exit(1);
});
