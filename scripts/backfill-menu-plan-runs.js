// scripts/backfill-menu-plan-runs.js — give EXISTING menu jobs the `step:"plan"` run doc that
// /ai/menu now writes, so their Plan panel renders (older menu jobs were composed before the fix
// and have no planner run). Additive only: writes llmResults/{id}/steps/plan from the doc's plan[];
// never touches the job doc or its numeric step runs. Skips jobs that already have a plan run.
//
//   node scripts/backfill-menu-plan-runs.js            # DRY RUN — list what would be written
//   node scripts/backfill-menu-plan-runs.js --write     # write the plan runs

import dotenvFlow from "dotenv-flow"; dotenvFlow.config({ node_env: "dev" });
import admin from "firebase-admin";
import { createRequire } from "module";
// `yaml` lives in functions/node_modules (not the repo root), same copy menu.js uses.
const { stringify: yamlStringify } = createRequire(new URL("../functions/package.json", import.meta.url))("yaml");

const WRITE = process.argv.includes("--write");
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT_ID });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

// SAME serialization as functions/entry/ai/menu.js planAsYaml.
function planAsYaml(plan) {
  const steps = (plan || []).map((s) => ({
    instructions: s.instructions, model: s.model, subtype: s.subtype, kind: s.kind,
    count: Array.isArray(s.items) ? s.items.length : (s.count ?? 1),
    contexts: s.contexts || [], tools: s.tools || [],
  }));
  return "Composed from the Plan Library (deterministic — no planner LLM run).\n\n```yaml\n" +
    yamlStringify(steps) + "```";
}

const snap = await db.collection("llmResults").where("type", "==", "menu").get();
console.log(`menu jobs: ${snap.size}`);
let need = 0, wrote = 0;
for (const d of snap.docs) {
  const planRun = await d.ref.collection("steps").where("step", "==", "plan").limit(1).get();
  if (!planRun.empty) { console.log(`  ⏭ ${d.id.slice(0,8)} already has a plan run`); continue; }
  const job = d.data();
  if (!Array.isArray(job.plan) || !job.plan.length) { console.log(`  ⚠ ${d.id.slice(0,8)} has no plan[] — skip`); continue; }
  need++;
  console.log(`  ${WRITE ? "✍ writing" : "→ would write"} plan run for ${d.id.slice(0,8)} (${job.plan.length} step(s))`);
  if (WRITE) {
    await d.ref.collection("steps").doc("plan").set({
      step: "plan", companyId: job.companyId ?? null, userId: job.userId ?? null,
      status: "success", outcome: null, isDeleted: false, deletedAt: null, leaseUntil: null,
      prompt: "", message: job.message || "", response: planAsYaml(job.plan),
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), completedAt: FieldValue.serverTimestamp(),
    });
    wrote++;
  }
}
console.log(WRITE ? `\n✓ wrote ${wrote} plan run(s).` : `\nDRY RUN — ${need} job(s) need a plan run. Re-run with --write.`);
process.exit();
