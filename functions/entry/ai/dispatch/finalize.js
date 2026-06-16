// action:"finalize" — the DEBUG run (/ai/run) reports here when a unit completes. Debug runs are
// deliberately OUTSIDE the orchestrator cascade (no advance, no dispatch — see step.js), but the
// JOB doc must still end TERMINAL so every view reads a true status. This rolls the job-doc status
// up from the step runs and writes ONLY that — it never advances or dispatches.
//
// Rollup (the single server-side source of truth for a job's overall status):
//   • any step's unit still running/pending     → running
//   • every plan step has terminal run(s)        → success (or fail if any step ended fail)
//   • idle, but not every step has run            → paused (e.g. a debug ▷ cleared the tail steps)
//
// Idempotent: fan-out units each ping; the rollup just reflects current state, last write wins.
import { getFirestore, FieldValue } from "firebase-admin/firestore";

export async function handle(payload, _message) {
  const { jobId } = payload;
  const db = getFirestore();
  const jobRef = db.collection("llmResults").doc(jobId);
  const snap = await jobRef.get();
  if (!snap.exists) { console.warn(`[ai/finalize] job ${jobId} not found — ignoring`); return; }

  const job = snap.data();
  const plan = Array.isArray(job.plan) ? job.plan : [];
  const stepCount = job.stepCount || plan.length;
  if (!stepCount) { console.log(`[ai/finalize] job ${jobId} has no steps — nothing to roll up`); return; }

  const runs = (await jobRef.collection("steps").get())
    .docs.map((d) => d.data())
    .filter((r) => typeof r.step === "number" && !r.isDeleted);

  let anyRunning = false, anyFailed = false, doneSteps = 0;
  for (let i = 0; i < stepCount; i++) {
    const stepRuns = runs.filter((r) => r.step === i);
    if (!stepRuns.length) continue;
    if (!stepRuns.every((r) => r.status === "success" || r.status === "fail")) { anyRunning = true; continue; }
    doneSteps++;
    if (stepRuns.some((r) => r.status === "fail" || r.outcome)) anyFailed = true;
  }

  let status, outcome = null;
  if (anyRunning) status = "running";
  else if (doneSteps >= stepCount) { status = anyFailed ? "fail" : "success"; outcome = anyFailed ? "one or more steps failed" : null; }
  else status = "paused"; // idle, tail unrun

  await jobRef.set({ status, outcome, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  console.log(`[ai/finalize] jobId=${jobId} → ${status} (${doneSteps}/${stepCount} steps terminal${anyFailed ? ", some failed" : ""})`);
}
