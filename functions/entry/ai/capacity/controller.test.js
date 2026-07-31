process.env.CAPACITY_TZ = "UTC"; // pin dayparts to UTC so the fixed expectations below hold
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, onStockout, onEnqueue, onOutcome, handleOutcomeEvent, onMessageDetected, regionFromLogEntry } from "./controller.js";

// A fully in-memory stand-in for store.js + regions.js + actuate.js — no Mongo, no GCP. Records every
// call so the tests can assert what the controller wrote AND which boxes it actuated. The actuators are
// injected as fakes here: their OWN prod-gating is proved in actuate.test.js; these tests only assert
// the controller CALLS them (recording + deciding run everywhere, dev included).
function fakeDeps({ regions = ["us-central1", "us-west1"], rows = {}, states = [], throwOn = null } = {}) {
  const calls = { setState: [], incOk: [], incFail: [], bumpStockoutStreak: [], windowRows: [], recordMessageDetected: [], startBox: [], shrinkBox: [], releaseBox: [] };
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
    async bumpStockoutStreak(region, whenMs) {
      calls.bumpStockoutStreak.push({ region, whenMs });
      const cur = state.get(region) || { region };
      state.set(region, { ...cur, consecutiveStockouts: (cur.consecutiveStockouts || 0) + 1, lastStockoutTs: whenMs });
    },
    async recordMessageDetected(topic, ts) { calls.recordMessageDetected.push({ topic, ts }); },
    async startBox(model, region) { calls.startBox.push({ model, region }); },
    async shrinkBox(model, region) { calls.shrinkBox.push({ model, region }); },
    async releaseBox(model, region, instance) { calls.releaseBox.push({ model, region, instance }); },
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
  const out = await decide(NOW, deps, () => 0.99); // never-skip → deterministic top pick
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

// ---- onStockout: records everywhere; ACTUATES (shrink + cascade-start) only at the 3rd in a row ----
test("onStockout increments fail, bumps the streak, re-decides; under 3 in a row → NO inventory change", async () => {
  const { deps, calls } = fakeDeps({
    rows: { "us-central1": [{ ok: 3, fail: 0 }], "us-west1": [{ ok: 3, fail: 0 }] },
  });
  const out = await onStockout("us-central1", NOW, "llama3_1_8b_v1", deps, () => 0.99); // streak 1 < 3

  assert.equal(calls.incFail.length, 1);
  assert.equal(calls.incFail[0].region, "us-central1");
  assert.equal(calls.bumpStockoutStreak.length, 1);
  assert.equal(calls.bumpStockoutStreak[0].whenMs, NOW);

  // A single stockout (streak 1 < 3) does NOT park central1 → equal scores, name-asc tie-break wins.
  assert.equal(out.wouldOpen, "us-central1");
  // Under 3 in a row → the MIG retries its own boot; we touch NO inventory.
  assert.equal(calls.shrinkBox.length, 0);
  assert.equal(calls.startBox.length, 0);
});

test("onStockout at the 3rd in a row → shrinkBox(model, region) + cascade startBox(model, next)", async () => {
  const { deps, calls } = fakeDeps({
    // Both regions net-neutral so only the streak decides. central1 starts at streak 2 → 3 → parked.
    states: [{ region: "us-central1", consecutiveStockouts: 2 }],
    rows: { "us-central1": [{ ok: 0, fail: 0 }], "us-west1": [{ ok: 0, fail: 0 }] },
  });
  const out = await onStockout("us-central1", NOW, "llama3_1_8b_v1", deps, () => 0.99); // never-skip
  assert.equal(out.wouldOpen, "us-west1"); // central1 now parked → the sibling wins
  assert.deepEqual(out.wouldPark, ["us-central1"]);

  // Abandon central1 (resize −1), then boot a box in the cascaded-to region.
  assert.deepEqual(calls.shrinkBox, [{ model: "llama3_1_8b_v1", region: "us-central1" }]);
  assert.deepEqual(calls.startBox, [{ model: "llama3_1_8b_v1", region: "us-west1" }]);
});

test("onStockout at the 3rd in a row with NO other region → shrink but no cascade-start (nowhere to go)", async () => {
  const { deps, calls } = fakeDeps({
    regions: ["us-central1"], // the only region
    states: [{ region: "us-central1", consecutiveStockouts: 2 }],
    rows: { "us-central1": [{ ok: 0, fail: 0 }] },
  });
  await onStockout("us-central1", NOW, "llama3_1_8b_v1", deps, () => 0.99);
  assert.equal(calls.shrinkBox.length, 1);
  assert.equal(calls.startBox.length, 0); // decide names central1 (all-parked veto-drop) — don't restart it
});

test("onStockout with no model → records + decides, but NO actuation (topic unresolved)", async () => {
  const { deps, calls } = fakeDeps({
    states: [{ region: "us-central1", consecutiveStockouts: 2 }],
    rows: { "us-central1": [{ ok: 0, fail: 0 }], "us-west1": [{ ok: 0, fail: 0 }] },
  });
  await onStockout("us-central1", NOW, null, deps, () => 0.99); // model null → streak hits 3 but no MIG to touch
  assert.equal(calls.bumpStockoutStreak.length, 1);
  assert.equal(calls.shrinkBox.length, 0);
  assert.equal(calls.startBox.length, 0);
});

test("onStockout swallows a thrown store error (never rethrows)", async () => {
  const { deps } = fakeDeps({ throwOn: "windowRows" });
  const out = await onStockout("us-central1", NOW, null, deps); // incFail/bump ok, decide throws
  assert.ok(out.error, "returned an error marker instead of throwing");
});

// ---- onOutcome: records + logs + re-decides EVERYWHERE; releaseBox actuates (prod-gated inside) ----
test("onOutcome success: incOk + stamps lastSuccessTs + re-decides + releaseBox(model, region, instance)", async () => {
  // west1 net success, central1 net fail → the re-decide should name west1.
  const { deps, calls } = fakeDeps({
    rows: { "us-central1": [{ ok: 0, fail: 5 }], "us-west1": [{ ok: 4, fail: 0 }] },
  });
  const out = await onOutcome("us-west1", "success", NOW, "llama3_1_8b_v1", "inst-1", deps, () => 0.99);
  assert.deepEqual(calls.incOk[0], { region: "us-west1", nowMs: NOW });
  const rec = calls.setState.find((c) => c.region === "us-west1" && c.patch.lastSuccessTs != null);
  assert.equal(rec.patch.lastSuccessTs, NOW);
  assert.equal(rec.patch.consecutiveStockouts, 0, "success resets the stockout streak");
  assert.equal(out.wouldOpen, "us-west1"); // re-decided after the ok landed
  assert.deepEqual(calls.releaseBox, [{ model: "llama3_1_8b_v1", region: "us-west1", instance: "inst-1" }]);
});

test("onOutcome success un-parks a region: streak reset → eligible again in the re-decide", async () => {
  // central1 was parked (streak 3) and outscores west1. A success resets its streak → it wins again.
  const { deps, calls } = fakeDeps({
    states: [{ region: "us-central1", consecutiveStockouts: 3 }],
    rows: { "us-central1": [{ ok: 6, fail: 0 }], "us-west1": [{ ok: 1, fail: 0 }] },
  });
  const out = await onOutcome("us-central1", "success", NOW, "llama3_1_8b_v1", "inst-2", deps, () => 0.99);
  const rec = calls.setState.find((c) => c.region === "us-central1");
  assert.equal(rec.patch.consecutiveStockouts, 0);
  assert.equal(out.wouldOpen, "us-central1"); // no longer parked → top score wins
});

test("onOutcome records + releases in DEV too (recording runs everywhere; the GCE gate is inside actuate)", async () => {
  const prev = { N: process.env.NODE_ENV, K: process.env.K_SERVICE };
  delete process.env.NODE_ENV; delete process.env.K_SERVICE; // off-prod
  try {
    const { deps, calls } = fakeDeps({ rows: { "us-central1": [{ ok: 1, fail: 0 }], "us-west1": [{ ok: 1, fail: 0 }] } });
    const out = await onOutcome("us-west1", "success", NOW, "llama3_1_8b_v1", "inst-3", deps, () => 0.99);
    assert.equal(calls.incOk.length, 1); // recorded even off-prod
    assert.equal(calls.releaseBox.length, 1); // controller still calls releaseBox (it self-gates internally)
    assert.ok(out.wouldOpen);
  } finally {
    if (prev.N !== undefined) process.env.NODE_ENV = prev.N;
    if (prev.K !== undefined) process.env.K_SERVICE = prev.K;
  }
});

test("onOutcome fail: LOG only — no incOk, no setState, no decide, no release", async () => {
  const { deps, calls } = fakeDeps();
  const out = await onOutcome("us-west1", "fail", NOW, "llama3_1_8b_v1", "inst-4", deps);
  assert.equal(calls.incOk.length, 0);
  assert.equal(calls.setState.length, 0);
  assert.equal(calls.windowRows.length, 0); // decide never ran
  assert.equal(calls.releaseBox.length, 0);
  assert.deepEqual(out, { skipped: "job-fail" });
});

test("onOutcome swallows a thrown store error (never rethrows)", async () => {
  const deps = { ...fakeDeps().deps, incOk: async () => { throw new Error("boom"); } };
  const out = await onOutcome("us-west1", "success", NOW, "llama3_1_8b_v1", "inst-5", deps);
  assert.ok(out.error, "returned an error marker instead of throwing");
});

test("onOutcome with no region → skipped (never writes region:null)", async () => {
  const { deps, calls } = fakeDeps();
  assert.deepEqual(await onOutcome(null, "success", NOW, "llama3_1_8b_v1", "inst-6", deps), { skipped: "no-region" });
  assert.equal(calls.incOk.length, 0);
  assert.equal(calls.releaseBox.length, 0);
});

test("handleOutcomeEvent adapter: forwards region + status off the decoded payload → onOutcome", async () => {
  // Uses real default deps, but the fail path returns before any store/GCP call — so no Mongo is touched.
  assert.deepEqual(await handleOutcomeEvent({ region: "us-west1", status: "fail" }), { skipped: "job-fail" });
});

// ---- onEnqueue: decides everywhere now (no prod gate) ----
test("onEnqueue decides (records the would-decision) — runs everywhere, no prod gate", async () => {
  const { deps, calls } = fakeDeps({ rows: { "us-central1": [{ ok: 0, fail: 5 }], "us-west1": [{ ok: 4, fail: 0 }] } });
  const out = await onEnqueue(NOW, deps, () => 0.99);
  assert.equal(out.wouldOpen, "us-west1");
  assert.equal(calls.windowRows.length, 2); // decide actually ran
});

test("onEnqueue swallows a thrown store error (never rethrows)", async () => {
  const { deps } = fakeDeps({ throwOn: "windowRows" });
  const out = await onEnqueue(NOW, deps);
  assert.ok(out.error, "returned an error marker instead of throwing");
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

// ---- handleStockoutLog: the deploy-time log-sink adapter -------------------------------------
test("handleStockoutLog: entry with no resolvable region → skipped (no store/actuation, no Mongo)", async () => {
  const { handleStockoutLog } = await import("./controller.js");
  assert.deepEqual(await handleStockoutLog({ resource: { labels: {} } }), { skipped: "no-region" });
});

// ---- onMessageDetected: records + decides + startBox — runs everywhere (no prod gate) ------------
test("onMessageDetected: records the detection, decides, and startBox(topic, winner)", async () => {
  const { deps, calls } = fakeDeps({ rows: { "us-central1": [{ ok: 0, fail: 5 }], "us-west1": [{ ok: 4, fail: 0 }] } });
  const out = await onMessageDetected("llama3_1_8b_v1", NOW, deps, () => 0.99); // never-skip → deterministic
  assert.equal(calls.recordMessageDetected[0].topic, "llama3_1_8b_v1");
  assert.equal(out.detected, "llama3_1_8b_v1");
  assert.equal(out.wouldOpen, "us-west1");
  assert.deepEqual(calls.startBox, [{ model: "llama3_1_8b_v1", region: "us-west1" }]);
});

test("onMessageDetected: records + starts in DEV too (recording runs everywhere)", async () => {
  const prev = { N: process.env.NODE_ENV, K: process.env.K_SERVICE };
  delete process.env.NODE_ENV; delete process.env.K_SERVICE;
  try {
    const { deps, calls } = fakeDeps({ rows: { "us-central1": [{ ok: 1, fail: 0 }], "us-west1": [{ ok: 1, fail: 0 }] } });
    const out = await onMessageDetected("llama3_1_8b_v1", NOW, deps, () => 0.99);
    assert.equal(calls.recordMessageDetected.length, 1);
    assert.equal(calls.startBox.length, 1);
    assert.ok(out.detected);
  } finally {
    if (prev.N !== undefined) process.env.NODE_ENV = prev.N;
    if (prev.K !== undefined) process.env.K_SERVICE = prev.K;
  }
});

test("onMessageDetected swallows a thrown store error (never rethrows)", async () => {
  const { deps } = fakeDeps({ throwOn: "windowRows" });
  const out = await onMessageDetected("llama3_1_8b_v1", NOW, deps);
  assert.ok(out.error, "returned an error marker instead of throwing");
});
