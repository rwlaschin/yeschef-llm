// Cloud Monitoring's webhook notification sends its OWN JSON schema (1.2: { incident: {...},
// version }) — not Slack's expected { text } shape. Slack's Incoming Webhook rejects/ignores
// anything without a `text` field, so posting Monitoring's payload straight at Slack silently
// fails. This relay sits in between: Monitoring → here → reformatted → Slack.
//
// Every message carries two links (the actual ask): a DEBUG link (Monitoring's own incident page
// — shows the metric graph + resource) and a DISABLE link (the alert policy's edit page, one
// toggle to turn it off while you investigate, so a known/ongoing issue doesn't keep paging).
import http from "http";

const SLACK_WEBHOOK = process.env.SLACK_ALERTS_WEBHOOK;
const RELAY_TOKEN = process.env.RELAY_TOKEN; // shared secret Monitoring sends as Bearer auth
const PROJECT_ID = process.env.GCP_PROJECT_ID;

if (!SLACK_WEBHOOK) throw new Error("SLACK_ALERTS_WEBHOOK env var is required");
if (!RELAY_TOKEN) throw new Error("RELAY_TOKEN env var is required");

// incident.policy_name is the full resource path (projects/<p>/alertPolicies/<id>) — the id is
// everything after the last slash, used to build the direct "disable this" console link.
const policyId = (policyName) => String(policyName || "").split("/").pop();
const policyConsoleUrl = (policyName) =>
  `https://console.cloud.google.com/monitoring/alerting/policies/${policyId(policyName)}?project=${PROJECT_ID}`;

function slackText(incident) {
  const emoji = incident.state === "closed" ? "✅" : "🚨";
  const state = incident.state === "closed" ? "RESOLVED" : "FIRING";
  const lines = [
    `${emoji} *${state}* — ${incident.policy_name ? incident.condition_name || incident.policy_name : "Alert"}`,
    incident.summary || "",
    incident.resource_name ? `Resource: \`${incident.resource_name}\`` : "",
    `<${incident.url}|Debug this incident>  ·  <${policyConsoleUrl(incident.policy_name)}|Disable this alert>`,
  ].filter(Boolean);
  return lines.join("\n");
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(405); res.end(); return; }

  // "webhook_tokenauth" channels have exactly one configurable field — the URL — no separate
  // auth-header support. So the shared secret rides IN the URL as a query param, not a header.
  const token = new URL(req.url, "http://x").searchParams.get("token");
  if (token !== RELAY_TOKEN) { res.writeHead(401); res.end("unauthorized"); return; }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const payload = JSON.parse(body);
      const incident = payload.incident || {};
      const text = slackText(incident);
      const slackRes = await fetch(SLACK_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      console.log(`relayed incident=${incident.incident_id} state=${incident.state} → slack ${slackRes.status}`);
      res.writeHead(200); res.end("ok");
    } catch (err) {
      console.error("relay error:", err.message);
      res.writeHead(500); res.end(err.message);
    }
  });
});

const port = process.env.PORT || 8080;
server.listen(port, () => console.log(`slack-relay listening on ${port}`));
