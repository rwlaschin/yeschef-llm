// ============================================================
// Deploy the Slack alert relay — Cloud Run, source in monitoring/slack-relay.
// Cloud Monitoring's webhook payload doesn't match Slack's format; this relay reformats it
// and adds Debug/Disable links. See monitoring/slack-relay/index.js for why.
//
// REUSES the existing SLACK_RELAY_TOKEN from env — never generates a new one on redeploy.
// The notification channel's URL is `${SLACK_RELAY_URL}/?token=${SLACK_RELAY_TOKEN}`; rotating
// the token here without updating that channel would silently break alerting.
//
//   npm run deploy:relay
// ============================================================
import dotenvFlow from "dotenv-flow";
import { execSync } from "child_process";

dotenvFlow.config();

const { GCP_PROJECT_ID, GCP_REGION = "us-central1", SLACK_ALERTS_WEBHOOK, SLACK_RELAY_TOKEN } = process.env;

for (const [k, v] of Object.entries({ GCP_PROJECT_ID, SLACK_ALERTS_WEBHOOK, SLACK_RELAY_TOKEN })) {
  if (!v) throw new Error(`${k} env var is required`);
}

const envVars = `SLACK_ALERTS_WEBHOOK=${SLACK_ALERTS_WEBHOOK},RELAY_TOKEN=${SLACK_RELAY_TOKEN},GCP_PROJECT_ID=${GCP_PROJECT_ID}`;

console.log(`\nDeploying slack-relay to Cloud Run (${GCP_PROJECT_ID}/${GCP_REGION})...\n`);
execSync(
  `gcloud run deploy slack-relay --project=${GCP_PROJECT_ID} --region=${GCP_REGION} ` +
    `--source=monitoring/slack-relay --allow-unauthenticated ` +
    `--set-env-vars="${envVars}" --memory=256Mi --min-instances=0 --max-instances=2`,
  { stdio: "inherit" }
);
console.log("\n✓ slack-relay deployed. If the URL changed, update the notification channel's URL label.\n");
