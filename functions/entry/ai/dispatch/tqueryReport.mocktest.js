// Why does a finished tquery job ever sit at status:"pending"?
//
// Three test jobs were stranded there. The claim under test: the REAL path cannot produce that,
// because dispatchStep defaults `report` to "step" (dispatch.js:158) and every caller in
// functions/ takes that default — start.js:38, build.js:37, resume.js:92/148, step.js:123/157.
// `report` is what makes the worker ping /ai/events, which is what engages step.js/finalize.js.
// Without it nothing advances and the job never leaves pending. So these two tests together are
// the verdict: (1) the real dispatch DOES carry report:"step", and (2) once the reports arrive the
// rollup drives the job terminal.
//
// Needs --experimental-test-module-mocks → `npm run test:orchestrator`, not the `npm test` glob.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const published = [];
const store = { job: null, steps: new Map() };

const stepDocs = () => [...store.steps.entries()].map(([id, data]) => ({ id, ref: { id }, data: () => data }));

mock.module("firebase-admin/firestore", {
  namedExports: {
    FieldValue: { serverTimestamp: () => "TS" },
    getFirestore: () => ({
      batch: () => ({ set() {}, delete() {}, commit: async () => {} }),
      collection: () => ({
        doc: (id) => ({
          id,
          get: async () => ({ exists: !!store.job, data: () => store.job }),
          set: async (patch) => { store.job = { ...store.job, ...patch }; },
          collection: () => ({
            get: async () => ({ docs: stepDocs(), empty: store.steps.size === 0 }),
            where: (_f, _o, v) => ({
              get: async () => {
                const docs = stepDocs().filter((d) => d.data().step === v);
                return { docs, empty: docs.length === 0 };
              },
            }),
          }),
        }),
      }),
    }),
  },
});
mock.module("@google-cloud/pubsub", {
  namedExports: {
    PubSub: class {
      topic(t) { return { publishMessage: async ({ json }) => { published.push([t, json]); return `mid-${published.length}`; } }; }
    },
  },
});

async function wrappedJob() {
  const { composeJob } = await import("../tquery.js");
  const out = composeJob({ tasks: [{ subtype: "task", query: "list tomorrow's prep" }] }, { uid: "u-1", companyId: "c-1" });
  assert.equal(out.error, undefined, `composeJob rejected its own valid input: ${out.error}`);
  return out.doc;
}

test("the REAL dispatch of a tquery step carries report:\"step\" — the worker WILL ping the orchestrator", async () => {
  store.job = { ...(await wrappedJob()), jobId: "job-1" };
  store.steps.clear();
  published.length = 0;

  const { dispatchStep } = await import("./dispatch.js");
  await dispatchStep("job-1", 0);

  assert.equal(published.length, 1, `expected 1 work message, got ${JSON.stringify(published)}`);
  const [, msg] = published[0];
  // THE bug's root: no `report` ⇒ no ping ⇒ step.js and finalize.js never fire ⇒ pending forever.
  assert.equal(msg.report, "step", "the work message carries no report — the job would strand at pending");
  assert.equal(msg.step, 0);
  assert.equal(msg.subtype, "pre-sanitize");
  assert.equal(store.job.status, "running");
  assert.equal(store.job.cursor, 0);
});

test("a tquery job whose steps all report ends TERMINAL (success), never stranded at pending", async () => {
  const doc = await wrappedJob();
  store.job = { ...doc, jobId: "job-2", status: "pending", cursor: doc.stepCount - 1 };
  store.steps.clear();
  // Every step of the sandwich reported success — pre-sanitize, the task, post-sanitize.
  for (let i = 0; i < doc.stepCount; i++) {
    store.steps.set(`${i}-000`, { step: i, unit: 0, status: "success", response: `out ${i}` });
  }
  published.length = 0;

  const { handle } = await import("./finalize.js");
  await handle({ jobId: "job-2" });

  assert.equal(store.job.status, "success", `rollup left the job at "${store.job.status}"`);
  assert.equal(store.job.outcome, null);
  assert.notEqual(store.job.status, "pending");
  assert.equal(published.length, 0, "finalize must never dispatch — it only rolls the status up");
});

test("the rollup reports fail when any step of the sandwich failed", async () => {
  const doc = await wrappedJob();
  store.job = { ...doc, jobId: "job-3", status: "pending" };
  store.steps.clear();
  for (let i = 0; i < doc.stepCount; i++) {
    store.steps.set(`${i}-000`, { step: i, unit: 0, status: i === doc.stepCount - 1 ? "fail" : "success", response: "" });
  }
  await (await import("./finalize.js")).handle({ jobId: "job-3" });
  assert.equal(store.job.status, "fail");
  assert.match(store.job.outcome, /one or more steps failed/);
});
