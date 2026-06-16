// ============================================================
// Deploy — Option A: GCE spot MIG.
//
//   1. build the Docker image (Ollama + worker + baked model) → Artifact Registry
//   2. bake a GCE custom image with that container preloaded (no boot-time pull)
//   3. instance template: SPOT, GPU L4(s), the custom image, startup runs the container
//   4. managed instance group + autoscaler on Pub/Sub backlog (min 0 → max N)
//
// One VM per replica. GPU count comes from the model's "machine description":
//   2B / openclaw → 1× L4 (g2-standard-8),  70B → 2× L4 (g2-standard-24, one box).
//
// Spot + scale-to-zero + no cluster fee. Preemption is safe: the worker acks only
// after the final Firestore write, so a preempted job is redelivered and another
// spot VM (same baked image) finishes it (jobId idempotency guards partial writes).
//
// Applies for real by default. Pass --dry-run to only PRINT the gcloud/docker
// commands without executing them (preview the plan).
//
// ⚠️ UNVERIFIED — not yet run. Verify project params (zone/network/SA/GPU quota)
//    and MIG scale-to-zero (min-replicas=0) before a real deploy.
// ============================================================

import dotenvFlow from "dotenv-flow";
import { execSync } from "child_process";
import fs from "fs";
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

// Startup script the spot VM runs on boot: launch the pre-pulled container.
// Prod uses Application Default Credentials (the VM service account) for Firestore.
function vmStartupScript(img, tag) {
  return [
    "#!/bin/bash",
    "set -e",
    `docker run -d --name worker --restart=on-failure \\`,
    `  -e GCP_PROJECT_ID=${GCP_PROJECT_ID} \\`,
    `  -e FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID || GCP_PROJECT_ID} \\`,
    `  -e SUBSCRIPTION_NAME=${img.subscription} \\`,
    `  -e OLLAMA_MODEL=${img.model} \\`,
    `  -e OLLAMA_HOST=http://localhost:11434 \\`,
    `  -e OLLAMA_NUM_PARALLEL=${img.parallel} \\`,
    `  -e OLLAMA_MAX_QUEUE=${img.maxQueue} \\`,
    `  -e MONGO_URI='${MONGO_URI}' \\`,
    `  -e MONGO_DB=${MONGO_DB} \\`,
    `  -e MONGO_COLLECTION=${MONGO_COLLECTION} \\`,
    `  --gpus all ${tag}`,
  ].join("\n");
}

async function deploy() {
  console.log(`\nDeploy — Option A (GCE spot MIG)  ${APPLY ? "(APPLY)" : "(DRY-RUN)"}`);
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

  for (const base of IMAGES) {
    const img = { ...DEFAULTS, ...base };
    const machineType = MACHINE_BY_GPU[img.gpu] || MACHINE_BY_GPU[1];
    const tag = `${REGISTRY}/${img.name}:${VERSION}`;
    const tagLatest = `${REGISTRY}/${img.name}:latest`;
    const customImage = `${img.name}-${VERSION}`;
    const builder = `bake-${img.name}-${VERSION}`.slice(0, 61);
    const template = `${img.name}-tmpl-${VERSION}`.slice(0, 61);
    const mig = `${img.name}-mig`;

    console.log(`\n==== ${img.name} (gpu=${img.gpu}, ${machineType}) ====`);

    // 3. Build + push the image (the artifact baked onto the VM disk)
    const dockerfile = esc(renderDockerfile(img));
    run(`echo '${dockerfile}' | docker build -f - -t ${tag} -t ${tagLatest} .`);
    run(`docker push ${tag}`);
    run(`docker push ${tagLatest}`);

    // 4. Bake a GCE custom image with the container preloaded (no boot-time pull).
    const bakeScript = [
      "#!/bin/bash",
      "set -e",
      `docker-credential-gcr configure-docker --registries=${GCP_REGION}-docker.pkg.dev || gcloud auth configure-docker ${GCP_REGION}-docker.pkg.dev --quiet`,
      `docker pull ${tag}`,
      "shutdown -h now",
    ].join("\n");
    run(
      `gcloud compute instances create ${builder} --project=${GCP_PROJECT_ID} --zone=${GCP_ZONE} ` +
        `--machine-type=e2-standard-4 --boot-disk-size=200GB ` +
        `--image-family=cos-stable --image-project=cos-cloud ` +
        `--network=${GCP_NETWORK} --scopes=cloud-platform --service-account=${GCP_SERVICE_ACCOUNT} ` +
        `--metadata=startup-script='${esc(bakeScript)}'`
    );
    run(
      `until [ "$(gcloud compute instances describe ${builder} --zone=${GCP_ZONE} ` +
        `--project=${GCP_PROJECT_ID} --format='value(status)')" = "TERMINATED" ]; do sleep 15; done`
    );
    run(
      `gcloud compute images create ${customImage} --project=${GCP_PROJECT_ID} ` +
        `--source-disk=${builder} --source-disk-zone=${GCP_ZONE} --family=${img.name}`
    );
    run(`gcloud compute instances delete ${builder} --zone=${GCP_ZONE} --project=${GCP_PROJECT_ID} --quiet`);

    // 5. Instance template — SPOT GPU VM from the baked image; startup runs the container
    run(
      `gcloud compute instance-templates create ${template} --project=${GCP_PROJECT_ID} ` +
        `--machine-type=${machineType} --image=${customImage} --image-project=${GCP_PROJECT_ID} ` +
        `--accelerator=type=nvidia-l4,count=${img.gpu} --maintenance-policy=TERMINATE ` +
        `--provisioning-model=SPOT --instance-termination-action=DELETE ` +
        `--network=${GCP_NETWORK} --scopes=cloud-platform --service-account=${GCP_SERVICE_ACCOUNT} ` +
        `--metadata=startup-script='${esc(vmStartupScript(img, tag))}'`
    );

    // 6. MIG + autoscaler on Pub/Sub backlog (scale 0 → maxReplicas)
    run(
      `gcloud compute instance-groups managed create ${mig} --project=${GCP_PROJECT_ID} ` +
        `--zone=${GCP_ZONE} --template=${template} --size=0 || ` +
        `gcloud compute instance-groups managed set-instance-template ${mig} ` +
        `--project=${GCP_PROJECT_ID} --zone=${GCP_ZONE} --template=${template}`
    );
    run(
      `gcloud compute instance-groups managed set-autoscaling ${mig} --project=${GCP_PROJECT_ID} ` +
        `--zone=${GCP_ZONE} --min-num-replicas=0 --max-num-replicas=${img.maxReplicas} ` + // ⚠️ verify scale-to-zero
        `--update-stackdriver-metric=pubsub.googleapis.com/subscription/num_undelivered_messages ` +
        `--stackdriver-metric-filter='resource.type=\\"pubsub_subscription\\" AND resource.label.subscription_id=\\"${img.subscription}\\"' ` +
        `--stackdriver-metric-single-instance-assignment=1`
    );

    console.log(`\nPrepared: ${img.name} → image ${customImage}, MIG ${mig} (spot ${img.gpu}× L4, 0→${img.maxReplicas})`);
  }

  console.log(`\n${APPLY ? "Deploy complete" : "Dry-run complete (pass --dry-run=0 to execute)"} @ ${VERSION}\n`);
}

deploy().catch((err) => {
  console.error("Deploy failed:", err.message);
  process.exit(1);
});
