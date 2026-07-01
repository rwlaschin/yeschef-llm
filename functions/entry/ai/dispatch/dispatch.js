// Step dispatch — the orchestrator calling a step's LLM. Shared by build.js (dispatch step 0
// after the plan is parsed) and /ai/resume (re-run a step of an existing job).
//
// The step's DEFINITION lives in the job's `plan[]` metadata (plan[step]); we never store
// definitions in the run docs. The work message is tiny — {jobId, step, type, model} — and
// carries NO prompt: the worker reads plan[step] + prior results and builds it. Pub/Sub
// assigns the message its id on publish; the worker uses THAT as the run doc id
// (steps/{pubsubMsgId}). `report:"step"` → the worker pings orchestrate (action:step) when done.
import { PubSub } from "@google-cloud/pubsub";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { renderUnit } from "../compose.js";
import { FAKE_TOPIC } from "../../../config/models.js";

let _pubsub;
function pubsub() {
  if (!_pubsub) _pubsub = new PubSub({ projectId: process.env.GCP_PROJECT_ID });
  return _pubsub;
}

// Clean a step's prior RUNS before a (re)run. Mode is an ENV flag:
//   ORCHESTRATOR_SOFT_DELETE !== "false" → SOFT (default): mark isDeleted:true, keep for tracing.
//   ORCHESTRATOR_SOFT_DELETE === "false" → HARD: remove the run docs.
const SOFT_DELETE = process.env.ORCHESTRATOR_SOFT_DELETE !== "false";
async function cleanupPriorRuns(db, jobRef, step, keepUnits = 0) {
  const runs = await jobRef.collection("steps").where("step", "==", step).get();
  if (runs.empty) return;
  const batch = db.batch();
  let n = 0;
  for (const d of runs.docs) {
    // The run-doc id is `${step}-${unit}` (zero-padded). A slot this dispatch will REUSE
    // (unit < keepUnits) is left untouched, so re-dispatching a step never blows away its prior
    // response — a failed step keeps its result visible whether we retry it or fall through past
    // it; the worker overwrites the slot when the new attempt produces output. Only genuinely
    // stale slots (unit >= keepUnits, e.g. left over from a larger prior fanout) are cleaned.
    const unit = Number(String(d.id).split("-")[1]);
    if (Number.isInteger(unit) && unit < keepUnits) continue;
    if (SOFT_DELETE) {
      if (d.data().isDeleted === true) continue; // already inactive
      batch.set(d.ref, { isDeleted: true, deletedAt: FieldValue.serverTimestamp() }, { merge: true });
    } else {
      batch.delete(d.ref);
    }
    n++;
  }
  if (!n) return;
  await batch.commit();
  console.log(`[ai/dispatch] jobId=${jobRef.id} step=${step} ${SOFT_DELETE ? "soft" : "hard"}-deleted ${n} stale run(s) (kept ${keepUnits} reused slot(s))`);
}

// Dispatch one step (0-based index into the job's plan[]): clean its prior runs, move the
// cursor, and publish the work message. The worker creates steps/{pubsubMsgId}.
//
// opts:
//   report       — "step" (default) makes the worker ping the orchestrator on completion, driving
//                  the auto-flow. Pass null for a DEBUG/isolated run: the worker writes the result
//                  but never pings, so step.js is not engaged and nothing cascades.
//   attempt — retry number (0 first dispatch, +1 per retry). Carried in the message AND stored on
//             the run slot: the worker uses it to tell a real retry (re-run the slot) from a stale
//             duplicate delivery of an attempt already finished. See worker/admission.js.
//   query   — an orchestrator-AUTHORED directive for this run, carried in the message's existing
//             `query` (user-prompt) field. When set the worker uses it instead of plan[step]. Used
//             on retries to fold in the prior failure. Opaque to the worker — it just renders what
//             it's handed and knows nothing about retries.
export async function dispatchStep(jobId, step, opts = {}) {
  const { report = "step", attempt = 0, query = null } = opts;
  const db = getFirestore();
  const jobRef = db.collection("llmResults").doc(jobId);
  const jobSnap = await jobRef.get();
  const job = jobSnap.exists ? jobSnap.data() : {};
  const plan = job.plan || [];
  // A fake job dispatches to the canned topic instead of the step's real model — the worker
  // returns canned output (no Ollama) via the same write path. Everything else is identical.
  const fake = job.fake === true;
  const def = plan[step];
  if (!def) {
    console.error(`[ai/dispatch] jobId=${jobId} step=${step} — no plan[${step}] entry; cannot dispatch`);
    return;
  }
  if (!def.model) {
    console.error(`[ai/dispatch] jobId=${jobId} step=${step} — plan[${step}] has no model topic; cannot dispatch`);
    return;
  }

  // How many parallel units this step launches (branch on KIND). Computed BEFORE cleanup so we can
  // keep the slots we're about to reuse (and only clear stale ones) — re-dispatching must not
  // delete the step's prior response.
  const count = unitCount(def);
  await cleanupPriorRuns(db, jobRef, step, count);
  await jobRef.set({ cursor: step, status: "running" }, { merge: true });

  // Each publish is its own Pub/Sub message → its own run doc (steps/{unitDocId}); the worker
  // builds + writes each.
  const msgIds = [];
  try {
    for (let i = 0; i < count; i++) {
      // `unit: i` is the unit's index within this step's fanout. The WORKER turns (step, unit)
      // into the ordered, zero-padded run-doc id via config/models.js `unitDocId` — so the doc
      // id IS the order key and the UI can stream a window with a pure documentId() range.
      //
      // Fan-out JIT: render THIS unit's prompt (fills {{legal}}/{{item}}/… from the step's items)
      // and hand it to the worker via `query`, which it renders as-is. An orchestrator-authored
      // `query` (e.g. a retry directive) still wins over the per-unit render.
      const unitQuery = query != null ? query : (Array.isArray(def.items) ? renderUnit(def, i) : null);
      const id = await pubsub().topic(fake ? FAKE_TOPIC : def.model).publishMessage({
        json: { jobId, step, unit: i, attempt, type: "step", model: def.model, subtype: def.subtype, tools: def.tools || [], ...(fake ? { fake: true, item: Array.isArray(def.items) ? def.items[i] : null, ctx: { days: def.renderCtx?.days, meals: def.renderCtx?.meals } } : {}), ...(def.style ? { style: def.style } : {}), ...(report ? { report } : {}), ...(unitQuery != null ? { query: unitQuery } : {}) },
      });
      msgIds.push(id);
    }
  } catch (err) {
    // gRPC 5 = NOT_FOUND → the step's model topic doesn't exist. Terminal: mark the job error
    // and return (don't let build/resume throw → redeliver forever).
    if (err?.code === 5) {
      const error = `step ${step} model topic "${def.model}" not found — provisioned for this env?`;
      console.error(`[ai/dispatch] jobId=${jobId} ✗ ${error}`);
      await jobRef.set({ status: "fail", outcome: error }, { merge: true });
      return;
    }
    throw err; // other errors may be transient → let Pub/Sub retry
  }
  const tag = `${report ? "" : " (debug/no-report)"}${attempt ? ` retry#${attempt}` : ""}`;
  console.log(`[ai/dispatch] jobId=${jobId} step=${step} kind=${def.kind} subtype=${def.subtype} → ${count} unit(s) [0..${count - 1}] on "${fake ? FAKE_TOPIC : def.model}"${fake ? " (FAKE)" : ""}${tag} (pubsub msgIds: ${msgIds.join(",")})`);
}

// Branch on step kind → unit count. fanout/chain → items; chunks → groups; aggregation → 1 combine.
// EVERY unit is dispatched and must complete — there is NO cap here. Throttling how many run at once
// is a worker-side concurrency limit (see MAX_CONCURRENCY), not a reduction of the work.
// Exported so step.js can tell when ALL of a step's units have reported back.
export function unitCount(def) {
  switch (def.kind) {
    case "chunks":      return Math.max(1, Number(def.groups) || 1);
    case "aggregation": return 1;
    case "chain":       // inherits the source's fan-out (compose copies its items)
    case "fanout":
    default:            return Math.max(1, Array.isArray(def.items) ? def.items.length : 1);
  }
}
