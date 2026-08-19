// Tests for the leaseless dispatch decisions (docs/design/worker-dispatch.md).
// Fast by construction: no Ollama, no Pub/Sub, no Firestore. The concurrency tests use an
// in-memory store that mimics Firestore runTransaction (optimistic concurrency, retry-on-conflict)
// plus a barrier that forces simultaneous reads, so "async with multiple workers" races are
// deterministic and run in milliseconds.
// Run: node --test worker/admission.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldRun, completionWrite } from "./admission.js";

// ---- in-memory CAS store (mimics Firestore runTransaction) ------------------
class CasStore {
  constructor() { this.docs = new Map(); }          // path -> { data, version }
  seed(path, data) { this.docs.set(path, { data: { ...data }, version: 1 }); }
  get(path) { const d = this.docs.get(path); return d ? d.data : undefined; }
  // Optimistic: run fn, capture the versions of every doc it reads, and only commit its writes if
  // none changed since the read. Otherwise re-run fn against fresh state (real Firestore semantics).
  async runTransaction(fn) {
    for (let i = 0; i < 50; i++) {
      const reads = new Map();
      const staged = new Map();
      const tx = {
        get: async (path) => {
          const d = this.docs.get(path);
          reads.set(path, d ? d.version : 0);
          return d ? d.data : undefined;
        },
        set: (path, data) => { staged.set(path, data); },  // merge semantics (test data is whole-doc)
      };
      const ret = await fn(tx);
      const conflict = [...reads].some(([p, v]) => (this.docs.get(p)?.version ?? 0) !== v);
      if (conflict) continue;                          // someone committed first → retry fn
      for (const [p, data] of staged) {
        const prev = this.docs.get(p);
        this.docs.set(p, { data: { ...(prev?.data || {}), ...data }, version: (prev?.version ?? 0) + 1 });
      }
      return ret;
    }
    throw new Error("runTransaction exceeded retries");
  }
}

// A barrier that trips once `n` callers have arrived, then is permanently open (re-runs pass through).
function barrier(n) {
  let count = 0, open = false, release;
  const p = new Promise((r) => (release = r));
  return async () => { if (open) return; if (++count >= n) { open = true; release(); } await p; };
}

// ---- pure decision: shouldRun ----------------------------------------------
test("shouldRun: fresh slot runs", () => {
  assert.equal(shouldRun(undefined, 0), true);
});
test("shouldRun: running slot, same attempt → runs (crash takeover / concurrent dup allowed)", () => {
  assert.equal(shouldRun({ status: "running", attempt: 0 }, 0), true);
});
test("shouldRun: success same attempt → skip (duplicate after success)", () => {
  assert.equal(shouldRun({ status: "success", attempt: 0 }, 0), false);
});
test("shouldRun: fail same attempt → skip (orchestrator retries via a NEW attempt, not this delivery)", () => {
  assert.equal(shouldRun({ status: "fail", attempt: 0 }, 0), false);
});
test("shouldRun: fail older attempt, higher-attempt delivery → runs (retry)", () => {
  assert.equal(shouldRun({ status: "fail", attempt: 0 }, 1), true);
});
test("shouldRun: slot owned by newer attempt → skip stale delivery (terminal or running)", () => {
  assert.equal(shouldRun({ status: "success", attempt: 1 }, 0), false);
  assert.equal(shouldRun({ status: "running", attempt: 1 }, 0), false);
});

// ---- pure decision: completionWrite ----------------------------------------
test("completionWrite: running slot, success this attempt → writes", () => {
  const w = completionWrite({ status: "running", attempt: 0 }, { attempt: 0, status: "success", response: "X" });
  assert.deepEqual(w, { status: "success", attempt: 0, response: "X", outcome: null , thinking: "" });
});
test("completionWrite: already success → null (lost the race)", () => {
  assert.equal(completionWrite({ status: "success", attempt: 0 }, { attempt: 0, status: "success" }), null);
});
test("completionWrite: already fail same attempt → null", () => {
  assert.equal(completionWrite({ status: "fail", attempt: 0 }, { attempt: 0, status: "success" }), null);
});
test("completionWrite: stale older-attempt completion vs running newer attempt → null (no clobber)", () => {
  assert.equal(completionWrite({ status: "running", attempt: 1 }, { attempt: 0, status: "success" }), null);
});
test("completionWrite: no slot yet (undefined) → writes (attempt 0, not terminal)", () => {
  const w = completionWrite(undefined, { attempt: 0, status: "success", response: "Z" });
  assert.deepEqual(w, { status: "success", attempt: 0, response: "Z", outcome: null , thinking: "" });
});
test("completionWrite: retry (higher attempt) over an older terminal slot → writes", () => {
  const w = completionWrite({ status: "fail", attempt: 0 }, { attempt: 1, status: "success", response: "Y" });
  assert.deepEqual(w, { status: "success", attempt: 1, response: "Y", outcome: null , thinking: "" });
});

// ---- concurrency: async with multiple workers ------------------------------
const PATH = "llmResults/job/steps/0-0";

// Simulate one worker's completion attempt against the store.
function complete(store, gate, response, attempt = 0) {
  return store.runTransaction(async (tx) => {
    const slot = await tx.get(PATH);
    await gate();                                    // force all participants to read before any commit
    const w = completionWrite(slot, { attempt, status: "success", response });
    if (!w) return "noop";
    tx.set(PATH, { ...w });
    return "wrote";
  });
}

test("N concurrent completions of the same unit → exactly one wins (first-writer-wins)", async () => {
  const store = new CasStore();
  store.seed(PATH, { status: "running", attempt: 0 });
  const N = 5;
  const gate = barrier(N);
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => complete(store, gate, `worker-${i}`))
  );
  assert.equal(results.filter((r) => r === "wrote").length, 1, "exactly one writer");
  assert.equal(results.filter((r) => r === "noop").length, N - 1, "the rest no-op");
  assert.equal(store.get(PATH).status, "success");
});

test("single dev: claim → run → success, then a duplicate delivery is skipped (never re-runs)", async () => {
  const store = new CasStore();
  let generations = 0;
  // receive = atomic shouldRun + mark running
  const receive = (attempt = 0) => store.runTransaction(async (tx) => {
    const slot = await tx.get(PATH);
    if (!shouldRun(slot, attempt)) return false;
    tx.set(PATH, { status: "running", attempt });
    return true;
  });
  // worker A: first delivery
  assert.equal(await receive(0), true);
  generations++;                                     // "run the generation"
  await store.runTransaction(async (tx) => {
    const slot = await tx.get(PATH);
    const w = completionWrite(slot, { attempt: 0, status: "success", response: "done" });
    if (w) tx.set(PATH, { ...w });
  });
  // worker B: duplicate delivery of the SAME attempt — must not run
  assert.equal(await receive(0), false, "duplicate is skipped at receive");
  assert.equal(generations, 1, "generation ran exactly once");
  assert.equal(store.get(PATH).status, "success");
});

test("crash recovery: A claims then dies; B (redelivery) takes over the running slot and completes", async () => {
  const store = new CasStore();
  const receive = (attempt = 0) => store.runTransaction(async (tx) => {
    const slot = await tx.get(PATH);
    if (!shouldRun(slot, attempt)) return false;
    tx.set(PATH, { status: "running", attempt });
    return true;
  });
  // A claims, marks running, then crashes (no completion, no ack → redelivery)
  assert.equal(await receive(0), true);
  assert.equal(store.get(PATH).status, "running");
  // B gets the redelivery: the slot is `running` (no lease to wait on) → B runs and completes
  assert.equal(await receive(0), true, "redelivery takes over the abandoned running slot");
  await store.runTransaction(async (tx) => {
    const slot = await tx.get(PATH);
    const w = completionWrite(slot, { attempt: 0, status: "success", response: "by-B" });
    if (w) tx.set(PATH, { ...w });
  });
  assert.equal(store.get(PATH).status, "success");
  assert.equal(store.get(PATH).response, "by-B");
});

test("retry: a fail slot is re-run by a higher-attempt delivery and overwrites the slot", async () => {
  const store = new CasStore();
  store.seed(PATH, { status: "fail", attempt: 0, response: "bad" });
  const receive = (attempt) => store.runTransaction(async (tx) => {
    const slot = await tx.get(PATH);
    if (!shouldRun(slot, attempt)) return false;
    tx.set(PATH, { status: "running", attempt });
    return true;
  });
  assert.equal(await receive(1), true, "retry (attempt 1) runs over the failed attempt 0");
  await store.runTransaction(async (tx) => {
    const slot = await tx.get(PATH);
    const w = completionWrite(slot, { attempt: 1, status: "success", response: "good" });
    if (w) tx.set(PATH, { ...w });
  });
  assert.equal(store.get(PATH).status, "success");
  assert.equal(store.get(PATH).attempt, 1);
  assert.equal(store.get(PATH).response, "good");
});
