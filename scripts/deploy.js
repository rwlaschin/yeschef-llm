// ============================================================
// Deploy — GCE spot MIG with Container-Optimized OS (no custom image baking).
//
//   1. build the Docker image (Ollama + worker + baked model) → Artifact Registry
//   2. instance template: SPOT, GPU L4(s), COS --container-image pulls on first boot
//   3. managed instance group + autoscaler on Pub/Sub backlog (min 0 → max N)
//
// No builder VM, no 200GB GCE disk snapshot, no polling loop.
// COS caches Artifact Registry layers across the MIG — boot is fast after the first VM.
//
// One VM per replica. GPU count comes from the model's "machine description":
//   2B / openclaw → 1× L4 (g2-standard-8),  70B → 2× L4 (g2-standard-24, one box).
//
// Spot + scale-to-zero + no cluster fee. Preemption is safe: the worker acks only
// after the final Firestore write, so a preempted job is redelivered and another
// spot VM finishes it (jobId idempotency guards partial writes).
//
// Applies for real by default. Pass --dry-run to only PRINT the gcloud/docker
// commands without executing them (preview the plan).
// ============================================================

import dotenvFlow from "dotenv-flow";
import { execSync } from "child_process";
import fs from "fs";
import crypto from "crypto";
import ejs from "ejs";
import { setup as setupPubSub } from "../pubsub/setup.js";
import { MODELS, subscriptionOf, imageOf } from "../config/models.js";

dotenvFlow.config();

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
const APPLY = !DRY_RUN;

for (const [k, v] of Object.entries({
  GCP_PROJECT_ID, GCP_ZONE, GCP_SERVICE_ACCOUNT, MONGO_URI, MONGO_DB, MONGO_COLLECTION,
})) {
  if (!v) throw new Error(`${k} env var is required`);
}

const REGISTRY = `${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/ollama`;
const VERSION = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

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

const DEFAULTS = { parallel: 2, maxQueue: 5, gpu: 1, maxReplicas: 3 };

// Derived from the single source of truth (config/models.js).
// gpu = the model's "machine description" (L4s on one VM).
const IMAGES = MODELS.map((m) => ({
  name: imageOf(m),
  subscription: subscriptionOf(m),
  model: m.model,
  gpu: m.gpu,
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

function renderDockerfile(img) {
  const template = fs.readFileSync("docker/Dockerfile.ejs", "utf-8");
  return ejs.render(template, img);
}

function esc(s) {
  return s.replace(/'/g, "'\\''");
}

// Startup script for COS GPU VMs:
//   1. Install NVIDIA drivers via cos-extensions (once per VM, ~1-2 min)
//   2. Authenticate to Artifact Registry
//   3. Pull + run the worker container with GPU access
// No custom GCE image needed — cos-stable is the base, no 200GB snapshot.
function vmStartupScript(img, tag) {
  return [
    "#!/bin/bash",
    "set -e",
    // Install GPU drivers (idempotent — skips if already installed)
    "cos-extensions install gpu --wait",
    // Auth to Artifact Registry
    `docker-credential-gcr configure-docker --registries=${GCP_REGION}-docker.pkg.dev || \\`,
    `  gcloud auth configure-docker ${GCP_REGION}-docker.pkg.dev --quiet`,
    // Pull image (cached in Artifact Registry; subsequent VMs in the MIG are fast)
    `docker pull ${tag}`,
    // Run worker with NVIDIA runtime for GPU access
    `docker run -d --name worker --restart=on-failure \\`,
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

async function deploy() {
  console.log(`\nDeploy — GCE spot MIG (COS container)  ${APPLY ? "(APPLY)" : "(DRY-RUN)"}`);
  console.log(`Version : ${VERSION}   Project: ${GCP_PROJECT_ID}   Zone: ${GCP_ZONE}`);
  console.log(`Registry: ${REGISTRY}\n`);

  // 1. Pub/Sub topics + subscriptions
  if (APPLY) await setupPubSub(GCP_PROJECT_ID);
  else console.log("[dry-run] setupPubSub(...)");

  // 2. Artifact Registry + docker auth
  run(
    `gcloud artifacts repositories create ollama --repository-format=docker ` +
      `--location=${GCP_REGION} --project=${GCP_PROJECT_ID} || true`
  );
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

  // Dry-run: iterate ALL models (prints gcloud commands for each), but only build+verify
  // the first dev model locally (small, already on disk — proves the Dockerfile template works).
  const dryRunVerifyTarget = !APPLY ? IMAGES.find((m) => m.dev) : null;

  for (const base of IMAGES) {
    const img = { ...DEFAULTS, ...base };
    const machineType = MACHINE_BY_GPU[img.gpu] || MACHINE_BY_GPU[1];
    const template = `${img.name}-tmpl-${VERSION}`.slice(0, 61);
    const mig = `${img.name}-mig`;

    // Content hash — stable tag based on Dockerfile + worker/config source.
    // If this tag already exists in Artifact Registry, the image is unchanged → skip build.
    const dockerfile = renderDockerfile(img);
    const hash = contentHash(dockerfile);
    const tagHash = `${REGISTRY}/${img.name}:${hash}`;
    const tagLatest = `${REGISTRY}/${img.name}:latest`;

    console.log(`\n==== ${img.name} (gpu=${img.gpu}, ${machineType}) hash=${hash} ====`);

    const alreadyBuilt = APPLY && imageExistsInRegistry(tagHash);
    if (alreadyBuilt) {
      console.log(`  ✓ Image unchanged (${hash}) — skipping build, reusing existing image.`);
    }

    // 3. Build + push the Docker image.
    //    dev models  → local docker build (model already on disk from dev)
    //    prod-only   → Cloud Build (70B images are too large for a laptop)
    const dfTmpName = `Dockerfile.${img.name}.tmp`;
    if (!APPLY) {
      if (dryRunVerifyTarget && img.name === dryRunVerifyTarget.name) {
        // Dry-run: build the first dev model locally to verify the Dockerfile template is correct.
        // Small model, already on disk — fast. Same template as all other models.
        console.log(`\n[dry-run] Building ${img.name} locally to verify Dockerfile...`);
        const localTag = `dry-run-verify-${img.name}`;
        try {
          execSync(`echo '${esc(dockerfile)}' | docker build -f - -t ${localTag} .`, { stdio: "inherit" });
          console.log(`\n[dry-run] ✓ ${img.name} Dockerfile builds cleanly.`);
        } finally {
          execSync(`docker rmi ${localTag} --force 2>/dev/null || true`, { stdio: "pipe" });
        }
      }
      run(`docker push ${tagHash}`);
      run(`gcloud artifacts docker tags add ${tagHash} ${tagLatest} --project=${GCP_PROJECT_ID}`);
    } else if (!alreadyBuilt && img.dev) {
      // Dev-capable model: build locally (model layers already cached from dev)
      run(`echo '${esc(dockerfile)}' | docker build -f - -t ${tagHash} .`);
      run(`docker push ${tagHash}`);
      run(`gcloud artifacts docker tags add ${tagHash} ${tagLatest} --project=${GCP_PROJECT_ID}`);
    } else if (!alreadyBuilt) {
      // Prod-only model (70B): build on Cloud Build — too large for local disk.
      // Dockerfile written to cwd so it's included in the submitted source tarball.
      fs.writeFileSync(dfTmpName, dockerfile);
      run(
        `gcloud builds submit . --project=${GCP_PROJECT_ID} --region=${GCP_REGION} ` +
          `--dockerfile=${dfTmpName} --tag=${tagHash} --timeout=3600`
      );
      run(`gcloud artifacts docker tags add ${tagHash} ${tagLatest} --project=${GCP_PROJECT_ID}`);
      fs.unlinkSync(dfTmpName);
    }

    // Cleanup: delete all digest tags except the current hash (keep latest + current hash only)
    run(
      `gcloud artifacts docker images list ${REGISTRY}/${img.name} ` +
        `--include-tags --format="value(version,tags)" --project=${GCP_PROJECT_ID} | ` +
        `grep -v "${hash}" | grep -v "latest" | awk '{print $1}' | ` +
        `xargs -I{} gcloud artifacts docker images delete ` +
        `${REGISTRY}/${img.name}@{} --project=${GCP_PROJECT_ID} --quiet 2>/dev/null || true`
    );

    // 4. Instance template — SPOT GPU VM on cos-stable.
    //    Startup script installs NVIDIA drivers, pulls image, runs container.
    //    No builder VM, no custom GCE disk image — cos-stable is the base.
    run(
      `gcloud compute instance-templates create ${template} --project=${GCP_PROJECT_ID} ` +
        `--machine-type=${machineType} ` +
        `--image-family=cos-stable --image-project=cos-cloud ` +
        `--accelerator=type=nvidia-l4,count=${img.gpu} --maintenance-policy=TERMINATE ` +
        `--provisioning-model=SPOT --instance-termination-action=DELETE ` +
        `--network=${GCP_NETWORK} --scopes=cloud-platform --service-account=${GCP_SERVICE_ACCOUNT} ` +
        `--metadata=startup-script='${esc(vmStartupScript(img, tagHash))}'`
    );

    // 5. MIG + autoscaler on Pub/Sub backlog (scale 0 → maxReplicas)
    run(
      `gcloud compute instance-groups managed create ${mig} --project=${GCP_PROJECT_ID} ` +
        `--zone=${GCP_ZONE} --template=${template} --size=0 || ` +
        `gcloud compute instance-groups managed set-instance-template ${mig} ` +
        `--project=${GCP_PROJECT_ID} --zone=${GCP_ZONE} --template=${template}`
    );
    run(
      `gcloud compute instance-groups managed set-autoscaling ${mig} --project=${GCP_PROJECT_ID} ` +
        `--zone=${GCP_ZONE} --min-num-replicas=0 --max-num-replicas=${img.maxReplicas} ` +
        `--update-stackdriver-metric=pubsub.googleapis.com/subscription/num_undelivered_messages ` +
        `--stackdriver-metric-filter='resource.type=\\"pubsub_subscription\\" AND resource.label.subscription_id=\\"${img.subscription}\\"' ` +
        `--stackdriver-metric-single-instance-assignment=1`
    );

    console.log(`\nPrepared: ${img.name} → ${tagHash}, MIG ${mig} (spot ${img.gpu}× L4, 0→${img.maxReplicas})`);
  }

  console.log(`\n${APPLY ? "Deploy complete" : "Dry-run complete (pass --dry-run=0 to execute)"} @ ${VERSION}\n`);
}

deploy().catch((err) => {
  console.error("Deploy failed:", err.message);
  process.exit(1);
});
