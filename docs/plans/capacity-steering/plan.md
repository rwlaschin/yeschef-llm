---
modified: 2026-07-15
dependencies: [design/worker-dispatch.md, design/dashboard.md]
supersedes: null
---

# Capacity Steering Controller

## Problem
When a region's L4 pool is exhausted, jobs stall: the regional MIG retries doomed creates in its own zones and never spills to a region that has capacity (117 `ZONE_RESOURCE_POOL_EXHAUSTED` in us-central1 on 2026-07-14, zero sibling pickup). There is no signal-driven mechanism selecting which region should run workers, and no record of where/when L4 capacity actually exists.

## Solution
A prod-gated controller in the `orchestrator` codebase keeps one region's MIG autoscaler enabled (`--mode=on`) and the rest disabled (`--mode=off`), choosing the region by a 30-day sliding-window success score per region-per-daypart, reacting to enqueue and stockout events. Ships in two phases: observe-only (records + reports decisions, actuates nothing) then actuate (applies the `--mode` toggles). Durable state in Mongo; a dashboard page reads it.

## Scope

### Data model (Mongo — new)
- `region_capacity_stats` — one doc per `(region, daypart, day)`: `{ region, daypart, day, ok, fail }`. Writes are in-place `$inc` on the current day's doc (never append per-event). TTL index on `day` set to 30 days → sliding window self-prunes; total doc count bounded to `regions × dayparts × 30`.
- `region_capacity_state` — one doc per region: `{ region, mode: "on"|"off", cooldownUntil, lastSuccessTs, lastStockoutTs }`.
- `daypart` key = day-of-week × hour (e.g. `mon-14`).

### Controller (new — `functions/entry/ai/capacity/`)
- Region candidate set discovered dynamically via Compute `acceleratorTypes` list filtered to `nvidia-l4`, cached daily in Mongo. No hardcoded region list; `config/regions.js` is seed/override only.
- Score, per region for the current daypart, over in-window rows: `score = ow·Σok − fw·Σfail`. Tunable params `ow`, `fw` (only the ratio `ow/fw` affects ranking; default `ow=1.95, fw=0.95`). Empty (no rows) → `0`.
- Selection: sort regions desc by score; pick highest whose `cooldownUntil` is not in the future; if all are in cooldown, pick highest regardless.
- Events:
  - Enqueue (in the publish path, `functions/entry/ai/dispatch/`): ensure the selected region's autoscaler is `--mode=on`, others `--mode=off`.
  - Stockout: triggered off a Cloud Logging sink for `ZONE_RESOURCE_POOL_EXHAUSTED`; `$inc` `fail` on the region's current daypart doc, set `cooldownUntil`, re-run selection.
  - Success (worker completes a job): `$inc` `ok`, set `lastSuccessTs`.
- Region park uses autoscaler `--mode=off` (never `max-replicas=0`): running workers finish in-flight jobs and drain to zero via the existing idle self-shutdown. Region activate uses `--mode=on`.
- All GCE/Compute calls no-op off-GCE (guard on `K_SERVICE` / `IS_PROD`, mirroring `worker/index.js`'s idle-shutdown gate) so dev (waker + emulator) is untouched.

### Phase gate
- Phase 1 (observe-only): controller reads events, writes `region_capacity_stats`/`region_capacity_state`, and records the decision it *would* make (`wouldOpen`, `wouldPark`) to `region_capacity_state`. It issues no `--mode` calls.
- Phase 2 (actuate): the same selection output drives real `--mode` toggles. No model or scoring change between phases — only actuation is enabled.

### Dashboard (update — `yeschef-llm/dashboard`, Nuxt 3)
Visual spec: [capacity-scoreboard.html](../../mockups/capacity-scoreboard.html) (states: populated, observe-only, all-negative, day-one). Matches the dashboard's glass-morphism dark theme; status shown as number + color (never color-only).

New page reading the two Mongo collections via a Nitro server route (`dashboard/server/utils/mongo.ts`):
- Current `activeRegion` and each region's `mode` (on/off) + `cooldownUntil`.
- Daypart scoreboard: region × daypart grid of `score` (and underlying `Σok`/`Σfail`), color-scaled.
- Per-region `lastSuccessTs` / `lastStockoutTs` and sliding-window stockout count.
- Phase 1: the controller's `wouldOpen` / `wouldPark` decision for the current cycle, for review before actuation.
- Current tuning params (`ow`, `fw`, cooldown duration, window length).

### Design docs to update (when built)
- `design/worker-dispatch.md` — add the steering controller (architecture, scoring, selection, phase gate, Mongo models, dev gating).
- `design/dashboard.md` — add the capacity page.

## Parallel / Dependent Breakdown
- Parallel: Mongo model + write helpers; dynamic region discovery; scoring/selection pure function; dashboard page skeleton.
- Dependent: enqueue/stockout/success event wiring depends on the write helpers; dashboard data binding depends on the collections existing; Phase 2 actuation depends on Phase 1 shipped and its recorded decisions reviewed as correct.

## Success Criteria
- Doc count in `region_capacity_stats` is bounded (`≤ regions × dayparts × 30`) and every write is an in-place `$inc`/`$set` — no per-event append.
- `score` pure function returns: positive for net-success, negative for net-fail, `0` for empty; unit tests cover each and the all-negative and all-cooldown selection branches.
- Region candidate set is derived from the live `acceleratorTypes` query, not a hardcoded list.
- Controller code no-ops off-GCE: dev (`npm run dev`) runs unchanged with no Compute calls.
- Phase 1 deployed: dashboard shows recorded stats and `wouldOpen`/`wouldPark`; zero `--mode` calls issued (verified in logs).
- Phase 2 (post-review): during an organic central stockout, a sibling region's autoscaler goes `mode=on` and drains the queue; central is parked; `--mode` toggles appear in logs matching the recorded decision.

## Use Cases

### UC1 — Controller steers a stalled job to a region with capacity
- **Goal:** a job whose primary region is L4-exhausted runs in a region that has capacity.
- **Stakeholders:** end users (jobs complete), ops (no stall), finance (no idle spend).
- **Actors:** the capacity controller (event-driven, `functions/entry/ai/capacity/`); GCE autoscalers.
- **Preconditions:** ≥2 L4 candidate regions exist; Phase 2 (actuate) enabled; a message is enqueued.
- **Postconditions:** exactly one region's autoscaler is `mode=on`; the message is drained there; `region_capacity_stats` updated.
- **BCE:**
  1. `dispatch/` publishes a job; controller runs selection (`score` over current daypart) and sets the winner `--mode=on`, others `--mode=off`.
  2. Winner's MIG autoscaler scales up on the shared backlog; a worker drains the message.
  3. On completion, controller `$inc` `ok` on `(region, daypart, today)` and sets `lastSuccessTs`.
- **Alternate Flows:**
  - A1: All regions score ≤ 0 → step 1 picks the least-negative (highest) region.
- **Exceptions:**
  - E1: Selected region create fails with `ZONE_RESOURCE_POOL_EXHAUSTED` → stockout event `$inc` `fail`, sets `cooldownUntil`, re-runs selection; unconsumed message drives the next region's autoscaler.
  - E2: All regions in cooldown → selection drops the cooldown veto and picks highest score.

### UC2 — Ops reviews capacity behavior on the dashboard
- **Goal:** an operator sees where/when L4 capacity exists and what the controller decided.
- **Stakeholders:** ops, engineering.
- **Actors:** operator; Nuxt dashboard; Nitro server route.
- **Preconditions:** Phase 1 or later deployed; `region_capacity_*` populated.
- **Postconditions:** none (read-only).
- **BCE:**
  1. Operator opens the capacity page; the Nitro route reads `region_capacity_state` + aggregates `region_capacity_stats`.
  2. Page renders active region, per-region mode/cooldown, the daypart scoreboard, and (Phase 1) `wouldOpen`/`wouldPark`.
- **Alternate Flows:**
  - A1: A region has no rows for a daypart → grid cell shows `0`/unknown, not a failure.
- **Exceptions:**
  - E1: Mongo unreachable → page shows an error state, no crash.

## Testing Requirements
- **Unit (new, `functions/entry/ai/capacity/*.test.js`, `node --test` convention):** `score` returns positive/negative/`0` for net-success/net-fail/empty; selection sorts desc and picks highest non-cooldown; all-cooldown branch picks highest overall; all-negative branch still returns a region. Covers UC1 A1/E2.
- **Integration against an injected fake Compute client (no GCP):** enqueue event sets exactly one region `mode=on` and the rest `off`; a synthetic `ZONE_RESOURCE_POOL_EXHAUSTED` event `$inc`s `fail`, sets `cooldownUntil`, and re-selects. Covers UC1 E1.
- **Dev-gate test:** with GCE env absent, event handlers issue no Compute calls (fake client records zero calls).
- **Dashboard:** Nitro route returns the aggregated shape from seeded Mongo; page renders active region + scoreboard from fixture data; Mongo-unreachable path renders the error state (UC2 E1).
- **No forced-stockout E2E** (no staging GCP project exists): Phase 2 is validated by observing an organic production stockout against the Success Criteria, not by manufacturing one in prod.
