// ============================================================
// Rollback - reverts Cloud Run services to previous revision
//
// Usage:
//   npm run rollback:prod
//   npm run rollback:test
// ============================================================

import dotenvFlow from "dotenv-flow";
import { execSync } from "child_process";

dotenvFlow.config();

const env = process.env.NODE_ENV;
if (!env || !["production", "test"].includes(env)) {
  console.error("NODE_ENV must be production or test");
  process.exit(1);
}

const {
  GCP_PROJECT_ID,
  GCP_REGION = "us-central1",
} = process.env;

if (!GCP_PROJECT_ID) throw new Error("GCP_PROJECT_ID env var is required");

const SERVICES = [
  `ollama-slim-${env}`,
  `ollama-large-${env}`,
];

function run(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function runLive(cmd) {
  console.log(`\n> ${cmd}\n`);
  execSync(cmd, { stdio: "inherit" });
}

function getRevisions(service) {
  const output = run(
    `gcloud run revisions list \
      --service=${service} \
      --region=${GCP_REGION} \
      --project=${GCP_PROJECT_ID} \
      --format="value(metadata.name,status.conditions[0].lastTransitionTime)" \
      --sort-by="~metadata.creationTimestamp" \
      --limit=5`
  );

  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, time] = line.split(/\s+/);
      return { name, time };
    });
}

async function rollback() {
  console.log(`\nRolling back: ${env.toUpperCase()}\n`);

  for (const service of SERVICES) {
    console.log(`==== ${service} ====`);

    const revisions = getRevisions(service);

    if (revisions.length < 2) {
      console.log(`  Only one revision exists, cannot rollback.\n`);
      continue;
    }

    const current = revisions[0];
    const previous = revisions[1];

    console.log(`  Current  : ${current.name} (${current.time})`);
    console.log(`  Rollback : ${previous.name} (${previous.time})`);

    runLive(
      `gcloud run services update-traffic ${service} \
        --region=${GCP_REGION} \
        --project=${GCP_PROJECT_ID} \
        --to-revisions=${previous.name}=100`
    );

    console.log(`  Rolled back to: ${previous.name}\n`);
  }

  console.log(`Rollback complete: ${env.toUpperCase()}\n`);
}

rollback().catch((err) => {
  console.error("Rollback failed:", err.message);
  process.exit(1);
});
