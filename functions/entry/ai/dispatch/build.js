// action:"build" — the planner finished.
//
// Reads the planner's run (steps/{runId}, from the report), parses its YAML into the plan
// array, and stores that array as METADATA on the job doc (`plan[]`) — the definitions, NOT
// exploded into result docs. Then dispatches step 0. (step.js stops after a step reports, so
// for now only step 0 runs unless you Continue.)
//
// `message` (last arg) is the full Pub/Sub message object.
import { getFirestore } from "firebase-admin/firestore";
import { parseYamlBlock } from "../../../config/yaml.js";
import { dispatchStep } from "./dispatch.js";

// Parse the planner's YAML → store plan[] on the job → dispatch step 0. Shared by `handle`
// (the live action:build path) and /ai/rebuild (replay from EXISTING output, no planner re-run).
// Returns { ok:true, count } or { ok:false, error } — the caller decides how to surface failure.
export async function buildPlanAndDispatch(jobRef, raw) {
  // Prefer the AUTHORITATIVE structured plan[] already on the job doc — menu jobs always have it
  // (composed deterministically), and a previously-built planner job does too. Re-parsing the
  // stored planner YAML is only the FALLBACK (a fresh planner build, before plan[] exists). This
  // makes a re-build robust even when the stored YAML text doesn't round-trip, and never re-parses
  // an artifact whose structured form we already trust.
  let plan = null;
  const jobSnap = await jobRef.get();
  if (jobSnap.exists && Array.isArray(jobSnap.data().plan) && jobSnap.data().plan.length) {
    plan = jobSnap.data().plan;
  } else {
    try {
      plan = parseYamlBlock(raw);
    } catch (e) {
      return { ok: false, error: `plan parse failed: ${e.message}` };
    }
  }
  if (!Array.isArray(plan) || plan.length === 0) {
    return { ok: false, error: "plan is not a non-empty YAML list (planner did not emit steps)" };
  }
  await jobRef.set({ plan, stepCount: plan.length, status: "running" }, { merge: true });
  await dispatchStep(jobRef.id, 0);
  return { ok: true, count: plan.length };
}

export async function handle(payload, _message) {
  const { jobId, runId } = payload; // runId = the planner run doc id (steps/{runId})
  const db = getFirestore();
  const jobRef = db.collection("llmResults").doc(jobId);
  const planRunRef = jobRef.collection("steps").doc(String(runId));

  const snap = await planRunRef.get();
  if (!snap.exists) {
    console.error(`[ai/build] jobId=${jobId} — no planner run doc steps/${runId}; nothing to build`);
    return;
  }
  const raw = snap.data().response || "";
  console.log(`[ai/build] jobId=${jobId} runId=${runId} responseLen=${raw.length} preview=${JSON.stringify(unfence(raw).slice(0, 200))}`);

  const res = await buildPlanAndDispatch(jobRef, raw);
  if (!res.ok) {
    console.error(`[ai/build] jobId=${jobId} ✗ ${res.error}\n  raw preview: ${JSON.stringify(unfence(raw).slice(0, 300))}`);
    // Mark BOTH the planner run and the job failed; the reason goes in `outcome` (shown in the UI).
    await Promise.all([
      planRunRef.set({ status: "fail", outcome: res.error }, { merge: true }),
      jobRef.set({ status: "fail", outcome: res.error }, { merge: true }),
    ]);
    return;
  }
  console.log(`[ai/build] jobId=${jobId} ✓ parsed ${res.count} step(s) into plan[]; status=running → dispatched step 0`);
}
