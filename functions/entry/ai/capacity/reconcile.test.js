// reconcile.js — the engine's box lifecycle policy. decideForModel is pure, so every case below is
// exercised on the REAL policy with no GCE/Monitoring; reconcile() is driven with injected deps to
// prove it actuates what it decided and survives a per-model failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideForModel, reconcile, queueState, IDLE_GRACE_MS, MAX_BOXES_PER_MODEL } from "./reconcile.js";

const silence = () => {
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  return () => { console.log = log; console.error = err; };
};

test("starts when messages wait and no box is live", () => {
  const d = decideForModel({ undelivered: 3, outstanding: 0, acked: 0, live: 0, region: "us-central1" });
  assert.equal(d.action, "start");
  assert.match(d.why, /3 waiting, 0 live/);
});

test("does NOT start when live boxes already cover the waiting work", () => {
  const d = decideForModel({ undelivered: 2, outstanding: 0, acked: 0, live: 2, region: "us-central1" });
  assert.equal(d.action, "none");
  assert.match(d.why, /enough boxes/);
});

test("caps concurrent boxes per model regardless of burst size", () => {
  const d = decideForModel({ undelivered: 50, outstanding: 0, acked: 0, live: MAX_BOXES_PER_MODEL, region: "us-west1" });
  assert.equal(d.action, "none", "a 50-message burst must not fan out past the cap");
});

test("stops an idle box: queue empty, nothing in flight, no acks in the grace window", () => {
  const d = decideForModel({ undelivered: 0, outstanding: 0, acked: 0, live: 1, region: "us-central1" });
  assert.equal(d.action, "stop");
  assert.match(d.why, new RegExp(`${IDLE_GRACE_MS / 1000}s`));
});

test("never stops a box with work in flight — the mid-generation kill this replaces", () => {
  const d = decideForModel({ undelivered: 0, outstanding: 1, acked: 0, live: 1, region: "us-central1" });
  assert.equal(d.action, "none");
  assert.match(d.why, /busy/);
});

test("never stops a box that finished work inside the grace window", () => {
  const d = decideForModel({ undelivered: 0, outstanding: 0, acked: 4, live: 1, region: "us-central1" });
  assert.equal(d.action, "none");
  assert.match(d.why, /grace window/);
});

test("unknown metrics are NOT treated as empty — no stop on missing series", () => {
  assert.equal(decideForModel({ undelivered: null, outstanding: null, acked: null, live: 2 }).action, "none");
  assert.equal(decideForModel({ undelivered: 0, outstanding: null, acked: 0, live: 1 }).action, "none");
  assert.equal(decideForModel({ undelivered: 0, outstanding: 0, acked: null, live: 1 }).action, "none");
});

test("queue empty and no boxes → nothing to do", () => {
  assert.equal(decideForModel({ undelivered: 0, outstanding: 0, acked: 0, live: 0 }).action, "none");
});

test("reconcile starts a box with a reason and never blind-resizes on stop", async () => {
  const restore = silence();
  try {
    const started = [], stopped = [];
    await reconcile({
      models: [{ topic: "llama3_1_8b_v1" }],
      pickRegion: async () => "us-central1",
      queue: async () => ({ sub: "sub_x", undelivered: 2, outstanding: 0, acked: 0 }),
      boxes: async () => ({ live: 0, boxes: [] }),
      start: async (m, r, _g, reason) => started.push({ m, r, reason }),
      stop: async () => stopped.push(true),
    });
    assert.equal(started.length, 1);
    assert.equal(stopped.length, 0);
    assert.match(started[0].reason, /^reconcile: 2 waiting/);
  } finally { restore(); }
});

test("reconcile stops with a TARGETED instance, skipping boxes already DELETING", async () => {
  const restore = silence();
  try {
    const stopped = [];
    await reconcile({
      models: [{ topic: "llama3_1_8b_v1" }],
      pickRegion: async () => "us-central1",
      queue: async () => ({ sub: "sub_x", undelivered: 0, outstanding: 0, acked: 0 }),
      boxes: async () => ({ live: 1, boxes: [
        { instance: "url/dying", action: "DELETING" },
        { instance: "url/keep", action: "NONE" },
      ] }),
      start: async () => { throw new Error("must not start"); },
      stop: async (m, r, instance, _g, reason) => stopped.push({ instance, reason }),
    });
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].instance, "url/keep", "must not target a box GCE is already deleting");
    assert.match(stopped[0].reason, /^reconcile: queue empty/);
  } finally { restore(); }
});

test("one model failing does not stop the others reconciling", async () => {
  const restore = silence();
  try {
    const started = [];
    const out = await reconcile({
      models: [{ topic: "boom" }, { topic: "llama3_1_8b_v1" }],
      pickRegion: async (t) => { if (t === "boom") throw new Error("region lookup died"); return "us-central1"; },
      queue: async () => ({ sub: "s", undelivered: 1, outstanding: 0, acked: 0 }),
      boxes: async () => ({ live: 0, boxes: [] }),
      start: async (m) => started.push(m),
      stop: async () => {},
    });
    assert.equal(out[0].action, "error");
    assert.deepEqual(started, ["llama3_1_8b_v1"]);
  } finally { restore(); }
});

// ── the metric-blind path: Cloud Monitoring lags, so a just-published message reads as null ──────────
test("metric blind + pull probe finds a waiting message + no boxes → START", () => {
  const d = decideForModel({ undelivered: null, outstanding: null, acked: null, waiting: true, live: 0, region: "us-central1" });
  assert.equal(d.action, "start", "this is the orphaned-message case the reconciler exists for");
  assert.match(d.why, /pull probe found a waiting message/);
});

test("metric blind + probe finds nothing waiting → no action", () => {
  const d = decideForModel({ undelivered: null, outstanding: null, acked: null, waiting: false, live: 0 });
  assert.equal(d.action, "none");
  assert.match(d.why, /nothing waiting/);
});

test("metric blind + probe unavailable → never acts, and NEVER stops", () => {
  const d = decideForModel({ undelivered: null, outstanding: null, acked: null, waiting: null, live: 2 });
  assert.equal(d.action, "none", "no evidence either way must never delete a box");
  assert.match(d.why, /probe unavailable/);
});

test("metric blind + waiting message but a box is already live → no second box", () => {
  const d = decideForModel({ undelivered: null, outstanding: null, acked: null, waiting: true, live: 1 });
  assert.equal(d.action, "none");
});

test("queueState only probes when the metric is blind", async () => {
  let probes = 0;
  const probe = async () => { probes++; return true; };
  await queueState("llama3_1_8b_v1", 60_000, async () => 5, probe);
  assert.equal(probes, 0, "a metric that answered must not trigger a pull");
  await queueState("llama3_1_8b_v1", 60_000, async () => null, probe);
  assert.equal(probes, 1, "a blind metric must fall back to the probe");
});

test("the pull probe is skipped when a box is already live — its nack costs a delivery attempt", async () => {
  let probes = 0;
  const probe = async () => { probes++; return true; };
  await queueState("llama3_1_8b_v1", 60_000, async () => null, probe, false);
  assert.equal(probes, 0, "no probe when it cannot change the decision (a box is already up)");
  await queueState("llama3_1_8b_v1", 60_000, async () => null, probe, true);
  assert.equal(probes, 1, "probe only on a tick that could start a box");
});

test("reconcile reads inventory BEFORE deciding whether to probe", async () => {
  const restore = silence();
  try {
    const order = [];
    await reconcile({
      models: [{ topic: "llama3_1_8b_v1" }],
      pickRegion: async () => "us-central1",
      boxes: async () => { order.push("boxes"); return { live: 1, boxes: [{ instance: "u/1", action: "NONE" }] }; },
      queue: async (_t, _w, _r, _p, mayProbe) => { order.push(`queue(mayProbe=${mayProbe})`); return { sub: "s", undelivered: null, outstanding: null, acked: null, waiting: null }; },
      start: async () => {}, stop: async () => {},
    });
    assert.deepEqual(order, ["boxes", "queue(mayProbe=false)"], "a live box must suppress the probe");
  } finally { restore(); }
});

// openclaw_llama3_3_70b_v1's MIG is ZONAL while actuate.js addresses every MIG regionally, so the
// listManagedInstances call 404s on EVERY cycle. Logged as reconcile_failed it produced a permanent
// error stream that hid real failures, and a model simply not provisioned in a region is not a fault.
test("a 404 from the box lookup is a skip, not a failure", async () => {
  const notFound = Object.assign(new Error("listManagedInstances ollama-x-mig → 404 not found"), { status: 404 });
  const out = await reconcile({
    models: [{ topic: "openclaw_llama3_3_70b_v1" }],
    pickRegion: async () => "us-central1",
    queue: async () => ({ sub: "sub_x", undelivered: 0, outstanding: 0, acked: 0 }),
    boxes: async () => { throw notFound; },
    start: async () => { throw new Error("must not start"); },
    stop: async () => { throw new Error("must not stop"); },
  });
  assert.equal(out[0].action, "skip");
  assert.equal(out[0].why, "mig_not_found");
  assert.equal(out[0].region, "us-central1");
});

test("a non-404 failure is still reported as an error", async () => {
  const boom = Object.assign(new Error("listManagedInstances → 500 backend error"), { status: 500 });
  const out = await reconcile({
    models: [{ topic: "llama3_1_8b_v1" }],
    pickRegion: async () => "us-central1",
    queue: async () => ({ sub: "sub_x", undelivered: 0, outstanding: 0, acked: 0 }),
    boxes: async () => { throw boom; },
    start: async () => {}, stop: async () => {},
  });
  assert.equal(out[0].action, "error");
  assert.match(out[0].error, /500/);
});

test("one model skipping on 404 does not stop the others reconciling", async () => {
  const started = [];
  const out = await reconcile({
    models: [{ topic: "openclaw_llama3_3_70b_v1" }, { topic: "llama3_1_8b_v1" }],
    pickRegion: async () => "us-central1",
    queue: async () => ({ sub: "sub_x", undelivered: 2, outstanding: 0, acked: 0 }),
    boxes: async (topic) => {
      if (topic === "openclaw_llama3_3_70b_v1") throw Object.assign(new Error("404"), { status: 404 });
      return { live: 0, boxes: [] };
    },
    start: async (m) => started.push(m),
    stop: async () => {},
  });
  assert.equal(out[0].action, "skip");
  assert.deepEqual(started, ["llama3_1_8b_v1"]);
});
