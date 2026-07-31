// POST /ai/events — push endpoint for the `orchestrate` topic.
//
// Planner and agents report here. We decode the Pub/Sub push envelope, then route by the
// message's `action` (start | build | step) through a LOOKUP TABLE of lazily-imported handlers
// — so a given event only loads the one handler it needs.
//
// NOTE: `action` is the orchestrate-message verb. Don't confuse it with a step's `kind`
// (fanout | chunks | aggregation) — that's the step's shape, a different concept.
//
// Each handler is called as handle(payload, message): the last argument is the
// full message object (JS convention — like the array in a forEach callback).
import { lazy } from "../../lib/lazy.js";

// action → handler.
const HANDLERS = {
  start: lazy(() => import("./dispatch/start.js"), "handle"), // /ai/plan asked to launch → start the planner
  build: lazy(() => import("./dispatch/build.js"), "handle"), // planner finished → build the step plan
  step: lazy(() => import("./dispatch/step.js"), "handle"),   // a step agent finished → process/advance
  finalize: lazy(() => import("./dispatch/finalize.js"), "handle"), // debug run finished → roll job status up (no advance)
  outcome: lazy(() => import("./capacity/controller.js"), "handleOutcomeEvent"), // worker job DONE → capacity record (ok) + re-decide
};

export async function post(req, reply) {
  const message = req.body?.message ?? {};
  const payload = message.data
    ? JSON.parse(Buffer.from(message.data, "base64").toString("utf8"))
    : {};
  const action = payload.action ?? message.attributes?.action;
  console.log(`[ai/events] ← action=${action} jobId=${payload.jobId ?? "?"}`);

  const handler = HANDLERS[action];
  if (!handler) {
    // Ack unknown actions (2xx) so Pub/Sub doesn't redeliver forever.
    console.warn(`[ai/events] no handler for action=${action} — acking & dropping (jobId=${payload.jobId ?? "?"})`);
    return reply.code(204).send();
  }

  try {
    await handler(payload, message);
    console.log(`[ai/events] ✓ handled action=${action} jobId=${payload.jobId ?? "?"}`);
  } catch (err) {
    console.error(`[ai/events] ✗ handler threw for action=${action} jobId=${payload.jobId ?? "?"}: ${err?.message}`);
    throw err;
  }
  return reply.code(204).send(); // 2xx = ack
}
