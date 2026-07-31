// Capacity-steering scoring & region selection — pure functions, no I/O (docs/plans/capacity-steering/plan.md).
// The controller scores each L4 region for the current daypart over its in-window daily rows, then
// selects one region to keep `--mode=on`. Only the ratio ow/fw affects ranking; defaults ow=1.95,
// fw=0.95 weight a success ~2× a failure. Kept side-effect-free so it unit-tests without GCP/Mongo.

// Net score for a single tally: successes weighted up, failures weighted down.
export function score({ ok = 0, fail = 0 }, { ow = 1.95, fw = 0.95 } = {}) {
  return ow * ok - fw * fail;
}

// Sum the daily rows for one region+daypart, then score the totals. Empty window → 0.
export function scoreRegionDaypart(rows, opts) {
  const sum = rows.reduce((a, r) => ({ ok: a.ok + (r.ok || 0), fail: a.fail + (r.fail || 0) }), { ok: 0, fail: 0 });
  return score(sum, opts);
}

// Pick the region to open — EXPLORE/EXPLOIT so lower-ranked regions still get periodic probes (else a
// region stuck at 0/stale is never tried again to see if capacity returned). Sort desc by score (ties
// → region name asc, deterministic), then PARK any region whose consecutive-stockout streak has hit
// `maxStockouts` (default 3): a region that stocks out that many times in a row is exhausted and is
// excluded from the exploit ranking. It is NOT dead, though — recovery is via EXPLORATION, not a timer:
// the best-scored parked region is appended as the LAST pool slot so the explore-walk can still probe
// it (and a single success resets its streak to 0). The pool is the top `topN` (4) active regions with
// that reserved parked slot. Then walk the pool from the top: at each NON-last region, with probability
// `exploreSkip` (default 0.25) skip to the next; otherwise take it. The last is always taken. So the top
// active region wins ~75%, probes cascade down, and the parked slot (last) is reached only on a full
// skip-cascade — periodic but never the exploit pick, so it can't deadlock. If EVERY region is parked,
// drop the veto and return the highest score (least-bad). `rand` injectable for tests. Never null for a
// non-empty input.
export function select(regions, now, { exploreSkip = 0.25, topN = 4, maxStockouts = 3 } = {}, rand = Math.random) {
  if (!regions || regions.length === 0) return null;
  const ranked = [...regions].sort((a, b) => b.score - a.score || (a.region < b.region ? -1 : a.region > b.region ? 1 : 0));
  const isParked = (r) => (r.consecutiveStockouts || 0) >= maxStockouts;
  const active = ranked.filter((r) => !isParked(r));
  const parked = ranked.filter(isParked);
  if (active.length === 0) return ranked[0]; // all parked → drop veto, highest score (least-bad)
  // Reserve the last pool slot for the best-scored parked region so exploration keeps probing it.
  const pool = parked.length
    ? active.slice(0, Math.max(1, topN - 1)).concat(parked[0])
    : active.slice(0, topN);
  for (let i = 0; i < pool.length; i++) {
    if (i + 1 !== pool.length && rand() < exploreSkip) continue; // skip to next (default 25%)
    return pool[i];
  }
  return pool[pool.length - 1];
}
