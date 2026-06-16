// action:"step" — the ORCHESTRATOR auto-flow. Fires when a step's unit reports back (worker runs
// dispatched with report:"step"). This is production, unattended: it drives the plan end-to-end
// with NO human in the loop.
//
//   success      → advance to the next step (linear, step+1). No next → finalize the job.
//   fail         → retry, up to MAX_GEN times, by re-dispatching the step's failStep (a sane
//                  earlier step, else the step itself). The orchestrator AUTHORS the retry prompt —
//                  the target's instructions + a note on the prior failure — and carries it in the
//                  message's existing `query` (user-prompt) field; the worker just runs it, knowing
//                  nothing about retries.
//   after MAX_GEN → PASS THROUGH to the next step. An unattended run must not stall on a step it
//                  can't pass; the failed run stays visible, the plan keeps going.
//
// NOT this file's job: the DEBUG run (manually firing individual steps for testing). Those are
// dispatched WITHOUT report, so the worker never pings and step.js is never engaged — the two
// flows are intentionally separate and must not be combined.
//
// Fanout-safe + idempotent: many units report per step, and a retry can race a sibling, so every
// cursor/attempt transition is claimed in a transaction keyed on `cursor === step`.
//
// Note: the plan's `successStep` graph is currently unreliable (e.g. step 0 → 2), so advancement
// is LINEAR (step+1). `failStep` is honored only when it's a sane revert target (0..step).
import { getFirestore } from "firebase-admin/firestore";
import { dispatchStep, unitCount } from "./dispatch.js";

// Retries per step before giving up and passing through. Env-overridable; sane fallback.
const MAX_GEN = parseInt(process.env.MAX_GEN, 10) || 2;

export async function handle(payload, _message) {
  const { jobId, step, status, outcome } = payload;
  if (typeof step !== "number") {
    console.log(`[ai/step] ignoring non-step report job=${jobId} step=${JSON.stringify(step)}`);
    return;
  }

  const db = getFirestore();
  const jobRef = db.collection("llmResults").doc(jobId);
  const snap = await jobRef.get();
  if (!snap.exists) { console.warn(`[ai/step] job ${jobId} not found — ignoring`); return; }
  const job = snap.data();
  const plan = Array.isArray(job.plan) ? job.plan : [];
  const stepCount = job.stepCount || plan.length;
  const def = plan[step] || {};

  // Stale report for a step the flow already moved past.
  if (job.cursor !== step) {
    console.log(`[ai/step] stale report job=${jobId} step=${step} (cursor=${job.cursor}) — ignoring`);
    return;
  }

  // Act only once ALL of a (fanout) step's units are terminal.
  const expected = unitCount(def);
  const runs = (await jobRef.collection("steps").where("step", "==", step).get())
    .docs.map((d) => d.data()).filter((r) => !r.isDeleted);
  const terminal = runs.filter((r) => r.status === "success" || r.status === "fail");
  if (terminal.length < expected) {
    console.log(`[ai/step] job=${jobId} step=${step}: ${terminal.length}/${expected} units done — waiting.`);
    return;
  }

  const failedRun = terminal.find((r) => r.status === "fail");
  const stepFailed = !!failedRun || status === "fail";

  if (!stepFailed) {
    return advance(db, jobRef, jobId, step, stepCount, "success");
  }

  // FAILED. Retry up to MAX_GEN, else pass through.
  const attempts = Number(job.attempts?.[step]) || 0;
  const reason = failedRun?.outcome || outcome || "(no reason given)";
  if (attempts >= MAX_GEN) {
    console.log(`[ai/step] job=${jobId} step=${step} FAILED ${attempts}x (max ${MAX_GEN}) — marking fail, passing through. reason=${reason}`);
    return advance(db, jobRef, jobId, step, stepCount, "passthrough-after-fail", true);
  }

  // Claim the retry with a compare-and-set on the attempt count, so concurrent fail reports from
  // sibling units can't each fire a retry — only the one that sees the expected count proceeds.
  const claimed = await db.runTransaction(async (tx) => {
    const j = (await tx.get(jobRef)).data();
    if (!j || j.cursor !== step) return false;
    const cur = Number(j.attempts?.[step]) || 0;
    if (cur !== attempts) return false; // another report already bumped it
    tx.set(jobRef, { attempts: { ...(j.attempts || {}), [step]: cur + 1 }, status: "running" }, { merge: true });
    return true;
  });
  if (!claimed) {
    console.log(`[ai/step] retry for job=${jobId} step=${step} already claimed — skip.`);
    return;
  }
  // failStep is honored only as a SANE revert (0..step); otherwise re-run this step.
  const fs = def.failStep;
  const target = Number.isInteger(fs) && fs >= 0 && fs <= step ? fs : step;
  // The orchestrator AUTHORS the retry prompt (developit-style): the target step's own instructions
  // + a note on why the prior attempt was rejected and what it produced. It's carried in the
  // message's existing `query` (user-prompt) field; the worker just runs it, oblivious it's a retry.
  const baseInstr = plan[target]?.instructions || "";
  const failed = failedRun?.response || "";
  const snippet = failed.length > 1500 ? failed.slice(0, 1500) + "…[truncated]" : failed;
  const retryPrompt =
    `${baseInstr}\n\nNotes on possible failures: the previous attempt was REJECTED because: ${reason}. ` +
    `Address that specifically and produce a passing result.` +
    (snippet ? `\n\nThe rejected attempt produced:\n${snippet}` : "");
  console.log(`[ai/step] job=${jobId} step=${step} failed (attempt ${attempts + 1}/${MAX_GEN}) → retry via step ${target}. reason=${reason}`);
  await dispatchStep(jobId, target, { attempt: attempts + 1, query: retryPrompt });
}

// Advance to the next step (linear). No next → finalize the job. `failed` = this step exhausted its
// retries and is being passed through: it stays recorded in `failedSteps` so the job's TERMINAL
// status reflects it (a job that limped past a failed step ends `fail`, not a clean `success`) —
// the step says fail, the plan still falls through and runs the rest. Single-shot via cursor claim.
export async function advance(db, jobRef, jobId, step, stepCount, why, failed = false) {
  const next = step + 1;
  const result = await db.runTransaction(async (tx) => {
    const j = (await tx.get(jobRef)).data();
    if (!j || j.cursor !== step) return "stale";
    const failedSteps = failed ? [...new Set([...(j.failedSteps || []), step])] : (j.failedSteps || []);
    if (next >= stepCount) {
      const ok = failedSteps.length === 0;
      tx.set(jobRef, {
        // Claim the cursor PAST the last step too. On the last step the cursor would otherwise stay
        // on `step`, so a duplicate terminal report would pass the `cursor === step` guard and
        // re-finalize (re-writing status, re-logging "job FAIL"). Moving it to `next` makes finalize
        // single-shot via the same guard — the second report sees cursor !== step → "stale".
        cursor: next,
        status: ok ? "success" : "fail",
        outcome: ok ? null : `completed, but step(s) ${failedSteps.join(", ")} failed (passed through)`,
        failedSteps,
      }, { merge: true });
      return ok ? "done-success" : "done-fail";
    }
    tx.set(jobRef, { cursor: next, status: "running", outcome: null, failedSteps }, { merge: true });
    return "advance";
  });
  if (result === "stale") return console.log(`[ai/step] ${why}: job=${jobId} step=${step} already transitioned — skip.`);
  if (result === "done-success") return console.log(`[ai/step] ${why}: job=${jobId} step=${step} was last — job SUCCESS.`);
  if (result === "done-fail") return console.log(`[ai/step] ${why}: job=${jobId} step=${step} was last — job FAIL (some steps failed & passed through).`);
  console.log(`[ai/step] ${why}: job=${jobId} advancing step ${step} → ${next}.`);
  await dispatchStep(jobId, next);
}
