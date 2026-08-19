// POST-DEPLOY SMOKE TEST against PRODUCTION. Read-only except for ONE fake job.
//
// Everything here asserts something that could only break in prod: the provisioning that setup-pubsub
// performs, and the runtime behaviour of the deployed orchestrator + worker image. Each phase prints
// PASS/FAIL with the evidence, so "did the deploy work" has an answer instead of a vibe.
//
//   phase 1  provisioning — DLQ sinks exist AND the two IAM grants dead-lettering requires
//   phase 2  invariants   — no autoscaler on any model MIG (a resize would 412), all MIGs at 0
//   phase 3  fake job     — the CPU fake tier, end to end: box start → ack → outcome → teardown
//   phase 4  log trail    — the structured events that make a quiet box explainable
//
// Usage:  NODE_ENV=production node scripts/prod-smoke.mjs [--skip-job]
// The fake tier runs on an e2-micro, so phase 3 costs cents and never touches an L4.
import { GoogleAuth } from "google-auth-library";
import dotenvFlow from "dotenv-flow";
import { MODELS, deadLetterOf, subscriptionOf, imageOf, FAKE_TOPIC } from "../config/models.js";

dotenvFlow.config();
const PROJECT = process.env.GCP_PROJECT_ID_PROD || process.env.GCP_PROJECT_ID || "yeschef-c572a";
const AI = process.env.AI_BASE_URL || `https://us-central1-${PROJECT}.cloudfunctions.net/ai`;
const SKIP_JOB = process.argv.includes("--skip-job");

const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
let token;
const H = async () => ({ Authorization: `Bearer ${token ??= (await (await auth.getClient()).getAccessToken()).token}` });
const getJSON = async (url, init = {}) => {
  const r = await fetch(url, { ...init, headers: { ...(await H()), "Content-Type": "application/json", ...init.headers } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${url.split("/").slice(-1)[0]} → ${r.status} ${JSON.stringify(j).slice(0, 160)}`);
  return j;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (phase, name, ok, detail = "") => {
  results.push({ phase, name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ── phase 1: provisioning ────────────────────────────────────────────────────────────────────────
console.log("\n[1] provisioning — dead-letter sinks + the grants dead-lettering requires");
const { projectNumber } = await getJSON(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}`);
const AGENT = `serviceAccount:service-${projectNumber}@gcp-sa-pubsub.iam.gserviceaccount.com`;
const subs = (await getJSON(`https://pubsub.googleapis.com/v1/projects/${PROJECT}/subscriptions`)).subscriptions ?? [];
const subNames = subs.map((s) => s.name.split("/").pop());

for (const m of MODELS) {
  const dl = deadLetterOf(m);
  check(1, `sink sub_${dl}`, subNames.includes(`sub_${dl}`), "a DLQ topic with no subscription DISCARDS messages");
}
// The grants are what make dead-lettering possible at all; without them a poison message retries forever.
for (const m of MODELS.slice(0, 2)) {
  const dl = deadLetterOf(m), src = subscriptionOf(m);
  const tp = await getJSON(`https://pubsub.googleapis.com/v1/projects/${PROJECT}/topics/${dl}:getIamPolicy`);
  const sp = await getJSON(`https://pubsub.googleapis.com/v1/projects/${PROJECT}/subscriptions/${src}:getIamPolicy`);
  const has = (p, role) => (p.bindings ?? []).some((b) => b.role === role && (b.members ?? []).includes(AGENT));
  check(1, `publisher on ${dl}`, has(tp, "roles/pubsub.publisher"), "else the forward silently never happens");
  check(1, `subscriber on ${src}`, has(sp, "roles/pubsub.subscriber"), "else the source ack silently never happens");
}

// ── phase 2: invariants ──────────────────────────────────────────────────────────────────────────
console.log("\n[2] invariants — the capacity loop sizes MIGs itself, so an autoscaler would 412 every resize");
const COMPUTE = `https://compute.googleapis.com/compute/v1/projects/${PROJECT}`;
const ascs = await getJSON(`${COMPUTE}/aggregated/autoscalers`);
const stray = [];
for (const scope of Object.values(ascs.items ?? {})) {
  for (const a of scope.autoscalers ?? []) if (!a.name.startsWith("worker-fake-canned")) stray.push(a.name);
}
check(2, "no autoscaler on any model MIG", stray.length === 0, stray.length ? `found: ${stray.join(", ")}` : "only the fake tier autoscales");

const migs = await getJSON(`${COMPUTE}/aggregated/instanceGroupManagers`);
const hot = [];
for (const scope of Object.values(migs.items ?? {})) {
  for (const g of scope.instanceGroupManagers ?? []) if ((g.targetSize ?? 0) > 0) hot.push(`${g.name}=${g.targetSize}`);
}
check(2, "no idle boxes billing before the test", hot.length === 0, hot.length ? hot.join(", ") : "every MIG at 0");

// ── phase 3: one fake job, end to end ────────────────────────────────────────────────────────────
let jobId = null;
if (SKIP_JOB) {
  console.log("\n[3] fake job — SKIPPED (--skip-job)");
} else {
  console.log("\n[3] fake job on the CPU fake tier — start → ack → outcome → teardown");
  const started = Date.now();
  ({ jobId } = await getJSON(`${AI}/query`, {
    method: "POST",
    body: JSON.stringify({ query: "prod smoke: canned probe", fake: true, type: "task", style: "structured" }),
  }));
  check(3, "job accepted", !!jobId, `jobId=${jobId}`);

  // Poll Cloud Logging for this jobId's trail rather than guessing a duration.
  const since = new Date(started - 60_000).toISOString();
  let entries = [];
  for (let i = 0; i < 40; i++) {
    await wait(15_000);
    entries = (await getJSON("https://logging.googleapis.com/v2/entries:list", {
      method: "POST",
      body: JSON.stringify({
        resourceNames: [`projects/${PROJECT}`],
        filter: `timestamp>"${since}" AND (jsonPayload.jobId="${jobId}" OR textPayload:"${jobId}" OR jsonPayload.capacityEvent!="" OR jsonPayload.workerEvent!="")`,
        orderBy: "timestamp asc", pageSize: 200,
      }),
    })).entries ?? [];
    const text = JSON.stringify(entries);
    if (text.includes(`acked ${jobId}`) || text.includes(`"jobId":"${jobId}"`)) break;
  }
  const all = JSON.stringify(entries);
  const msg = (e) => e.jsonPayload?.message ?? e.textPayload ?? "";

  check(3, "worker acked the job", all.includes(`acked ${jobId}`), "the canned path completed");
  check(3, "capacity recorded the outcome", entries.some((e) => e.jsonPayload?.capacityEvent === "outcome"), "");
  // THE regression this deploy is about: the outcome must NOT tear the box down.
  const released = entries.some((e) => /delete-instance/.test(msg(e)) && e.jsonPayload?.capacityEvent === "actuate");
  const deferred = entries.some((e) => e.jsonPayload?.capacityEvent === "release_deferred");
  check(3, "outcome did NOT release the box", !released || deferred,
    deferred ? "teardown handed to the reconciler, as intended" : "a delete-instance fired on the outcome — the old behaviour");

  // ── phase 4: the log trail ─────────────────────────────────────────────────────────────────────
  console.log("\n[4] structured log trail — what makes a quiet box explainable");
  for (const ev of ["reconcile", "actuate", "outcome"]) {
    check(4, `capacityEvent=${ev} present`, entries.some((e) => e.jsonPayload?.capacityEvent === ev), "");
  }
  const workerEvents = [...new Set(entries.map((e) => e.jsonPayload?.workerEvent).filter(Boolean))];
  check(4, "worker transport events present", workerEvents.length > 0, workerEvents.join(", ") || "none seen");
  check(4, "no subscriber closed without recovering", !entries.some((e) => e.jsonPayload?.workerEvent === "close-giving-up"), "");
}

// ── verdict ──────────────────────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? "SMOKE FAILED" : "SMOKE PASSED"} — ${results.length - failed.length}/${results.length} checks`);
if (failed.length) {
  failed.forEach((f) => console.log(`  - [phase ${f.phase}] ${f.name}`));
  console.log("\nRollback: npm run rollback -- --only=run   (orchestrator)   |   -- --only=mig   (workers)");
  process.exit(1);
}
console.log(`Watch continuing behaviour: filter jsonPayload.capacityEvent!="" OR jsonPayload.workerEvent!="" in the log viewer.`);
