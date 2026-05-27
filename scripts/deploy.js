// ============================================================
// Deploy - builds both images, pushes to Artifact Registry,
// deploys to Cloud Run (production only)
//
// Usage:
//   npm run deploy
// ============================================================

import dotenvFlow from "dotenv-flow";
import { execSync } from "child_process";
import { setup as setupPubSub } from "../pubsub/setup.js";

dotenvFlow.config();

const {
  GCP_PROJECT_ID,
  GCP_REGION = "us-central1",
  MONGO_URI,
  MONGO_DB,
  MONGO_COLLECTION,
} = process.env;

for (const [k, v] of Object.entries({ GCP_PROJECT_ID, MONGO_URI, MONGO_DB, MONGO_COLLECTION })) {
  if (!v) throw new Error(`${k} env var is required`);
}

const REGISTRY = `${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/ollama`;
const VERSION = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

const IMAGES = [
  {
    name:         "ollama-slim",
    dockerfile:   "docker/slim/Dockerfile",
    service:      "ollama-slim",
    subscription: "sub_llama3_2b_v1",
    model:        "llama3.2:2b",
    gpu:          1,
  },
  {
    name:         "ollama-large",
    dockerfile:   "docker/large/Dockerfile",
    service:      "ollama-large",
    subscription: "sub_llama3_3_70b_v1",
    model:        "llama3.3:70b-instruct-q4_K_M",
    gpu:          2,
  },
];

function run(cmd) {
  console.log(`\n> ${cmd}\n`);
  execSync(cmd, { stdio: "inherit" });
}

async function deploy() {
  console.log(`\nDeploying to production`);
  console.log(`Version  : ${VERSION}`);
  console.log(`Project  : ${GCP_PROJECT_ID}`);
  console.log(`Registry : ${REGISTRY}\n`);

  // 1. Ensure Pub/Sub topics + subscriptions exist
  await setupPubSub(GCP_PROJECT_ID);

  // 2. Ensure Artifact Registry repo exists
  try {
    run(`gcloud artifacts repositories create ollama \
      --repository-format=docker \
      --location=${GCP_REGION} \
      --project=${GCP_PROJECT_ID}`);
  } catch {
    console.log("Artifact Registry repo already exists, continuing...");
  }

  // 3. Configure docker auth
  run(`gcloud auth configure-docker ${GCP_REGION}-docker.pkg.dev --quiet`);

  // 4. Build, push, deploy each image
  for (const img of IMAGES) {
    const tag       = `${REGISTRY}/${img.name}:${VERSION}`;
    const tagLatest = `${REGISTRY}/${img.name}:latest`;

    console.log(`\n==== ${img.name} ====`);

    run(`docker build -f ${img.dockerfile} -t ${tag} -t ${tagLatest} .`);
    run(`docker push ${tag}`);
    run(`docker push ${tagLatest}`);

    run(`gcloud run deploy ${img.service} \
      --image=${tag} \
      --region=${GCP_REGION} \
      --project=${GCP_PROJECT_ID} \
      --platform=managed \
      --no-allow-unauthenticated \
      --gpu=${img.gpu} \
      --gpu-type=nvidia-l4 \
      --set-env-vars=GCP_PROJECT_ID=${GCP_PROJECT_ID} \
      --set-env-vars=SUBSCRIPTION_NAME=${img.subscription} \
      --set-env-vars=OLLAMA_MODEL=${img.model} \
      --set-env-vars=MONGO_URI=${MONGO_URI} \
      --set-env-vars=MONGO_DB=${MONGO_DB} \
      --set-env-vars=MONGO_COLLECTION=${MONGO_COLLECTION} \
      --revision-suffix=${VERSION}`);

    console.log(`\nDeployed: ${img.service} @ ${tag}`);
  }

  console.log(`\nDeploy complete @ ${VERSION}\n`);
}

deploy().catch((err) => {
  console.error("Deploy failed:", err.message);
  process.exit(1);
});
