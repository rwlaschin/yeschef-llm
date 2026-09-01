import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyBuildComplete } from "./notify.js";
import { advance } from "./step.js";

const PLAN_ID = "507f1f77bcf86cd799439011";
const ENTITY_ID = "507f191e810c19729de860ea";

// Mongo + Firestore stand-ins. `written` collects the notification docs that actually landed.
function fakeDeps(planDoc = { userId: ENTITY_ID }) {
  const written = [];
  return {
    written,
    plans: { async findOne() { return planDoc; } },
    db: {
      collection: () => ({
        doc: (entityId) => ({
          collection: () => ({ async add(doc) { written.push({ entityId, ...doc }); } }),
        }),
      }),
    },
  };
}

test("a terminal menu build notifies the plan's creator", async () => {
  const d = fakeDeps();
  assert.equal(await notifyBuildComplete({ type: "menu", planId: PLAN_ID }, true, d), true);
  assert.equal(d.written.length, 1);
  assert.equal(d.written[0].entityId, ENTITY_ID, "goes to the creating entity, not the launcher");
  assert.equal(d.written[0].type, "step_ready");
  assert.deepEqual(d.written[0].anchor, { type: "step", planId: PLAN_ID, stepId: "recipes", label: "Recipes" });
  assert.ok(d.written[0].text.length, "carries one of the rotating messages");
});

test("a failed build still notifies, and says so", async () => {
  const d = fakeDeps();
  await notifyBuildComplete({ type: "menu", planId: PLAN_ID }, false, d);
  assert.equal(d.written[0].type, "step_failed");
});

test("non-menu jobs, and plans with no creator on file, notify nobody", async () => {
  for (const job of [{ type: "tquery", planId: PLAN_ID }, { type: "menu" }, { type: "menu", planId: "not-an-objectid" }]) {
    const d = fakeDeps();
    assert.equal(await notifyBuildComplete(job, true, d), false, JSON.stringify(job));
    assert.equal(d.written.length, 0);
  }
  const orphan = fakeDeps({});                    // plan exists, but carries no userId
  assert.equal(await notifyBuildComplete({ type: "menu", planId: PLAN_ID }, true, orphan), false);
  assert.equal(orphan.written.length, 0, "no notification beats the wrong one");
});

// The single-shot guard is the cursor claim in advance(); the notify must inherit it.
test("finalize notifies exactly once — a duplicate terminal report does not re-notify", async () => {
  let doc = { cursor: 0, type: "menu", planId: PLAN_ID, failedSteps: [] };
  const db = {
    async runTransaction(fn) {
      return fn({
        async get() { return { data: () => ({ ...doc }) }; },
        set(_ref, patch) { doc = { ...doc, ...patch }; },
      });
    },
  };
  const calls = [];
  const notify = async (job, ok) => { calls.push({ planId: job.planId, ok }); return true; };

  await advance(db, {}, "job1", 0, 1, "success", false, notify);
  await advance(db, {}, "job1", 0, 1, "success", false, notify);
  assert.deepEqual(calls, [{ planId: PLAN_ID, ok: true }]);
});

test("a notification failure never fails the finalize", async () => {
  let doc = { cursor: 0, type: "menu", planId: PLAN_ID, failedSteps: [] };
  const db = {
    async runTransaction(fn) {
      return fn({
        async get() { return { data: () => ({ ...doc }) }; },
        set(_ref, patch) { doc = { ...doc, ...patch }; },
      });
    },
  };
  await advance(db, {}, "job1", 0, 1, "success", false, async () => { throw new Error("firestore down"); });
  assert.equal(doc.status, "success", "the terminal status still landed");
});
