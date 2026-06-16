// action:"start" — launch a plan (published to `orchestrate` by /ai/plan).
//
// Builds the planner's USER message and launches the planner agent. The agent's SYSTEM
// prompt (PLANNER_PROMPT) is supplied by the worker via systemPromptFor("planner") — so the
// orchestrator needs no Mongo, and the big system prompt never rides in a Pub/Sub message.
// Only the small user block (request + option lists + the told model) is sent as `query`.
//
// The user's prompt arrives verbatim in the message and could be large; Pub/Sub base64-
// encodes the JSON (binary-safe), so we never corrupt it — we just keep the payload lean
// (no assembled system prompt in it).
//
// `report: "build"` → when the planner finishes, the worker publishes back to `orchestrate`
// (action:build), which triggers dispatch/build.js to freeze the steps. Then we STUB (pause) —
// no step execution yet.
//
// `message` (last arg) is the full Pub/Sub message object.
import { PubSub } from "@google-cloud/pubsub";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { dispatchStep } from "./dispatch.js";

let _pubsub;
function pubsub() {
  if (!_pubsub) _pubsub = new PubSub({ projectId: process.env.GCP_PROJECT_ID });
  return _pubsub;
}

export async function handle(payload, _message) {
  const { jobId, userId, companyId, userPrompt, model } = payload;
  const db = getFirestore();

  // A pre-composed plan (e.g. /ai/menu wrote plan[] to the doc before publishing start) needs no
  // planner — running an existing plan is just dispatchStep(0). Branch BEFORE the set() below so we
  // don't clobber the plan the doc already carries.
  const jobRefExisting = db.collection("llmResults").doc(jobId);
  const existing = (await jobRefExisting.get()).data()?.plan;
  if (Array.isArray(existing) && existing.length) {
    console.log(`[ai/start] jobId=${jobId} ✓ plan already present (${existing.length} step(s)) → dispatch step 0 (no planner)`);
    await dispatchStep(jobId, 0);
    return;
  }

  // The job doc = the REQUEST container + plan metadata. `message` is the original request.
  // No response lives here; every LLM run (the planner and each step) is a run doc under
  // steps/, keyed by its Pub/Sub message id. The worker creates the run doc on receipt.
  const jobRef = db.collection("llmResults").doc(jobId);
  await jobRef.set({
    jobId, userId, companyId, message: userPrompt, userPrompt, model, type: "plan",
    status: "pending", createdAt: FieldValue.serverTimestamp(),
  });

  // The WORKER builds the planner prompt by message type and streams its run into
  // steps/{pubsubMsgId} with step:"plan". `report:"build"` → it pings orchestrate (action:build)
  // when done, carrying the run id so build.js can read the plan back.
  try {
    await pubsub().topic(model).publishMessage({
      json: { jobId, type: "planner", step: "plan", query: userPrompt, model, userId, companyId, report: "build" },
    });
  } catch (err) {
    // gRPC code 5 = NOT_FOUND → the model topic doesn't exist (bad/stale `model`, or
    // pub/sub not provisioned for it). This is TERMINAL: retrying can't make the topic
    // appear, so fail the job cleanly and RETURN (no throw) — events.js then acks the
    // message instead of redelivering it forever (a poison-message loop).
    if (err?.code === 5) {
      const error = `model topic "${model}" not found — is it provisioned for this env? (re-run pub/sub setup or restart dev; check the model is in config/models.js)`;
      console.error(`[ai/start] jobId=${jobId} ✗ ${error}`);
      await jobRef.set({ status: "fail", outcome: error }, { merge: true });
      return;
    }
    throw err; // other errors may be transient → let Pub/Sub retry
  }
  console.log(`[ai/start] jobId=${jobId} → published planner (step:plan) to topic="${model}", report=build`);
}
