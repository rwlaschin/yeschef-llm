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

test("select: picks highest score among non-cooldown regions", () => {
  const r = select([
    { region: "us-east1", score: 5, cooldownUntil: null },
    { region: "us-central1", score: 9, cooldownUntil: null },
    { region: "us-west1", score: 3, cooldownUntil: null },
  ], NOW);
  assert.equal(r.region, "us-central1");
});

test("select: top score in cooldown → picks the highest non-cooldown", () => {
  const r = select([
    { region: "us-central1", score: 9, cooldownUntil: NOW + 5000 }, // in cooldown
    { region: "us-east1", score: 5, cooldownUntil: null },
    { region: "us-west1", score: 3, cooldownUntil: NOW - 5000 },    // expired cooldown
  ], NOW);
  assert.equal(r.region, "us-east1");
});

test("select: expired cooldownUntil (<= now) counts as available", () => {
  const r = select([
    { region: "us-central1", score: 9, cooldownUntil: NOW },        // exactly now → available
    { region: "us-east1", score: 5, cooldownUntil: null },
  ], NOW);
  assert.equal(r.region, "us-central1");
});

test("select: ALL in cooldown → drops veto, returns highest overall (least-bad)", () => {
  const r = select([
    { region: "us-central1", score: 9, cooldownUntil: NOW + 1000 },
    { region: "us-east1", score: 4, cooldownUntil: NOW + 1000 },
    { region: "us-west1", score: 7, cooldownUntil: NOW + 1000 },
  ], NOW);
  assert.equal(r.region, "us-central1");
});

test("select: all-negative scores still returns a region", () => {
  const r = select([
    { region: "us-central1", score: -8, cooldownUntil: null },
    { region: "us-east1", score: -2, cooldownUntil: null },
    { region: "us-west1", score: -5, cooldownUntil: null },
  ], NOW);
  assert.equal(r.region, "us-east1"); // least-negative
});

test("select: deterministic tie-break by region name asc", () => {
  const r = select([
    { region: "us-west1", score: 5, cooldownUntil: null },
    { region: "us-central1", score: 5, cooldownUntil: null },
    { region: "us-east1", score: 5, cooldownUntil: null },
  ], NOW);
  assert.equal(r.region, "us-central1");
});

test("select: absent cooldownUntil treated as available", () => {
  const r = select([
    { region: "us-east1", score: 6 },
    { region: "us-central1", score: 2 },
  ], NOW);
  assert.equal(r.region, "us-east1");
});

test("select: empty region list → null", () => {
  assert.equal(select([], NOW), null);
});
