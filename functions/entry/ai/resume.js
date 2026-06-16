// POST /ai/resume/* — (re)run an EXISTING plan without re-running the planner.
//
// The plan DEFINITIONS live on the job doc (`plan[]`); results are disposable run docs under
// steps/. These endpoints HARD-delete the right RANGE of run docs, then either dispatch a step
// or publish the step's "finish" so the orchestrator advances. All server-side — the client
// NEVER deletes. `jobId` comes in the body so each call targets the right job.
//
//   POST /ai/resume/plan   { jobId }  → wipe all step runs (KEEP the planner run), run step 0
//   POST /ai/resume/:step  { jobId }  → wipe everything after N (>N), keep N, publish N's
//                                       "finish" to orchestrate (step.js does the transition)
//
// HARD delete (not soft): testing wants a clean slate, and the plan logic is safe in plan[].
// The planner run (step:"plan") is NEVER deleted — destroying it would defeat the purpose.
import { PubSub } from "@google-cloud/pubsub";
import { getFirestore } from "firebase-admin/firestore";
import { dispatchStep } from "./dispatch/dispatch.js";
import { buildPlanAndDispatch } from "./dispatch/build.js";

const ORCHESTRATE_TOPIC = process.env.ORCHESTRATE_TOPIC || "orchestrate";
let _pubsub;
function pubsub() {
  if (!_pubsub) _pubsub = new PubSub({ projectId: process.env.GCP_PROJECT_ID });
  return _pubsub;
}

const jobRefOf = (jobId) => getFirestore().collection("llmResults").doc(jobId);
// A run's `step` is "plan" (the planner run) or a number (an executable step's run).
// Exported so /ai/menu can wipe a job's step runs for an in-place rerun (reuse, not duplicate).
export const isStepRun = (s) => typeof s === "number";

// HARD-delete every run under steps/ for which shouldDelete(step) is true. Returns the count.
export async function hardDeleteRuns(jobRef, shouldDelete) {
  const snap = await jobRef.collection("steps").get();
  const victims = snap.docs.filter((d) => shouldDelete(d.data().step));
  if (!victims.length) return 0;
  const db = getFirestore();
  for (let i = 0; i < victims.length; i += 450) {       // Firestore batch cap is 500
    const batch = db.batch();
    for (const d of victims.slice(i, i + 450)) batch.delete(d.ref);
    await batch.commit();
  }
  return victims.length;
}

function parseStep(req, reply) {
  const step = Number(req.params?.step);
  if (!Number.isInteger(step) || step < 0) {
    reply.code(400).send({ error: "valid step index required" });
    return null;
  }
  return step;
}

// POST /ai/rebuild — replay BUILD from the EXISTING planner output (NO planner re-run). Parses
// the plan YAML the planner already produced — the active step:"plan" run, or a legacy top-doc
// `response` — into plan[], then dispatches step 0. Lets you test build→step without paying for
// the slow planner again.
export async function rebuild(req, reply) {
  const { jobId } = req.body || {};
  if (!jobId) return reply.code(400).send({ error: "jobId required" });
  const jobRef = jobRefOf(jobId);

  // The planner output lives in the planner run (steps/ with step:"plan"). No fallback to a
  // top-doc `response` — that's a legacy shape new code never writes, and falling back to it
  // would rebuild from stale/wrong data instead of failing loudly when the planner run is
  // missing. Require the run; if it's absent, that's the error worth seeing.
  const planRuns = await jobRef.collection("steps").where("step", "==", "plan").get();
  const planRun = planRuns.docs.find((d) => !d.data().isDeleted) || planRuns.docs[0];
  const raw = planRun?.data()?.response;
  if (!raw) return reply.code(400).send({ error: "no planner run to rebuild from (steps/ has no step:\"plan\" doc with a response)" });

  await hardDeleteRuns(jobRef, isStepRun); // clear any prior step runs first
  const res = await buildPlanAndDispatch(jobRef, raw);
  if (!res.ok) {
    console.error(`[ai/rebuild] jobId=${jobId} ✗ ${res.error}\n  raw preview: ${JSON.stringify(String(raw).slice(0, 300))}`);
    return reply.code(422).send({ error: res.error });
  }
  console.log(`[ai/rebuild] jobId=${jobId} → parsed ${res.count} step(s), dispatched step 0 (no planner re-run)`);
  return reply.send({ ok: true, jobId, steps: res.count });
}

// POST /ai/resume/plan — wipe ALL executable-step runs (keep the planner run), dispatch step 0.
export async function plan(req, reply) {
  const { jobId } = req.body || {};
  if (!jobId) return reply.code(400).send({ error: "jobId required" });
  const jobRef = jobRefOf(jobId);
  const deleted = await hardDeleteRuns(jobRef, isStepRun);
  // Clear the prior run's terminal state so the rerun starts clean. dispatchStep resets cursor/status;
  // these would otherwise linger and show stale fail/outcome until the new run overwrites them.
  await jobRef.set({ failedSteps: [], attempts: {}, outcome: null }, { merge: true });
  console.log(`[ai/resume/plan] jobId=${jobId} hard-deleted ${deleted} step run(s) → dispatch step 0`);
  await dispatchStep(jobId, 0);
  return reply.send({ ok: true, jobId, action: "plan", deleted, dispatched: 0 });
}

// POST /ai/resume/:step — wipe everything AFTER N (>N), keep N, then publish N's "finish" to the
// orchestrate topic. We only LAUNCH the message; advancing/branching is step.js's job.
export async function next(req, reply) {
  const { jobId } = req.body || {};
  if (!jobId) return reply.code(400).send({ error: "jobId required" });
  const step = parseStep(req, reply);
  if (step === null) return;
  const jobRef = jobRefOf(jobId);
  const deleted = await hardDeleteRuns(jobRef, (s) => isStepRun(s) && s > step);
  // Point the cursor back at the step we're finishing. Usually it's already here (the frontier),
  // but if the operator clicked an EARLIER step we've just wiped everything after it — so this is
  // now the frontier again. step.js advances only when cursor === the finished step, so without
  // this a click on an earlier step would be ignored as stale.
  await jobRef.set({ cursor: step }, { merge: true });
  // The run we're declaring "finished" = step N's active run (so step.js can read it back).
  const runs = await jobRef.collection("steps").where("step", "==", step).get();
  const run = runs.docs.find((d) => !d.data().isDeleted) || runs.docs[0];
  const runId = run ? run.id : null;
  // manual:true marks this as the operator's explicit "run the next step" (the UI ▷), which
  // advances the cursor unconditionally — vs. a worker auto-report, which never auto-advances.
  await pubsub().topic(ORCHESTRATE_TOPIC).publishMessage({
    json: { action: "step", jobId, step, runId, status: "success", manual: true },
  });
  console.log(`[ai/resume/next] jobId=${jobId} step=${step} hard-deleted ${deleted} run(s) (>${step}) → published orchestrate finish for step ${step} (run=${runId})`);
  return reply.send({ ok: true, jobId, action: "next", step, deleted, finishedRun: runId });
}

// POST /ai/run/:step — RUN THE PLAN FROM STEP N THROUGH TO THE END. Re-running step N invalidates
// every later step, so wipe all runs >= N and reset the DOWNSTREAM cursor/fail/attempt state, then
// dispatch step N on the ORCHESTRATED path (report:"step", the default). The worker pings the
// orchestrator on completion and step.js drives N → N+1 → … → finalize — exactly like a fresh run
// from that point, including retry/pass-through on a failed step. NOT isolated: it runs to the end.
// (Used by the step ▶ "run the rest from here" button; the plan ▶ does the same from step 0 via rebuild.)
export async function run(req, reply) {
  const { jobId } = req.body || {};
  if (!jobId) return reply.code(400).send({ error: "jobId required" });
  const step = parseStep(req, reply);
  if (step === null) return;
  const jobRef = jobRefOf(jobId);
  const job = (await jobRef.get()).data() || {};
  // Wipe step N's OWN runs AND the now-stale downstream (>= N). Step N's slots MUST be cleared: a
  // re-run reuses the same `${step}-${unit}` slot ids, and the worker's idempotency guard SKIPS a
  // slot already terminal for this attempt — leaving them would make the re-run a silent no-op.
  const deleted = await hardDeleteRuns(jobRef, (s) => isStepRun(s) && s >= step);
  // Reset only the DOWNSTREAM bookkeeping (steps >= N) so the cascade starts clean and pass-through
  // retry counts reset; KEEP history for steps < N (they aren't being re-run). dispatchStep then sets
  // cursor=N + status=running, so step.js will advance from N.
  await jobRef.set({
    failedSteps: (job.failedSteps || []).filter((s) => s < step),
    attempts: Object.fromEntries(Object.entries(job.attempts || {}).filter(([k]) => Number(k) < step)),
    outcome: null,
  }, { merge: true });
  await dispatchStep(jobId, step); // report:"step" (default) → orchestrated cascade N → end
  console.log(`[ai/run] run-to-end jobId=${jobId} from step=${step} — wiped ${deleted} run(s) (>=${step}); cascading ${step} → end (report:step)`);
  return reply.send({ ok: true, jobId, action: "run", step, deletedDownstream: deleted, toEnd: true });
}
