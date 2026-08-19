// postdeploy: push env vars from .env.production/.env into the Cloud Run service for the
// orchestrator. Firebase Functions v2 .env file support is unreliable; gcloud run services
// update --env-vars-file is the explicit, special-char-safe path.
import dotenvFlow from "dotenv-flow";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

dotenvFlow.config();

const {
  MONGO_URI,
  MONGO_DB = "yeschef",
  GCP_PROJECT_ID,
  GCP_REGION = "us-central1",
  ORCHESTRATE_TOPIC,
  MAX_GEN,
  ORCHESTRATOR_SOFT_DELETE,
} = process.env;

if (!MONGO_URI) throw new Error("MONGO_URI not set in env");
if (!GCP_PROJECT_ID) throw new Error("GCP_PROJECT_ID not set in env");

const vars = {
  MONGO_URI,
  MONGO_DB,
  GCP_PROJECT_ID,
  ...(ORCHESTRATE_TOPIC && { ORCHESTRATE_TOPIC }),
  ...(MAX_GEN && { MAX_GEN }),
  ...(ORCHESTRATOR_SOFT_DELETE && { ORCHESTRATOR_SOFT_DELETE }),
};

// YAML: each value quoted to handle special chars in connection strings
const yaml = Object.entries(vars)
  .map(([k, v]) => `${k}: "${v.replace(/"/g, '\\"')}"`)
  .join("\n");

const tmpFile = join(tmpdir(), "yc-functions-env.yaml");
writeFileSync(tmpFile, yaml);

try {
  console.log(`[set-functions-env] setting: ${Object.keys(vars).join(", ")}`);
  execSync(
    `gcloud run services update ai --region=${GCP_REGION} --project=${GCP_PROJECT_ID} --env-vars-file=${tmpFile}`,
    { stdio: "inherit" }
  );
  console.log("[set-functions-env] done");
} finally {
  unlinkSync(tmpFile);
}
