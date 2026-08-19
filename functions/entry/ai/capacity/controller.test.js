process.env.CAPACITY_TZ = "UTC"; // pin dayparts to UTC so the fixed expectations below hold
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, onStockout, onEnqueue, onOutcome, handleOutcomeEvent, onMessageDetected, regionFromLogEntry } from "./controller.js";

// A fully in-memory stand-in for store.js + regions.js + actuate.js — no Mongo, no GCP. Records every
// call so the tests can assert what the controller wrote AND which boxes it actuated. The actuators are
// injected as fakes here: their OWN prod-gating is proved in actuate.test.js; these tests only assert
// the controller CALLS them (recording + deciding run everywhere, dev included).
function fakeDeps({ regions = ["us-central1", "us-west1"], rows = {}, states = [], throwOn = null, needsBox = { start: true, why: "test: box needed", seen: {} } } = {}) {
  const calls = { setState: [], incOk: [], incFail: [], bumpStockoutStreak: [], windowRows: [], recordMessageDetected: [], startBox: [], shrinkBox: [], releaseBox: [], needsBox: [] };
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
      const next = (cur.consecutiveStockouts || 0) + 1;
      state.set(region, { ...cur, consecutiveStockouts: next, lastStockoutTs: whenMs });
      return next;   // the real store returns the post-increment streak (atomic findOneAndUpdate)
    },
    async recordMessageDetected(topic, ts) { calls.recordMessageDetected.push({ topic, ts }); },
    async startBox(model, region, _gce, reason) { calls.startBox.push({ model, region, reason }); },
    async shrinkBox(model, region, _gce, reason) { calls.shrinkBox.push({ model, region, reason }); },
    async releaseBox(model, region, instance, _gce, reason) { calls.releaseBox.push({ model, region, instance, reason }); },
    // The live boxes-vs-backlog gate (real one reads GCE + Pub/Sub — see reconcile.js).
    async needsBox(topic, region) { calls.needsBox.push({ topic, region }); return needsBox; },
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
  assert.deepEqual(
    calls.shrinkBox.map(({ model, region }) => ({ model, region })),
    [{ model: "llama3_1_8b_v1", region: "us-central1" }],
  );
  assert.match(calls.shrinkBox[0].reason, /stockout streak 3/, "the shrink records WHY it abandoned the region");
  assert.deepEqual(
    calls.startBox.map(({ model, region }) => ({ model, region })),
    [{ model: "llama3_1_8b_v1", region: "us-west1" }],
  );
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

// The MIG retries a failed create about every 10s and every retry lands in onStockout. Before this,
// `streak >= MAX` re-ran shrink + cascade on each one — observed reaching streak 27, which issued a
// duplicate resize −1 and a duplicate resize +1 ten seconds apart and left one job with two boxes.
test("onStockout actuates ONCE on the crossing, not on every retry past the threshold", async () => {
  const { deps, calls } = fakeDeps({
    states: [{ region: "us-central1", consecutiveStockouts: 0 }],
    rows: { "us-central1": [{ ok: 0, fail: 0 }], "us-west1": [{ ok: 5, fail: 0 }] },
  });
  // Ten retries in a row, exactly as a stocked-out MIG produces them.
  for (let i = 0; i < 10; i++) await onStockout("us-central1", NOW + i * 1000, "llama3_1_8b_v1", deps, () => 0.99);
  assert.equal(calls.bumpStockoutStreak.length, 10, "every stockout is still recorded");
  assert.equal(calls.shrinkBox.length, 1, "abandoned the region exactly once");
  assert.equal(calls.startBox.length, 1, "cascaded exactly once");
});

test("a success re-arms the crossing, so a later stockout run abandons again", async () => {
  const { deps, calls } = fakeDeps({
    states: [{ region: "us-central1", consecutiveStockouts: 0 }],
    rows: { "us-central1": [{ ok: 0, fail: 0 }], "us-west1": [{ ok: 5, fail: 0 }] },
  });
  for (let i = 0; i < 5; i++) await onStockout("us-central1", NOW + i * 1000, "llama3_1_8b_v1", deps, () => 0.99);
  assert.equal(calls.shrinkBox.length, 1);
  await onOutcome("us-central1", "success", NOW + 9000, "llama3_1_8b_v1", "inst-1", deps, () => 0.99); // resets the streak to 0
  for (let i = 0; i < 5; i++) await onStockout("us-central1", NOW + 10000 + i * 1000, "llama3_1_8b_v1", deps, () => 0.99);
  assert.equal(calls.shrinkBox.length, 2, "crossing fires again after the reset");
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

// ---- onOutcome: records + logs + re-decides EVERYWHERE; teardown belongs to reconcile.js ----
test("onOutcome success: incOk + stamps lastSuccessTs + re-decides, and NEVER tears the box down", async () => {
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
  // A per-job outcome cannot prove the box is free — it may still hold a second leased message. Deleting
  // here killed boxes mid-generation and orphaned the messages they held; reconcile.js owns teardown.
  assert.deepEqual(calls.releaseBox, [], "a finished job must NOT delete its box");
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

test("onOutcome records in DEV too, and still never releases (recording runs everywhere)", async () => {
  const prev = { N: process.env.NODE_ENV, K: process.env.K_SERVICE };
  delete process.env.NODE_ENV; delete process.env.K_SERVICE; // off-prod
  try {
    const { deps, calls } = fakeDeps({ rows: { "us-central1": [{ ok: 1, fail: 0 }], "us-west1": [{ ok: 1, fail: 0 }] } });
    const out = await onOutcome("us-west1", "success", NOW, "llama3_1_8b_v1", "inst-3", deps, () => 0.99);
    assert.equal(calls.incOk.length, 1); // recorded even off-prod
    assert.equal(calls.releaseBox.length, 0); // teardown is the reconciler's job, in every env
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
  assert.equal(calls.startBox.length, 1);
  assert.equal(calls.startBox[0].model, "llama3_1_8b_v1");
  assert.equal(calls.startBox[0].region, "us-west1");
  assert.match(calls.startBox[0].reason, /^detect: /, "the start must record WHY, for the log trail");
  assert.deepEqual(calls.needsBox[0], { topic: "llama3_1_8b_v1", region: "us-west1" });
});

test("onMessageDetected: a detect with boxes already covering the backlog starts NOTHING", async () => {
  // The 11-message burst case: one +1 per detected message fanned boxes across every region.
  const { deps, calls } = fakeDeps({
    rows: { "us-central1": [{ ok: 4, fail: 0 }] },
    needsBox: { start: false, why: "3 waiting, 3 live — enough boxes", seen: { undelivered: 3, live: 3 } },
  });
  const out = await onMessageDetected("llama3_1_8b_v1", NOW, deps, () => 0.99);
  assert.equal(calls.recordMessageDetected.length, 1, "the detection is still recorded");
  assert.deepEqual(calls.startBox, [], "no extra box when the live ones already cover the queue");
  assert.equal(out.started, false);
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
