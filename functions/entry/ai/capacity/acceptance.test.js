// ACCEPTANCE-CRITERIA suite for the capacity manager — the user's checklist, one test per criterion,
// driven through the REAL message entry points (not the internal hooks directly):
//   • boot path:    handleDetectMessage (decodes the Pub/Sub envelope EVERY app publisher sends) →
//                   onMessageDetected → decide → REAL startBox (actuate.js)
//   • release path: onOutcome records the ok and re-decides — teardown is reconcile.js's job, NOT a
//                   per-job release (see reconcile.test.js for the idle-stop policy)
//   • stockout:     onStockout (what handleStockoutLog forwards to) → REAL shrinkBox + cascade startBox
//
// "For ALL Pub/Sub messages the app sends": dispatch.js, start.js and query.js ALL publish to a model
// topic with `model:<topic>` in the JSON — handleDetectMessage keys off exactly that field, so one
// detect path covers every app message; only the model→MIG differs. These tests exercise several real
// topics to prove the MIG is resolved correctly per model.
//
// The STORE is faked (no Mongo); the ACTUATOR is REAL, run with the prod gate OFF — so every actuation
// returns `{ would:true, mig, region }` and makes ZERO GCE calls. That proves BOTH "the right machine"
// (real migOf) AND "safe in dev" (no live MIG touched) in one shot. actuate.test.js proves the prod
// branch issues the real resize/delete.
process.env.CAPACITY_TZ = "UTC";
delete process.env.NODE_ENV;   // force off-prod so the real actuators would-log instead of calling GCE
delete process.env.K_SERVICE;
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleDetectMessage } from "./recorder.js";
import { onMessageDetected, onStockout, onOutcome } from "./controller.js";
import { startBox, shrinkBox, releaseBox, migOf } from "./actuate.js";

const NOW = Date.UTC(2026, 6, 15, 14, 0, 0); // wed 14:00 UTC → daypart wed-14
const NEVER_SKIP = () => 0.99;               // explore-walk takes the top pick deterministically

// In-memory store + REAL actuators, wrapped to record every actuation (and its real return value).
function harness({ regions = ["us-west1", "us-central1", "us-east4", "us-east1"], rows = {}, states = [] } = {}) {
  const state = new Map(states.map((s) => [s.region, { ...s }]));
  const seen = new Set();
  const acts = []; // { name, model, region, instance?, result }  — result carries would/mig from real actuate
  const rec = (name, fn) => async (...args) => {
    const result = await fn(...args);
    const [model, region, instance] = args;
    acts.push({ name, model, region, instance, result });
    return result;
  };
  const deps = {
    async discoverL4Regions() { return regions; },
    async getState() { return [...state.values()]; },
    async windowRows(region) { return rows[region] || []; },
    async setState(region, patch) { state.set(region, { ...(state.get(region) || { region }), ...patch }); },
    async incOk() {},
    async incFail() {},
    async bumpStockoutStreak(region, whenMs) {
      const cur = state.get(region) || { region };
      const next = (cur.consecutiveStockouts || 0) + 1;
      state.set(region, { ...cur, consecutiveStockouts: next, lastStockoutTs: whenMs });
      return next;   // the real store returns the post-increment streak (atomic findOneAndUpdate)
    },
    async recordMessageDetected() {},
    async claimWalk(region) {
      const cur = state.get(region) || { region };
      if (cur.walked) return false;
      state.set(region, { ...cur, walked: true });
      return true;   // the real store claims atomically (updateOne walked:{$ne:true})
    },
    // The live boxes-vs-backlog gate is stubbed to "yes": the real one reads GCE + Cloud Monitoring, and
    // these tests must make ZERO network calls. Its own policy is proved in reconcile.test.js; here we
    // only need the detect chain to reach the REAL actuator.
    async needsBox() { return { start: true, why: "acceptance: gate stubbed open", seen: {} }; },
    startBox: rec("start", startBox),      // REAL actuate.js
    shrinkBox: rec("shrink", shrinkBox),   // REAL
    releaseBox: rec("release", releaseBox),// REAL
  };
  // handleDetectMessage only threads (markMessageSeen, onMessageDetected) — bridge onMessageDetected to
  // the REAL controller fn with our injected deps + deterministic rand, so the whole boot chain is real.
  const detectDeps = {
    async markMessageSeen(id) { if (seen.has(id)) return false; seen.add(id); return true; },
    onMessageDetected: (topic, nowMs) => onMessageDetected(topic, nowMs, deps, NEVER_SKIP),
  };
  const starts = () => acts.filter((a) => a.name === "start");
  return { deps, detectDeps, acts, starts };
}

// One Pub/Sub push envelope exactly as dispatch.js/start.js/query.js produce it (JSON body → base64 data).
function detectMsg(topic, messageId, extra = {}) {
  const body = JSON.stringify({ model: topic, jobId: `job-${messageId}`, ...extra });
  return { messageId, data: Buffer.from(body, "utf8").toString("base64") };
}

// Rows that make `winner` the unambiguous top score (others net-negative); winner gets a small net-positive.
const winRows = (winner, all) => Object.fromEntries(all.map((r) => [r, r === winner ? [{ ok: 3, fail: 0 }] : [{ ok: 0, fail: 4 }]]));

// ── AC1 — 1 pub/sub → 1 correct capacity machine ───────────────────────────────────────────────
test("AC1: one detected message boots exactly ONE box, in the winning region, on the right model's MIG", async () => {
  const REGIONS = ["us-west1", "us-central1", "us-east4", "us-east1"];
  const h = harness({ regions: REGIONS, rows: winRows("us-west1", REGIONS) });

  const out = await handleDetectMessage(detectMsg("llama3_1_8b_v1", "m1"), NOW, h.detectDeps);

  assert.equal(out.detected, "llama3_1_8b_v1");
  assert.equal(out.wouldOpen, "us-west1");
  assert.equal(h.starts().length, 1, "exactly one box started");
  const a = h.starts()[0];
  assert.equal(a.model, "llama3_1_8b_v1");
  assert.equal(a.region, "us-west1");
  assert.equal(a.result.mig, "ollama-llama3-1-8b-v1-mig", "correct model MIG resolved");
  assert.equal(a.result.would, true, "dev: WOULD resize +1 — ZERO GCE calls");
  assert.equal(a.result.action, "resize +1");
});

test("AC1 (per-model): each real app topic resolves to its OWN MIG (query/planner/step share this path)", async () => {
  // query.js (topic=gemma4_12b_v1), start.js planner (topic=qwen3_5_9b_v1), dispatch.js step (openclaw) —
  // all the same envelope shape; only migOf differs. Prove the machine picked matches the model.
  for (const [topic, mig] of [
    ["gemma4_12b_v1", "ollama-gemma4-12b-v1-mig"],
    ["qwen3_5_9b_v1", "ollama-qwen3-5-9b-v1-mig"],
    ["openclaw_llama3_1_8b_v1", "ollama-openclaw-llama3-1-8b-v1-mig"],
  ]) {
    const REGIONS = ["us-west1", "us-central1"];
    const h = harness({ regions: REGIONS, rows: winRows("us-west1", REGIONS) });
    await handleDetectMessage(detectMsg(topic, `m-${topic}`), NOW, h.detectDeps);
    assert.equal(h.starts().length, 1, `${topic}: one box`);
    assert.equal(h.starts()[0].result.mig, mig, `${topic} → ${mig}`);
    assert.equal(migOf(topic), mig); // sanity: the reverse/derive matches
  }
});

// ── AC2 — 2 pub/sub → 2 correct capacity machines ──────────────────────────────────────────────
test("AC2: two DISTINCT messages boot TWO boxes; a redelivery of the same messageId does NOT", async () => {
  const REGIONS = ["us-west1", "us-central1"];
  const h = harness({ regions: REGIONS, rows: winRows("us-west1", REGIONS) });

  await handleDetectMessage(detectMsg("llama3_1_8b_v1", "a"), NOW, h.detectDeps);
  await handleDetectMessage(detectMsg("llama3_1_8b_v1", "b"), NOW, h.detectDeps);
  assert.equal(h.starts().length, 2, "two distinct messages → two boxes");

  const dup = await handleDetectMessage(detectMsg("llama3_1_8b_v1", "a"), NOW, h.detectDeps); // replay
  assert.deepEqual(dup, { dup: true });
  assert.equal(h.starts().length, 2, "redelivery deduped — still two boxes, not three");
});

// ── AC3a — failover on IMMEDIATE stockout ──────────────────────────────────────────────────────
test("AC3a: a region that stocks out from the start parks after 3-in-a-row and cascades to another region", async () => {
  // us-west1 is the top pick but has never succeeded; it stocks out 3× straight → park + cascade to us-central1.
  const REGIONS = ["us-west1", "us-central1"];
  const rows = { "us-west1": [{ ok: 0, fail: 0 }], "us-central1": [{ ok: 0, fail: 0 }] };
  const h = harness({ regions: REGIONS, rows });

  let out;
  for (let i = 1; i <= 3; i++) out = await onStockout("us-west1", NOW, "llama3_1_8b_v1", h.deps, NEVER_SKIP);

  // Under 3 → no inventory change; at the 3rd → shrink west1 + start the cascade region.
  const shrinks = h.acts.filter((a) => a.name === "shrink");
  assert.equal(shrinks.length, 1, "shrink only at the 3rd consecutive stockout");
  assert.equal(shrinks[0].region, "us-west1");
  assert.equal(shrinks[0].result.mig, "ollama-llama3-1-8b-v1-mig");
  assert.equal(out.wouldOpen, "us-central1", "cascaded off the parked region");
  assert.deepEqual(h.starts().map((a) => a.region), ["us-central1"], "one cascade start, in the new region");
});

// ── AC3b — failover when an ACTIVE region gets stocked out ──────────────────────────────────────
test("AC3b: a region actively serving work parks after 3-in-a-row and work cascades to another region", async () => {
  // us-west1 is ACTIVE (net-positive, was the winner). It then stocks out 3× straight → park + cascade.
  const REGIONS = ["us-west1", "us-central1"];
  const rows = { "us-west1": [{ ok: 6, fail: 0 }], "us-central1": [{ ok: 1, fail: 0 }] };
  const h = harness({ regions: REGIONS, rows });

  // Confirm it IS the active winner first (a normal detect goes there).
  await handleDetectMessage(detectMsg("llama3_1_8b_v1", "warm"), NOW, h.detectDeps);
  assert.equal(h.starts()[0].region, "us-west1", "west1 is the active region");

  let out;
  for (let i = 1; i <= 3; i++) out = await onStockout("us-west1", NOW, "llama3_1_8b_v1", h.deps, NEVER_SKIP);

  assert.equal(h.acts.filter((a) => a.name === "shrink").length, 1, "active region abandoned only at the 3rd");
  assert.equal(out.wouldOpen, "us-central1", "work moved off the now-exhausted active region");
  const cascade = h.starts().slice(1); // after the warm-up start
  assert.deepEqual(cascade.map((a) => a.region), ["us-central1"]);
});

// ── AC4 — correctly move to EMPTY / never-used regions ──────────────────────────────────────────
test("AC4: an empty/never-used region is selected when the used ones are worse (score 0 > net-negative)", async () => {
  // us-east4 has NO rows (never used) → score 0. The used regions are net-negative. Empty wins.
  const REGIONS = ["us-west1", "us-central1", "us-east4"];
  const rows = { "us-west1": [{ ok: 0, fail: 5 }], "us-central1": [{ ok: 0, fail: 3 }] }; // us-east4 absent → []
  const h = harness({ regions: REGIONS, rows });

  const out = await handleDetectMessage(detectMsg("llama3_1_8b_v1", "empty1"), NOW, h.detectDeps);
  assert.equal(out.wouldOpen, "us-east4", "moved to the unused region");
  assert.equal(h.starts()[0].region, "us-east4");
  assert.equal(h.starts()[0].result.mig, "ollama-llama3-1-8b-v1-mig");
});

test("AC4 (recovery via exploration): a parked region is re-probed and a success un-parks it", async () => {
  // us-west1 parked (streak 3). Others net-negative so it still outscores them. Exploration reaches the
  // reserved parked slot; a success then resets the streak so it's a first-class pick again.
  const REGIONS = ["us-west1", "us-central1"];
  const rows = { "us-west1": [{ ok: 5, fail: 0 }], "us-central1": [{ ok: 0, fail: 4 }] };
  const h = harness({ regions: REGIONS, rows, states: [{ region: "us-west1", consecutiveStockouts: 3 }] });

  const out = await onOutcome("us-west1", "success", NOW, "llama3_1_8b_v1", "inst-x", h.deps, NEVER_SKIP);
  assert.equal(out.wouldOpen, "us-west1", "un-parked after the success");
  // A finished job records the success and re-decides, but does NOT touch the box: it may still hold a
  // second leased message, and killing it mid-flight orphaned that message. reconcile.js owns teardown.
  assert.equal(h.acts.find((a) => a.name === "release"), undefined, "no release on a job outcome");
});

// ── Safety net that underpins every criterion: dev NEVER touches a live MIG ─────────────────────
test("SAFETY: in dev, every actuation is would:true — ZERO real GCE calls across all paths", async () => {
  const REGIONS = ["us-west1", "us-central1"];
  const h = harness({ regions: REGIONS, rows: winRows("us-west1", REGIONS) });
  await handleDetectMessage(detectMsg("llama3_1_8b_v1", "s1"), NOW, h.detectDeps);
  await onOutcome("us-west1", "success", NOW, "llama3_1_8b_v1", "inst-s", h.deps, NEVER_SKIP);
  for (let i = 1; i <= 3; i++) await onStockout("us-west1", NOW, "llama3_1_8b_v1", h.deps, NEVER_SKIP);
  assert.ok(h.acts.length >= 3, "actuators were invoked");
  for (const a of h.acts) assert.equal(a.result.would, true, `${a.name} would-logged, no GCE`);
});
