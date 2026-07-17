process.env.CAPACITY_TZ = "UTC"; // pin dayparts to UTC so the fixed expectations below hold
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, onStockout, onEnqueue, onSuccess, onMessageDetected, regionFromLogEntry } from "./controller.js";

// A fully in-memory stand-in for store.js + regions.js — no Mongo, no GCP. Records every call so the
// tests can assert what the controller wrote and prove it issues no Compute calls (there are none to
// stub: the controller imports nothing from Compute this phase).
function fakeDeps({ regions = ["us-central1", "us-west1"], rows = {}, states = [], throwOn = null } = {}) {
  const calls = { setState: [], incOk: [], incFail: [], setCooldown: [], windowRows: [], recordMessageDetected: [] };
  const state = new Map(states.map((s) => [s.region, { ...s }]));
  const deps = {
    async discoverL4Regions() { if (throwOn === "discover") throw new Error("boom"); return regions; },
    async getState() { return [...state.values()]; },
    async windowRows(region, daypart, nowMs) {
      if (throwOn === "windowRows") throw new Error("boom");
      calls.windowRows.push({ region, daypart, nowMs });
      return rows[region] || [];
    },
    async setState(region, patch) {
      calls.setState.push({ region, patch });
      state.set(region, { ...(state.get(region) || { region }), ...patch });
    },
    async incOk(region, nowMs) { calls.incOk.push({ region, nowMs }); },
    async incFail(region, nowMs) { calls.incFail.push({ region, nowMs }); },
    async setCooldown(region, untilMs) {
      calls.setCooldown.push({ region, untilMs });
      state.set(region, { ...(state.get(region) || { region }), cooldownUntil: untilMs });
    },
    async recordMessageDetected(topic, ts) { calls.recordMessageDetected.push({ topic, ts }); },
  };
  return { deps, calls, state };
}

const NOW = Date.UTC(2026, 6, 15, 14, 0, 0); // wed 14:00 UTC → daypart wed-14

test("decide records wouldOpen/wouldPark on the winner and issues no Compute calls", async () => {
  // west1 has net success, central1 net fail → west1 wins.
  const { deps, calls } = fakeDeps({
    rows: {
      "us-central1": [{ ok: 0, fail: 5 }],
      "us-west1": [{ ok: 4, fail: 0 }],
    },
  });
  const out = await decide(NOW, deps);
  assert.equal(out.wouldOpen, "us-west1");
  assert.deepEqual(out.wouldPark, ["us-central1"]);

  const rec = calls.setState.find((c) => c.region === "us-west1");
  assert.ok(rec, "wrote to the winner's state doc");
  assert.equal(rec.patch.wouldOpen, "us-west1");
  assert.deepEqual(rec.patch.wouldPark, ["us-central1"]);
  assert.equal(rec.patch.decidedDaypart, "wed-14");

  // Scored the CURRENT daypart for every region — proves daypartOf matches store.js's key.
  assert.deepEqual(calls.windowRows.map((c) => c.daypart), ["wed-14", "wed-14"]);
});

test("decide keys the window off the current UTC daypart (matches store.js)", async () => {
  const { deps, calls } = fakeDeps({ regions: ["us-central1"] });
  await decide(Date.UTC(2026, 6, 12, 3, 0, 0), deps); // sun 03:00 UTC
  assert.equal(calls.windowRows[0].daypart, "sun-03");
});

test("decide with no regions returns empty and writes nothing", async () => {
  const { deps, calls } = fakeDeps({ regions: [] });
  const out = await decide(NOW, deps);
  assert.deepEqual(out, { wouldOpen: null, wouldPark: [] });
  assert.equal(calls.setState.length, 0);
});

test("onStockout increments fail, sets cooldown, and re-decides", async () => {
  const { deps, calls } = fakeDeps({
    rows: { "us-central1": [{ ok: 3, fail: 0 }], "us-west1": [{ ok: 3, fail: 0 }] },
  });
  const out = await onStockout("us-central1", NOW, deps);

  assert.equal(calls.incFail.length, 1);
  assert.equal(calls.incFail[0].region, "us-central1");

  assert.equal(calls.setCooldown.length, 1);
  assert.equal(calls.setCooldown[0].region, "us-central1");
  assert.ok(calls.setCooldown[0].untilMs > NOW, "cooldown is in the future");

  // Re-decided: central1 is now vetoed by its fresh cooldown → the sibling is the winner.
  assert.equal(out.wouldOpen, "us-west1");
  assert.deepEqual(out.wouldPark, ["us-central1"]);
});

test("onStockout swallows a thrown store error (never rethrows)", async () => {
  const { deps } = fakeDeps({ throwOn: "windowRows" });
  const out = await onStockout("us-central1", NOW, deps); // incFail/setCooldown ok, decide throws
  assert.ok(out.error, "returned an error marker instead of throwing");
});

test("onSuccess increments ok and stamps lastSuccessTs", async () => {
  const { deps, calls } = fakeDeps();
  await onSuccess("us-west1", NOW, deps);
  assert.deepEqual(calls.incOk[0], { region: "us-west1", nowMs: NOW });
  const rec = calls.setState.find((c) => c.region === "us-west1");
  assert.equal(rec.patch.lastSuccessTs, NOW);
});

test("onEnqueue no-ops off-prod (no store access) and never throws", async () => {
  const prev = { NODE_ENV: process.env.NODE_ENV, K_SERVICE: process.env.K_SERVICE };
  delete process.env.NODE_ENV;
  delete process.env.K_SERVICE;
  try {
    const { deps, calls } = fakeDeps({ throwOn: "discover" });
    const out = await onEnqueue(NOW, deps); // would throw if it ran decide — but gate skips it
    assert.deepEqual(out, { skipped: "not-prod" });
    assert.equal(calls.windowRows.length, 0);
  } finally {
    if (prev.NODE_ENV !== undefined) process.env.NODE_ENV = prev.NODE_ENV;
    if (prev.K_SERVICE !== undefined) process.env.K_SERVICE = prev.K_SERVICE;
  }
});

test("onEnqueue swallows a thrown store error in prod (never rethrows)", async () => {
  const prev = process.env.K_SERVICE;
  process.env.K_SERVICE = "orchestrator"; // make isProdLike() true so decide actually runs
  try {
    const { deps } = fakeDeps({ throwOn: "windowRows" });
    const out = await onEnqueue(NOW, deps);
    assert.ok(out.error, "returned an error marker instead of throwing");
  } finally {
    if (prev === undefined) delete process.env.K_SERVICE;
    else process.env.K_SERVICE = prev;
  }
});

// ---- regionFromLogEntry: parse the REAL prod log shape (verified 2026-07-15) ----------------
test("regionFromLogEntry: reads region from resource.labels.zone (the real field)", () => {
  const entry = { resource: { type: "gce_instance", labels: { zone: "us-central1-b" } } };
  assert.equal(regionFromLogEntry(entry), "us-central1");
});
test("regionFromLogEntry: falls back to zone in protoPayload.resourceName", () => {
  const entry = { protoPayload: { resourceName: "projects/38637528569/zones/us-east4-c/instances/ollama-x-mig-bmjs" } };
  assert.equal(regionFromLogEntry(entry), "us-east4");
});
test("regionFromLogEntry: no zone anywhere → null (handler skips)", () => {
  assert.equal(regionFromLogEntry({ resource: { labels: {} } }), null);
});

// ---- onMessageDetected: event-driven detect-message (from the publish chokepoint) ------------
test("onMessageDetected: records the detection + decides (observe), prod-gated", async () => {
  const prev = process.env.K_SERVICE; process.env.K_SERVICE = "orchestrator";
  try {
    const { deps, calls } = fakeDeps({ rows: { "us-central1": [{ ok: 0, fail: 5 }], "us-west1": [{ ok: 4, fail: 0 }] } });
    const out = await onMessageDetected("llama3_1_8b_v1", NOW, deps);
    assert.equal(calls.recordMessageDetected[0].topic, "llama3_1_8b_v1");
    assert.equal(out.detected, "llama3_1_8b_v1");
    assert.equal(out.wouldOpen, "us-west1"); // decide ran (observe); enable is Phase 2
  } finally { if (prev === undefined) delete process.env.K_SERVICE; else process.env.K_SERVICE = prev; }
});

test("onMessageDetected: no-ops off-prod (records nothing)", async () => {
  const prev = { N: process.env.NODE_ENV, K: process.env.K_SERVICE };
  delete process.env.NODE_ENV; delete process.env.K_SERVICE;
  try {
    const { deps, calls } = fakeDeps();
    assert.deepEqual(await onMessageDetected("t", NOW, deps), { skipped: "not-prod" });
    assert.equal(calls.recordMessageDetected.length, 0);
  } finally {
    if (prev.N !== undefined) process.env.NODE_ENV = prev.N;
    if (prev.K !== undefined) process.env.K_SERVICE = prev.K;
  }
});
