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

// Pick the region to open. Sort desc by score (ties → region name asc, deterministic); return the
// highest whose cooldown has expired (cooldownUntil null/absent or ≤ now). If EVERY region is still
// in cooldown, drop the veto and return the highest score overall (least-bad). Never null for a
// non-empty input.
export function select(regions, now) {
  if (!regions || regions.length === 0) return null;
  const ranked = [...regions].sort((a, b) => b.score - a.score || (a.region < b.region ? -1 : a.region > b.region ? 1 : 0));
  const available = ranked.find((r) => r.cooldownUntil == null || r.cooldownUntil <= now);
  return available || ranked[0];
}
