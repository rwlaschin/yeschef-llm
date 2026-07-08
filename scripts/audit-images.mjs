// Stale-artifact audit — "is there junk hanging around?"
//   npm run images            report only
//   npm run images -- --prune report + delete what's found stale
// Reports, per Artifact Registry image: digest count vs the keep target (latest + newest N);
// stale instance templates (not referenced by any MIG); and leaked baker VMs. Prints a stale total.
// deploy.js calls this with --prune at the end of every deploy — safe by construction: it only
// ever deletes digests beyond keep-2 (never `latest` or the newest 2), templates NOT referenced by
// any live MIG, and baker VMs that outlived their own deploy run (a healthy bake always deletes its
// own baker on success or failure — see bakeGCEImage). Never touches anything currently in use.
import dotenvFlow from "dotenv-flow";
import { execSync } from "child_process";
dotenvFlow.config();

const PRUNE = process.argv.includes("--prune");
const PROJ = process.env.GCP_PROJECT_ID;
const REGION = process.env.GCP_REGION || "us-central1";
const REPO = `${REGION}-docker.pkg.dev/${PROJ}/ollama`;
const KEEP = 2; // latest + newest N builds are "in use"; anything past that is stale
const sh = (c) => execSync(c, { stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
const shOk = (c) => { try { sh(c); return true; } catch { return false; } };

let staleTotal = 0;
let staleBuilds = 0;
let prunedBuilds = 0;
let liveBuilds = 0; // digests currently kept (latest + newest N) — the ones actually in use

console.log(`\nRegistry images (keep ${KEEP} newest + latest)${PRUNE ? " — PRUNING" : ""}:`);
const pkgs = [...new Set(sh(`gcloud artifacts docker images list ${REPO} --format="value(package)"`).split("\n").filter(Boolean))].sort();
for (const p of pkgs) {
  const rows = JSON.parse(sh(`gcloud artifacts docker images list ${p} --include-tags --format=json`) || "[]");
  rows.sort((a, b) => String(b.createTime || "").localeCompare(String(a.createTime || "")));
  const keep = new Set();
  for (const r of rows) if ((r.tags || []).includes("latest")) keep.add(r.version);
  for (const r of rows.slice(0, KEEP)) keep.add(r.version);
  const stale = rows.filter((r) => !keep.has(r.version));
  staleTotal += stale.length; staleBuilds += stale.length;
  liveBuilds += keep.size;
  let pruned = 0;
  if (PRUNE) {
    for (const r of stale) {
      if (shOk(`gcloud artifacts docker images delete ${p}@${r.version} --project=${PROJ} --delete-tags --quiet`)) pruned++;
    }
    prunedBuilds += pruned;
  }
  console.log(`  ${p.split("/").pop().padEnd(34)} ${rows.length} digest(s)${stale.length ? `  ⚠ ${stale.length} stale${PRUNE ? ` (${pruned} pruned)` : ""}` : ""}`);
}

console.log(`\nInstance templates (stale = not referenced by any MIG)${PRUNE ? " — PRUNING" : ""}:`);
const used = new Set(sh(`gcloud compute instance-groups managed list --project=${PROJ} --format="value(instanceTemplate.basename())"`).split("\n").filter(Boolean));
const tmpls = sh(`gcloud compute instance-templates list --project=${PROJ} --format="value(name)"`).split("\n").filter(Boolean);
const staleTmpls = tmpls.filter((t) => !used.has(t));
staleTotal += staleTmpls.length;
let prunedTmpls = 0;
console.log(`  ${tmpls.length} total, ${used.size} in use, ${staleTmpls.length} stale`);
for (const t of staleTmpls) {
  const ok = PRUNE ? shOk(`gcloud compute instance-templates delete ${t} --project=${PROJ} --quiet`) : null;
  if (ok) prunedTmpls++;
  console.log(`    ⚠ ${t}${PRUNE ? (ok ? "  (pruned)" : "  (prune failed — still referenced?)") : ""}`);
}

console.log(`\nLeaked baker VMs (a bake VM should never outlive its deploy)${PRUNE ? " — PRUNING" : ""}:`);
const bakerRows = sh(`gcloud compute instances list --project=${PROJ} --filter="name~-baker-" --format="value(name,zone.basename())"`).split("\n").filter(Boolean);
staleTotal += bakerRows.length;
let prunedBakers = 0;
if (bakerRows.length) {
  for (const row of bakerRows) {
    const [name, zone] = row.split("\t");
    const ok = PRUNE ? shOk(`gcloud compute instances delete ${name} --zone=${zone} --project=${PROJ} --quiet`) : null;
    if (ok) prunedBakers++;
    console.log(`    ⚠ ${name}${PRUNE ? (ok ? "  (pruned)" : "  (prune failed)") : ""}`);
  }
} else {
  console.log("  none");
}

const prunedTotal = prunedBuilds + prunedTmpls + prunedBakers;
console.log(`\n${staleTotal === 0 ? "✓ CLEAN — no stale artifacts found." : PRUNE ? `⚠ STALE: ${staleTotal} found, ${prunedTotal} pruned.` : `⚠ STALE: ${staleTotal} item(s) worth pruning.`}\n`);

// Live counterpart to the stale count — what's actually in service right now.
const runningWorkers = sh(`gcloud compute instances list --project=${PROJ} --filter="name~-mig-" --format="value(name)"`).split("\n").filter(Boolean).length;
console.log(`Live right now: ${liveBuilds} image(s) kept, ${used.size} template(s) in use, ${runningWorkers} worker VM(s) running.\n`);

// Publish the counts as a custom gauge metric so the dashboard scorecard updates whenever this
// runs. After a prune, this reflects what's LEFT (should be ~0), not what was found.
try {
  const token = sh(`gcloud auth print-access-token`);
  const now = new Date().toISOString();
  const series = (kind, val) => ({
    metric: { type: "custom.googleapis.com/registry/stale_artifacts", labels: { kind } },
    resource: { type: "global", labels: { project_id: PROJ } },
    points: [{ interval: { endTime: now }, value: { int64Value: String(val) } }],
  });
  const body = JSON.stringify({ timeSeries: [
    series("builds", staleBuilds - prunedBuilds),
    series("templates", staleTmpls.length - prunedTmpls),
    series("bakers", bakerRows.length - prunedBakers),
  ] }).replace(/'/g, "'\\''");
  sh(`curl -sf -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" ` +
     `"https://monitoring.googleapis.com/v3/projects/${PROJ}/timeSeries" -d '${body}'`);
  console.log("gauge metric updated: custom.googleapis.com/registry/stale_artifacts (builds/templates/bakers)\n");

  const liveSeries = (kind, val) => ({
    metric: { type: "custom.googleapis.com/registry/live_artifacts", labels: { kind } },
    resource: { type: "global", labels: { project_id: PROJ } },
    points: [{ interval: { endTime: now }, value: { int64Value: String(val) } }],
  });
  const liveBody = JSON.stringify({ timeSeries: [
    liveSeries("builds", liveBuilds), liveSeries("templates", used.size), liveSeries("workers", runningWorkers),
  ] }).replace(/'/g, "'\\''");
  sh(`curl -sf -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" ` +
     `"https://monitoring.googleapis.com/v3/projects/${PROJ}/timeSeries" -d '${liveBody}'`);
  console.log("gauge metric updated: custom.googleapis.com/registry/live_artifacts (builds/templates/workers)\n");
} catch (e) {
  console.warn(`metric write skipped: ${String(e.message).slice(0, 100)}\n`);
}
