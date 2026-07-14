// ============================================================
// Rollback — reverts BOTH deploy targets (mirror of deploy-all.js):
//
//   orchestrator  /ai function   → Cloud Run service `ai`  → route traffic to prev revision
//   workers       GPU/MIG        → one MIG per model tier   → revert to prev instance template
//
// The orchestrator is a gen2 Firebase Function (`export { _ai as ai }` in functions/index.js),
// so it runs as a Cloud Run service named `ai` — rolling it back = shifting 100% traffic to the
// previous revision. The workers are GCE MIGs (deploy.js): each MIG points at a versioned
// instance template `ollama-<slug>-tmpl-<VERSION>`; rolling one back = pointing the MIG at the
// template one version older and replacing any running instances.
//
// Names are DERIVED from config/models.js (imageOf) so they never drift from what deploy built.
//
// Usage:
//   npm run rollback                 # both targets
//   npm run rollback -- --only=run   # just the /ai Cloud Run service
//   npm run rollback -- --only=mig   # just the worker MIGs
// ============================================================

import dotenvFlow from "dotenv-flow";
import { execSync } from "child_process";
import { MODELS, imageOf } from "../config/models.js";

dotenvFlow.config();

const env = process.env.NODE_ENV;
if (!env || !["production", "test"].includes(env)) {
  console.error("NODE_ENV must be production or test");
  process.exit(1);
}

const {
  GCP_PROJECT_ID,
  GCP_REGION = "us-central1",
  GCP_ZONE,
} = process.env;

if (!GCP_PROJECT_ID) throw new Error("GCP_PROJECT_ID env var is required");

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? onlyArg.split("=")[1] : "all"; // "run" | "mig" | "all"

// Cloud Run service for the /ai gen2 function (named after the function export).
const FUNCTION_SERVICE = "ai";
// One MIG per model tier — exactly the names deploy.js creates (`${imageOf(m)}-mig`).
const MIGS = MODELS.map((m) => `${imageOf(m)}-mig`);

function run(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function runLive(cmd) {
  console.log(`\n> ${cmd}\n`);
  execSync(cmd, { stdio: "inherit" });
}

// ---- Cloud Run (orchestrator /ai) -------------------------------------------
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

function rollbackCloudRun(service) {
  console.log(`\n==== Cloud Run: ${service} ====`);
  const revisions = getRevisions(service);

  if (revisions.length < 2) {
    console.log(`  Only one revision exists, cannot rollback.\n`);
    return;
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

// ---- GCE MIG (workers) ------------------------------------------------------
function rollbackMig(mig) {
  console.log(`\n==== MIG: ${mig} ====`);
  if (!GCP_ZONE) {
    console.log(`  GCP_ZONE env var required for MIG rollback — skipping.\n`);
    return;
  }

  // The MIG either exists or it doesn't (tier never deployed) — skip cleanly if absent.
  let currentUrl;
  try {
    currentUrl = run(
      `gcloud compute instance-groups managed describe ${mig} \
        --zone=${GCP_ZONE} --project=${GCP_PROJECT_ID} \
        --format="value(instanceTemplate)"`
    );
  } catch {
    console.log(`  MIG not found — skipping (tier not deployed).\n`);
    return;
  }
  const current = currentUrl.split("/").pop();

  // All instance templates for this tier, newest first. Roll back = the one VERSION
  // immediately older than whatever the MIG currently points at.
  const prefix = mig.replace(/-mig$/, "-tmpl-");
  const templates = run(
    `gcloud compute instance-templates list \
      --project=${GCP_PROJECT_ID} \
      --filter="name~^${prefix}" \
      --sort-by="~creationTimestamp" \
      --format="value(name)" --limit=10`
  )
    .split("\n")
    .filter(Boolean);

  const idx = templates.indexOf(current);
  const previous = idx >= 0 ? templates[idx + 1] : templates.find((t) => t !== current);

  if (!previous) {
    console.log(`  No previous instance template (current: ${current}), cannot rollback.\n`);
    return;
  }

  console.log(`  Current  : ${current}`);
  console.log(`  Rollback : ${previous}`);

  runLive(
    `gcloud compute instance-groups managed set-instance-template ${mig} \
      --template=${previous} --zone=${GCP_ZONE} --project=${GCP_PROJECT_ID}`
  );
  // Replace any running instances now; a scaled-to-zero MIG just picks it up on next scale-up.
  runLive(
    `gcloud compute instance-groups managed rolling-action replace ${mig} \
      --zone=${GCP_ZONE} --project=${GCP_PROJECT_ID}`
  );

  console.log(`  Rolled back to: ${previous}\n`);
}

async function rollback() {
  console.log(`\nRolling back: ${env.toUpperCase()}  (target: ${ONLY})\n`);

  if (ONLY === "all" || ONLY === "run") {
    rollbackCloudRun(FUNCTION_SERVICE);
  }
  if (ONLY === "all" || ONLY === "mig") {
    for (const mig of MIGS) rollbackMig(mig);
  }

  console.log(`Rollback complete: ${env.toUpperCase()}\n`);
}

rollback().catch((err) => {
  console.error("Rollback failed:", err.message);
  process.exit(1);
});
