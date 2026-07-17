---
modified: 2026-07-15
dependencies: [plan.md]
---

# Capacity Steering — Tasks

Ordered by dependency; persona noted per task.

## Phase 1 — observe-only

1. **[Test Engineer]** Write unit tests for `score(ow, fw, rows)` and `select(regions, now)` — positive/negative/empty score, sort-desc pick, all-cooldown and all-negative branches.
2. **[Full-stack]** Mongo layer: `region_capacity_stats` (`(region,daypart,day)`, `$inc` writes, 30-day TTL index on `day`) and `region_capacity_state` docs + write helpers (`incOk`, `incFail`, `setCooldown`, `setState`).
3. **[Full-stack]** `score` + `select` pure functions (no I/O), passing task 1.
4. **[Architect → Full-stack]** Dynamic region discovery: Compute `acceleratorTypes` list filtered to `nvidia-l4`, cached daily in Mongo; `config/regions.js` demoted to seed/override.
5. **[Full-stack]** Event handlers, GCE-gated (`K_SERVICE`/`IS_PROD`), **observe-only**: enqueue + success + stockout update Mongo and record `wouldOpen`/`wouldPark`; issue NO `--mode` calls. Stockout handler fed by a `ZONE_RESOURCE_POOL_EXHAUSTED` log sink.
6. **[Test Engineer]** Integration tests vs injected fake Compute client: enqueue/stockout paths update Mongo and record decisions; dev-gate test asserts zero Compute calls off-GCE.
7. **[Full-stack]** Dashboard: Nitro route aggregating the two collections; capacity page (active region, per-region mode/cooldown, daypart scoreboard, `wouldOpen`/`wouldPark`, tuning params).
8. **[Test Engineer]** Dashboard tests: route shape from seeded Mongo; page render from fixture; Mongo-unreachable error state.
9. **[Full-stack]** Deploy Phase 1 via `npm run deploy`; verify logs show zero `--mode` calls and the dashboard populates.
10. **[Human/Ops]** Review `wouldOpen`/`wouldPark` against real traffic until decisions are correct. **Gate to Phase 2.**

## Phase 2 — actuate (after task 10 sign-off)

11. **[Full-stack]** Enable actuation: selection output drives real `--mode=on`/`off` toggles (park via `mode=off`, activate via `mode=on`). No scoring/model change.
12. **[Test Engineer]** Integration test vs fake Compute client: selection → exactly one `mode=on`, rest `off`; re-select on stockout event.
13. **[Full-stack]** Deploy Phase 2; observe next organic central stockout — confirm a sibling goes `mode=on` and drains, central parked, toggles match recorded decision.
14. **[Technical Writer]** Fold into `design/worker-dispatch.md` + `design/dashboard.md`; delete this plan (per docs lifecycle).
