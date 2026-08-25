// Does the ORCHESTRATOR accept a tquery-composed task list?
//
// The orchestrator is driven by Pub/Sub, not HTTP: events.js routes on the message's `action`
// through a handler table, and /ai/tquery's only job is to write the doc and publish
// {action:"start", jobId}. So the contract boundary under test here is that MESSAGE — no Fastify,
// no deploy, no emulator. This calls the real dispatch/start.js handle() against a doc produced by
// the real composeJob() and asserts the orchestrator dispatches step 0 without running the planner.
//
// Not in the `npm test` glob (*.test.js) on purpose: it needs --experimental-test-module-mocks to
// stub firebase-admin/firestore. Run it with `npm run test:orchestrator`. Same reasoning as
// worker/recipeLint.mjs being deliberately not a *.test.js.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// A tquery job doc, built by the real composer so this test tracks it rather than restating it.
async function tqueryDoc() {
  const { composeJob } = await import("../tquery.js");
  const out = composeJob(
    { tasks: [{ subtype: "analytics_widget", query: "how is take rate trending by site?" }] },
    { uid: "u-1", companyId: "c-1" },
  );
  assert.equal(out.error, undefined, `composeJob rejected its own valid input: ${out.error}`);
  return out.doc;
}

test("start.handle dispatches step 0 from a tquery task list and never runs the planner", async () => {
  const doc = await tqueryDoc();
  const dispatched = [];
  const published = [];
  const written = [];

  mock.module("firebase-admin/firestore", {
    namedExports: {
      FieldValue: { serverTimestamp: () => "TS" },
      getFirestore: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => ({ exists: true, data: () => doc }),
            set: async (v) => { written.push(v); },
            update: async (v) => { written.push(v); },
          }),
        }),
      }),
    },
  });
  mock.module("./dispatch.js", {
    namedExports: {
      dispatchStep: async (jobId, step) => { dispatched.push([jobId, step]); },
      unitCount: () => 1,
    },
  });
  mock.module("@google-cloud/pubsub", {
    namedExports: {
      PubSub: class { topic(t) { return { publishMessage: async ({ json }) => { published.push([t, json]); return "mid"; } }; } },
    },
  });

  const { handle } = await import("./start.js");
  await handle({ action: "start", jobId: "job-1", userId: "u-1", companyId: "c-1" });

  // The whole point: a pre-composed list short-circuits the planner (start.js:31-40).
  assert.deepEqual(dispatched, [["job-1", 0]], "step 0 was not dispatched");
  assert.equal(
    published.length, 0,
    `the planner was launched — start.js published ${JSON.stringify(published)}`,
  );
  // start.js must not clobber the task list on its way through.
  for (const w of written) {
    assert.ok(!("plan" in w) || w.plan === doc.plan, "start.handle overwrote the composed task list");
  }
});

test("the composed step shape carries every field the walker reads", async () => {
  const doc = await tqueryDoc();
  // The sandwich: pre-sanitize, the caller's task, post-sanitize.
  assert.deepEqual(doc.plan.map((s) => s.subtype), ["pre-sanitize", "analytics_widget", "post-sanitize"]);
  const step = doc.plan[1];
  // Read off dispatch/step.js and dispatch/dispatch.js: the walker keys on these. A missing one
  // fails at runtime in production, where the job just stalls.
  for (const k of ["instructions", "model", "subtype", "kind", "tools", "style", "contexts", "includeInResults", "failStep", "successStep"]) {
    assert.ok(k in step, `composed step is missing "${k}", which the walker reads`);
  }
  assert.equal(doc.cursor, 0, "cursor must start at 0 or step.js treats the first report as stale");
  assert.equal(doc.stepCount, doc.plan.length);
  assert.equal(doc.type, "tquery", "a task list must never be readable as a meal_plan build");
});
