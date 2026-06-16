import { test } from "node:test";
import assert from "node:assert/strict";
import { advance } from "./step.js";

// In-memory stand-in for a Firestore doc + runTransaction. tx.get returns the current doc; tx.set
// merges (matching { merge: true }). Lets us drive advance()'s finalize branch (next >= stepCount),
// which never calls dispatchStep, so no Firebase is needed.
function fakeDb(initial) {
  let doc = { ...initial };
  return {
    db: {
      async runTransaction(fn) {
        const tx = {
          async get() { return { data: () => ({ ...doc }) }; },
          set(_ref, patch) { doc = { ...doc, ...patch }; },
        };
        return fn(tx);
      },
    },
    jobRef: {},
    get: () => doc,
    set: (patch) => { doc = { ...doc, ...patch }; },
  };
}

test("finalize on the last step is single-shot — a duplicate report does NOT re-finalize", async () => {
  // step 1 of stepCount 2 = the LAST step; cursor is on it; one step failed & passed through.
  const f = fakeDb({ cursor: 1, failedSteps: [1] });
  await advance(f.db, f.jobRef, "job1", 1, 2, "passthrough-after-fail", true);
  assert.equal(f.get().status, "fail");
  assert.equal(f.get().cursor, 2, "cursor claimed PAST the last step");
  assert.match(f.get().outcome, /step\(s\) 1 failed/);

  // A second (duplicate) terminal report for the same step must be a no-op. Tamper with status so a
  // re-finalize would be detectable, then re-run: cursor (2) !== step (1) ⇒ stale ⇒ no write.
  f.set({ status: "TAMPERED" });
  await advance(f.db, f.jobRef, "job1", 1, 2, "passthrough-after-fail", true);
  assert.equal(f.get().status, "TAMPERED", "must not re-write the terminal status");
});

test("finalize success when no step failed", async () => {
  const f = fakeDb({ cursor: 0, failedSteps: [] });
  await advance(f.db, f.jobRef, "job1", 0, 1, "success", false);
  assert.equal(f.get().status, "success");
  assert.equal(f.get().outcome, null);
  assert.equal(f.get().cursor, 1);
});

test("a stale report (cursor already moved) writes nothing", async () => {
  const f = fakeDb({ cursor: 5 });
  f.set({ status: "SENTINEL" });
  await advance(f.db, f.jobRef, "job1", 1, 2, "success", false);
  assert.equal(f.get().status, "SENTINEL");
});
