// Tests for capacity-steering scoring & selection (docs/plans/capacity-steering/plan.md).
// Pure functions, no GCP/Mongo/network — mirrors worker/admission.test.js's pure-decision style.
// Run: node --test functions/entry/ai/capacity/score.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { score, scoreRegionDaypart, select } from "./score.js";

// ---- score / scoreRegionDaypart --------------------------------------------
test("score: net-success is positive", () => {
  assert.ok(score({ ok: 10, fail: 1 }) > 0);
});
test("score: net-fail is negative", () => {
  assert.ok(score({ ok: 1, fail: 10 }) < 0);
});
test("score: uses default weights ow=1.95, fw=0.95", () => {
  assert.equal(score({ ok: 2, fail: 2 }), 1.95 * 2 - 0.95 * 2);
});
test("score: custom weights honored", () => {
  assert.equal(score({ ok: 1, fail: 1 }, { ow: 3, fw: 1 }), 2);
});

test("scoreRegionDaypart: positive for net-success across rows", () => {
  const rows = [{ ok: 5, fail: 0 }, { ok: 3, fail: 1 }];
  assert.ok(scoreRegionDaypart(rows) > 0);
});
test("scoreRegionDaypart: negative for net-fail across rows", () => {
  const rows = [{ ok: 0, fail: 5 }, { ok: 1, fail: 4 }];
  assert.ok(scoreRegionDaypart(rows) < 0);
});
test("scoreRegionDaypart: empty window is exactly 0", () => {
  assert.equal(scoreRegionDaypart([]), 0);
});
test("scoreRegionDaypart: sums rows before scoring (Σok/Σfail)", () => {
  const rows = [{ ok: 2, fail: 1 }, { ok: 3, fail: 2 }];
  assert.equal(scoreRegionDaypart(rows), score({ ok: 5, fail: 3 }));
});

// ---- select ----------------------------------------------------------------
const NOW = 1_000_000;

test("select: picks highest score among non-parked regions", () => {
  const r = select([
    { region: "us-east1", score: 5, consecutiveStockouts: 0 },
    { region: "us-central1", score: 9, consecutiveStockouts: 0 },
    { region: "us-west1", score: 3, consecutiveStockouts: 0 },
  ], NOW, {}, () => 0.99);
  assert.equal(r.region, "us-central1");
});

test("select: top region parked (streak>=3) → excluded from the exploit top pick", () => {
  const r = select([
    { region: "us-central1", score: 9, consecutiveStockouts: 3 }, // parked
    { region: "us-east1", score: 5, consecutiveStockouts: 0 },
    { region: "us-west1", score: 3, consecutiveStockouts: 1 },
  ], NOW, {}, () => 0.99); // never skip → top ACTIVE
  assert.equal(r.region, "us-east1");
});

test("select: streak below maxStockouts is NOT parked (still exploitable)", () => {
  const r = select([
    { region: "us-central1", score: 9, consecutiveStockouts: 2 }, // 2 < 3 → active
    { region: "us-east1", score: 5, consecutiveStockouts: 0 },
  ], NOW, {}, () => 0.99);
  assert.equal(r.region, "us-central1");
});

test("select: maxStockouts param is tunable (parks at 2)", () => {
  const r = select([
    { region: "us-central1", score: 9, consecutiveStockouts: 2 }, // parked at maxStockouts:2
    { region: "us-east1", score: 5, consecutiveStockouts: 0 },
  ], NOW, { maxStockouts: 2 }, () => 0.99);
  assert.equal(r.region, "us-east1");
});

test("select: a parked region stays reachable by EXPLORATION (can't deadlock)", () => {
  const pool = [
    { region: "a", score: 30, consecutiveStockouts: 0 },
    { region: "z", score: 100, consecutiveStockouts: 3 }, // top score but parked
  ];
  // Pure exploit (never skip) → the active region, never the parked one.
  assert.equal(select(pool, NOW, {}, () => 0.99).region, "a");
  // Full skip-cascade → lands on the reserved last slot = the parked region → it gets probed.
  assert.equal(select(pool, NOW, {}, () => 0).region, "z");
});

test("select: ALL parked → drops veto, returns highest overall (least-bad)", () => {
  const r = select([
    { region: "us-central1", score: 9, consecutiveStockouts: 3 },
    { region: "us-east1", score: 4, consecutiveStockouts: 5 },
    { region: "us-west1", score: 7, consecutiveStockouts: 4 },
  ], NOW, {}, () => 0.99);
  assert.equal(r.region, "us-central1");
});

test("select: all-negative scores still returns a region", () => {
  const r = select([
    { region: "us-central1", score: -8, consecutiveStockouts: 0 },
    { region: "us-east1", score: -2, consecutiveStockouts: 0 },
    { region: "us-west1", score: -5, consecutiveStockouts: 0 },
  ], NOW, {}, () => 0.99);
  assert.equal(r.region, "us-east1"); // least-negative
});

test("select: deterministic tie-break by region name asc", () => {
  const r = select([
    { region: "us-west1", score: 5, consecutiveStockouts: 0 },
    { region: "us-central1", score: 5, consecutiveStockouts: 0 },
    { region: "us-east1", score: 5, consecutiveStockouts: 0 },
  ], NOW, {}, () => 0.99);
  assert.equal(r.region, "us-central1");
});

test("select: absent consecutiveStockouts treated as streak 0 (active)", () => {
  const r = select([
    { region: "us-east1", score: 6 },
    { region: "us-central1", score: 2 },
  ], NOW, {}, () => 0.99);
  assert.equal(r.region, "us-east1");
});

test("select: empty region list → null", () => {
  assert.equal(select([], NOW), null);
});

// ---- select: explore/exploit ----------------------------------------------
const FOUR = [
  { region: "a", score: 30, consecutiveStockouts: 0 },
  { region: "b", score: 15, consecutiveStockouts: 0 },
  { region: "c", score: 0, consecutiveStockouts: 0 },
  { region: "d", score: 0, consecutiveStockouts: 0 },
];

test("select: rand never < skip → always the top (pure exploit)", () => {
  assert.equal(select(FOUR, NOW, {}, () => 0.99).region, "a");
});

test("select: rand always skips → cascades to the LAST of the top-N", () => {
  // c/d tie at 0 → name asc → c before d; skipping every non-last lands on d (last).
  assert.equal(select(FOUR, NOW, {}, () => 0).region, "d");
});

test("select: skip once then take → the 2nd region", () => {
  let n = 0;
  const rand = () => (n++ === 0 ? 0 : 0.99); // skip a, take b
  assert.equal(select(FOUR, NOW, {}, rand).region, "b");
});

test("select: exploration is bounded to the top-N (5th region never reachable)", () => {
  const five = [...FOUR, { region: "e", score: -1, consecutiveStockouts: 0 }];
  // even skipping every step, the walk stops at the 4th (d), never reaches e.
  assert.equal(select(five, NOW, { topN: 4 }, () => 0).region, "d");
});

test("select: parked regions are excluded from the exploit pool", () => {
  const pool = [
    { region: "a", score: 30, consecutiveStockouts: 3 }, // parked → excluded from top pick
    { region: "b", score: 15, consecutiveStockouts: 0 },
    { region: "c", score: 0, consecutiveStockouts: 0 },
  ];
  // a is parked; never-skip → top active = b.
  assert.equal(select(pool, NOW, {}, () => 0.99).region, "b");
});
