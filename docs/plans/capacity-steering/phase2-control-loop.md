# Phase 2 — MIG Control Loop

## Principle
**The controller (orchestrator) is the brain.** It performs *every* calculation — score, selection,
mode decisions — and **writes the results to Mongo**. The dashboard is a **dumb display**: it reads
`region_capacity_state` / `region_capacity_stats` and renders; it computes **nothing**. (This
reverses the stopgap where the dashboard computed `wouldOpen` live — that logic moves back to the
controller.)

## The job (user's words)
Start boxes to handle the message queue, and optimize restarts — reuse a live worker for the next
message instead of booting another.

## Data the controller needs
| Input | Source | Meaning |
|---|---|---|
| Queue depth per model | Pub/Sub `num_undelivered_messages` | demand waiting now |
| Running/busy workers per region | GCE MIG `size` / instance list | capacity in flight |
| Region score per daypart | `region_capacity_stats` (ok/fail) | where an L4 box can be gotten |
| Cooldowns | `region_capacity_state.cooldownUntil` | regions that just stocked out |

## When it calculates + writes (every relevant event, not once-and-cached)
| Trigger | Recompute | Write to DB |
|---|---|---|
| **Enqueue / detect** | score all regions (current daypart), select winner | `wouldOpen`/`wouldPark`; **Phase 2:** set winner `mode=on`, others `off` → `activeRegion` |
| **Job DONE (ok)** | inc ok; re-select | `ok++`, `lastSuccessTs`; refreshed `wouldOpen` |
| **Stockout (fail)** | inc fail; set cooldown; re-select | `fail++`, `cooldownUntil`, `lastStockoutTs`; refreshed `wouldOpen` |
| **Job finishes + queue not empty** | keep the freed worker; suppress a new MIG start | (reuse decision) |
| **Queue empty** | let workers idle-shutdown to 0 | — |

Every event ends by **writing the current answer to the DB**, so the UI always reflects reality
without computing anything.

## How it controls the MIGs — DIRECT INVENTORY, NO AUTOSCALERS
The manager does NOT use GCE autoscalers and does NOT pick a single PRIMARY region. Autoscaling on the
shared backlog can't achieve "use all regions together with the fewest machines" — it just races every
region for each message. Instead the manager keeps an explicit desired-box count (`avail`) per region
and sets each MIG's size itself.

The loop:
```
need capacity (queue has waiting work):
  pick best region (score/explore order, skip parked) → avail[region] += 1   (set MIG size +1)
  stockout:
    streak[region] += 1                (LEAVE avail — the MIG keeps retrying the boot itself;
                                        do NOT churn avail 1→0→1)
    if streak[region] >= 3:            (3 stockouts IN A ROW → give up on this region)
      avail[region] -= 1               (the ONLY decrement on the stockout path)
      PARK region, cascade → pick NEXT region → avail += 1
    # streak < 3 → do nothing, let the MIG retry in place
  box starts / any success → streak[region] = 0
on 'done' signal:
  DELETE that specific finished instance (targeted, never a busy box) → avail[region] -= 1
```
KEY: `avail` is only reduced twice — once when a region is abandoned at its 3rd straight stockout, and
once per completed job. Never on stockouts 1–2 (that would cancel the MIG's own create-retry and churn).
Net: exactly enough boxes for the queue, spread across whichever regions have capacity, requiring **3
stockouts in a row** before abandoning a region, released on done. All regions used together, never
over-provisioned. Scoring / explore-exploit / the 3-stockout streak set the ORDER regions are tried for
each `+1` — they are NOT an autoscaler policy.

## Gaps to close (from current state)
1. **`ok`-side re-decide + `lastSuccessTs`:** `ok` is recorded in the worker (`recordCapacityOk`),
   which never touches `region_capacity_state` and can't trigger a controller recompute. Fix: worker
   emits a lightweight outcome event → orchestrator records ok, stamps `lastSuccessTs`, re-decides.
2. **`mode`/`activeRegion`:** nothing writes these (Phase 1 issues no `--mode`). The control loop
   above is what produces them.
3. **Revert dashboard-live-compute:** once the controller keeps `wouldOpen` fresh on every event, the
   dashboard reads the stored value again (no computation in the view).

## Success (checkable)
- Fire a request → within the decision cycle, `region_capacity_state` shows a **fresh** `wouldOpen`,
  `mode=on` on exactly one region, `activeRegion` set — all **written by the controller**, read
  verbatim by the UI.
- A stockout flips `mode` off that region and on another, visible in the DB + UI, `--mode` calls in
  the logs.
- Two queued messages drain on **one** box (reuse), not two — verified by instance count.
