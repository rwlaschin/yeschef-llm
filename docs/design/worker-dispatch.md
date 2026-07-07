---
modified: 2026-07-06
dependencies: []
---

# Worker Dispatch

Distributed unit dispatch for the worker fleet — leaseless, idempotent, at-least-once. Read this before touching `worker/admission.js`, `worker/semaphore.js`, ack/nack timing, or anything about retries/crash-recovery. Implements the low-level correctness primitive that [[llm-pipeline]]'s "spot instance resilience" section relies on.

## Sensitive Areas

- **The completion write is the single correctness boundary.** It must always be a transaction (the transaction *is* the compare-and-swap). Writing status outside a transaction reintroduces the race this design exists to prevent.
- **Ack timing.** A message must never be acked before the terminal Firestore write completes — acking early converts a real crash into silent data loss (Pub/Sub won't redeliver a message that's already been acked).
- **`attempt` is bumped only by the orchestrator, on a genuine retry** — the worker never increments it itself, whether on preemption, redelivery, or a duplicate concurrent run. Conflating "redelivered" with "retried" would let a healthy spot-preempted unit look like a new attempt when it's still the same one.

## Design Constraints

- Workers run on **spot instances**; any worker is guaranteed to die before some units finish. No design may depend on a single process owning a unit start-to-finish.
- **No lease, no holder, no global `active` counter** — nothing persistent that a crash can leak or strand.
- Correctness rests on exactly one primitive: **first-writer-wins completion.** Capacity, dedup, and recovery are emergent or advisory, never enforced state.
- Per-instance Pub/Sub flow control `maxMessages = 1` — a worker only pulls what it can actually run.
- Terminal-status vocabulary in this codebase is `success`/`fail` (generic `done`/`failed` elsewhere in this doc are the same concepts).

## Feature Overview

Ollama workers run on preemptible spot GPU VMs, so any worker can die mid-unit at any moment — there is no safe way to assume a worker that started a unit will finish it. This design makes that fact irrelevant to correctness: instead of a lease/holder model (which leaks state when its holder dies), completion is decided by a single atomic transaction per unit, and everything else — which worker picks up a redelivered message, how many run concurrently — is left to emerge from Pub/Sub's own redelivery and backlog mechanics. The payoff is a dispatch layer with zero crash-recovery code: a crash is just "the message wasn't acked," and redelivery *is* the recovery.

Implemented in `worker/admission.js` (pure, unit-tested in `admission.test.js`) + `worker/index.js`.

## Architecture

**Components:**
- One topic + one subscription per model (unchanged from [[llm-pipeline]]).
- N worker instances per model, all subscribed — competing consumers.
- **Firestore** `llmResults/{job}/steps/{unit}` — the unit slot (`status`, `response`, `attempt`, `outcome`, `createdAt`, `updatedAt`, `completedAt`). This is the *only* shared state.
- A dead-letter topic per model (no consumer — see below).

**Message shape** (identity of the work, plus the attempt number the orchestrator owns):
```
{ jobId, step, unit, attempt, def… }
```
`attempt` rides the message — `0` on first dispatch, bumped by the orchestrator each time it re-publishes a retry. It is also stored on the slot, where it's the discriminator `shouldRun`/`completionWrite` use to tell a genuine retry (higher `attempt`) apart from a stale duplicate delivery of an attempt already finished. There is no separate lease id — Pub/Sub redelivery of the *same* message carries the *same* `attempt`, and that's exactly the case the CAS is designed to tolerate.

**Worker receive(message):**
```
1. parse. malformed -> nack                              // poison; the ONE path still driven by
                                                           // Pub/Sub redelivery/maxDeliveryAttempts
2. attempt = message.attempt || 0
3. in ONE transaction ("receive claim" — atomic so a stale attempt can't slip
   between read and write):
     slot = tx.get(ref)
     if !shouldRun(slot, attempt) -> no-op                // terminal for this attempt, or a
                                                           // newer attempt already owns the slot
     else -> tx.set(status=running, attempt, outcome=null, completedAt=null, ...)
              // clears the PRIOR attempt's outcome/completedAt: running ⇒ no outcome
   if !willRun -> ack, return                             // already terminal/superseded, no-op
4. RUN the generation. No claim, no lease. A concurrent duplicate run is
   possible (redelivery, or a duplicate, overlapping a still-running attempt)
   — that's wasted compute, NOT corruption; completion is idempotent.
5. completion, in ONE transaction (the transaction IS the CAS):
     slot = tx.get(ref)
     w = completionWrite(slot, { attempt, status, response, outcome })
     if w === null -> no-op                                // superseded by a newer attempt, or
                                                            // this/newer attempt already terminal
     else -> tx.set(status=w.status, attempt=w.attempt, response, outcome, updatedAt, completedAt)
6. on thrown error (any point after the claim) -> run the SAME completion CAS
   with { attempt, status: "fail", outcome: err.message }
7. ALWAYS ack — win, lose, succeed, or fail. The worker never nacks past step 1.
   Retry is entirely orchestrator-driven: it observes the `fail` report and
   publishes a fresh message for the same jobId/step/unit with attempt+1.
```

No explicit `version` field is needed: Firestore `runTransaction` tracks each read doc's update-time and aborts+retries on a concurrent commit, so the attempt/status check inside the transaction *is* the compare, and the transaction engine *is* the swap. If two workers race, one commits against its read snapshot; the other aborts, re-reads, sees the winner's write, and bails — the late writer never clobbers. An explicit precondition field would only be needed for writes made *outside* a transaction.

## Functions

- **`shouldRun(slot, attempt)`** — gates the receive: returns `false` (ack, no-op) if `slot` is owned by a newer attempt, or if this exact `attempt` is already terminal. Returns `true` otherwise — including a `running` slot for the same attempt, since the dispatch layer can't tell a dead owner from a live one.
- **`completionWrite(slot, { attempt, status, response, outcome })`** — the first-writer-wins CAS body described above; returns the fields to write, or `null` to no-op (superseded by a newer attempt, or already terminal for this/a newer attempt). The only function allowed to decide a slot's move into `success`/`fail`. Used identically for both the success path and the `catch` block's failure write.

## Models

Unit slot: `llmResults/{job}/steps/{unit}` → `{ status, response, attempt, outcome, createdAt, updatedAt, completedAt }`.

| Outcome | Action | Why |
|---|---|---|
| Success | ack | terminal write won the CAS |
| Already terminal for this attempt (duplicate) | ack | nothing to do |
| Superseded by a newer attempt | ack | a retry already overtook this delivery |
| Genuine failure (thrown error) | mark `fail` via the CAS, ack | orchestrator decides retry, not Pub/Sub |
| Crash/preemption mid-run | (no ack) | Pub/Sub redelivers → another worker runs it |
| Malformed payload | nack | the one path still relying on Pub/Sub redelivery |
| Capacity backpressure | not nacked | handled by backlog, not by burning delivery count |

## Use Cases

### Use Case 1: Redelivery takes over a unit abandoned by a preempted worker

- **Goal.** Get a unit to a terminal result (`success`/`fail`) even though the spot instance that started it can die at any moment, with no explicit recovery step.
- **Stakeholders.** The orchestrator waiting on the step to advance ([[plan-orchestration]]); the end user waiting on the job; platform ops paying for spot capacity.
- **Actors.** Worker instance A (dies mid-run); worker instance B (competing consumer on the same subscription, receives the redelivery); Pub/Sub (redelivers an unacked message); Firestore (holds the unit slot).
- **Preconditions.** A unit's Firestore slot at `llmResults/{job}/steps/{unit}` does not yet hold a terminal status for the message's `attempt`. Worker A has received the message and is subscribed with `maxMessages=1`.
- **Postconditions.** The slot reaches a terminal `status` (`success` or `fail`) written by exactly one worker's completion transaction; the message is acked; the orchestrator is notified via the `orchestrate` topic.
- **Basic Course of Events.**
  1. Worker A receives the message and, inside one Firestore transaction, reads the slot and calls `shouldRun(slot, attempt)`.
  2. `shouldRun` returns `true` (no slot yet, or an older/no attempt already there) — the same transaction writes the slot to `status: "running"` for this `attempt` (`handleMessage`'s "receive claim" transaction in `worker/index.js`).
  3. Worker A begins generation via `chatRound`/`chatWithTools`. The GCE spot instance is preempted before the run finishes; the process dies with the message never acked.
  4. Pub/Sub's lease on the unacked message expires and redelivers it to worker B (a competing consumer on the same subscription).
  5. Worker B runs the same "receive claim" transaction: the slot is `running` for this same `attempt`, and `shouldRun` still returns `true` — a `running` slot for the same attempt is not a skip, because the worker that set it may be dead.
  6. Worker B runs the generation, then writes completion inside `completionWrite`'s transaction: the slot is not yet terminal for this/any newer attempt, so the write lands — `status: "success"` (or `"fail"`), `response`, `outcome`, `updatedAt`, `completedAt`.
  7. Worker B acks the message and, since it was the one that actually wrote (`wrote === true`), calls `reportToOrchestrator`.
- **Alternate Flows.** If worker A's redelivery had instead landed back on worker A itself (a lease-extension race rather than a true crash), the same steps 5–7 apply identically — the mechanism doesn't distinguish "different worker" from "same worker, second delivery."
- **Exceptions.** If worker A did *not* actually die but is still running when B's redelivery lands (a live overlap, not a crash), both A and B may complete concurrently — see Use Case 3. If the message payload itself is unparseable, `handleMessage`'s `JSON.parse` throws before any slot read; the current code nacks that message (see `worker/index.js`'s parse-failure branch), which is the one path in the implementation that still relies on Pub/Sub redelivery/`maxDeliveryAttempts` rather than an attempt-based retry.

### Use Case 2: Orchestrator retries a unit that failed for real

- **Goal.** Re-run a unit that genuinely failed (not one that was merely preempted), without the dispatch layer itself needing to track a failure count.
- **Stakeholders.** The orchestrator, which owns the retry policy ([[plan-orchestration]]); the end user, whose job should not wedge on one bad unit; platform ops, who need failures to be distinguishable from healthy preemption in logs/metrics.
- **Actors.** A worker instance; the orchestrator (publishes the retry message with a bumped `attempt`); Firestore.
- **Preconditions.** A prior attempt for the unit reached a genuine terminal `fail` (e.g. a real generation error, a stall/timeout, a terminal tool failure) — recorded via the "fail status" completion transaction in `handleMessage`'s `catch` block, with `attempt` equal to the failed attempt's number.
- **Postconditions.** Either the unit reaches `status: "success"` on the new attempt, or it reaches `status: "fail"` again on the new attempt (still eligible for a further orchestrator-driven retry, subject to whatever retry policy the orchestrator enforces — that policy is out of scope for this doc).
- **Basic Course of Events.**
  1. A worker's `handleMessage` catches an error (e.g. `chatRound` throws after the idle/first-chunk watchdog aborts, or a step builder throws a `TerminalError`).
  2. The worker runs the "fail status" completion transaction: `completionWrite(slot, { attempt, status: "fail", outcome: err.message })` succeeds because the slot isn't already terminal for this/a newer attempt, and the slot is written `status: "fail"`, `outcome: err.message`.
  3. The worker acks the message unconditionally (`message.ack()` in the `catch` block — this worker never nacks) and reports the failure to the orchestrator via `reportToOrchestrator` with `runStatus: "fail"`.
  4. The orchestrator decides to retry and publishes a new message for the same `jobId`/`step`/`unit` with `attempt` incremented by one.
  5. A worker (any competing consumer) receives the new message. `shouldRun(slot, attempt)` reads the old slot (`status: "fail"`, lower `attempt`) and returns `true`, because the delivered `attempt` is newer than the slot's stored `attempt`.
  6. The worker marks the slot `running` for the new `attempt` — the "running mark" clears the previous attempt's `outcome`/`completedAt` fields (`running ⇒ no outcome` invariant) so the UI never shows a stale failure reason next to a live run.
  7. Generation runs again; on success, `completionWrite` writes `status: "success"` for the new `attempt`, overwriting the old failed slot.
- **Alternate Flows.** If the retried attempt fails again, steps 2–3 repeat with the incremented `attempt`, and the orchestrator may retry again or give up per its own policy (see [[plan-orchestration]] — give-up/max-retry logic is the orchestrator's, not this dispatch layer's).
- **Exceptions.** If a stale, older-`attempt` message for this unit arrives after the retry already completed (e.g. a very late redelivery of the original failed attempt's message), `shouldRun` sees the slot owned by a newer `attempt` and returns `false` — the worker acks it as a no-op without running anything, so the late message can't clobber the retry's result.

### Use Case 3: A redelivered duplicate overlaps a still-running attempt

- **Goal.** Tolerate two workers concurrently generating for the same unit without corrupting the result or double-reporting to the orchestrator.
- **Stakeholders.** Platform ops (accepts the wasted compute as a cost tradeoff); the orchestrator (must be notified exactly once per unit).
- **Actors.** Worker instance A and worker instance B, both live and both running the same `jobId`/`step`/`unit`/`attempt`.
- **Preconditions.** Worker A has claimed the slot (`status: "running"`) and is still actively generating when a redelivery of the same message (or a concurrent duplicate delivery) reaches worker B before A acks.
- **Postconditions.** The slot ends up with exactly one terminal write; both workers ack; the orchestrator is notified exactly once.
- **Basic Course of Events.**
  1. Worker B's "receive claim" transaction reads the slot as `running` for the same `attempt` it was delivered. `shouldRun` returns `true` (a same-attempt `running` slot is not treated as a skip, since the dispatch layer has no way to distinguish "owner is dead" from "owner is alive and slow").
  2. Worker B also begins generation for the same unit, concurrently with worker A.
  3. Both workers eventually attempt the completion transaction (`completionWrite`) at roughly the same time.
  4. Firestore's `runTransaction` optimistic concurrency means only one commit lands cleanly against its read snapshot; the other's transaction retries, re-reads the now-terminal slot, and `completionWrite` returns `null` (already terminal for this attempt).
  5. The winning worker's `wrote` flag is `true`: it calls `reportToOrchestrator` and acks.
  6. The losing worker's `wrote` flag is `false`: it does **not** call `reportToOrchestrator` (the comment in `worker/index.js` is explicit: "Only the WINNER reports — a lost race means another run already told the orchestrator"), but it still acks, logging the completion as a no-op.
- **Alternate Flows.** The same mechanics apply if it's the "fail status" transaction that races instead of the success path — whichever worker's transaction commits first wins the write and reports; the other's `completionWrite` returns `null` and it acks silently.
- **Exceptions.** None beyond the race itself — this is treated as expected, harmless behavior (see "Explicitly accepted tradeoff" above), not an error condition.

### Use Case 4: Fleet capacity emerges from backlog depth, not a held counter

- **Goal.** Run as many units concurrently as the live fleet can support, without any process owning a global concurrency count that could be stranded by a crash.
- **Stakeholders.** Platform ops (controls cost via fleet size); the orchestrator (dispatches fanout units without needing to know current capacity).
- **Actors.** N worker instances, each independently pulling from the same per-model subscription; the GCE MIG autoscaler; the in-process generation gate (`worker/semaphore.js`, `genGate` in `worker/index.js`).
- **Preconditions.** One or more units for a model are enqueued on that model's subscription.
- **Postconditions.** All enqueued units are eventually processed; at no point does any single process hold a lease/token whose loss would strand capacity.
- **Basic Course of Events.**
  1. The orchestrator publishes one message per fanout unit to the model's topic.
  2. Each live worker instance is subscribed with Pub/Sub flow control `maxMessages` (1 in dev, 2 in prod by default, tunable via `MAX_CONCURRENCY`) — it only pulls what it's configured to run at once.
  3. Within a single instance, `handleMessage` additionally acquires the in-process `genGate` semaphore (sized to `OLLAMA_NUM_PARALLEL`, the Ollama server's actual run-slot count) before starting generation, so a redelivery or dev-emulator over-delivery can't run more concurrent generations than Ollama has slots — the excess queues in-process while its Pub/Sub lease auto-extends.
  4. Units beyond what the live fleet can currently pull simply sit unacked in the subscription's backlog — this backlog *is* the queue; no separate queueing system exists.
  5. The MIG autoscaler observes backlog depth and adds worker instances; newly-started instances subscribe and begin pulling from the same backlog.
  6. As units complete (Use Case 1's terminal-write flow), the backlog drains; the autoscaler can then scale instances back down.
- **Alternate Flows.** Nobody sets an explicit "max N concurrent units" for the fleet — total concurrency is just however many instances are alive multiplied by each instance's `maxMessages`/`genGate` limit, an emergent property rather than an enforced one.
- **Exceptions.** If a worker instance is terminated (preemption or scale-down) while holding leased-but-unacked messages, nothing is stranded: Pub/Sub redelivers those messages to the remaining fleet exactly as in Use Case 1 — there is no separate capacity-accounting state to reconcile on instance loss.

## Tests

`worker/admission.test.js` — unit tests for `shouldRun`/`completionWrite` (pure functions, no real Firestore/Pub/Sub). `worker/semaphore.test.js` covers the in-process generation concurrency gate.

## UI/UX

Not applicable — this is a backend dispatch primitive with no UI surface of its own.

## Dependencies

None — this is a foundational primitive that [[llm-pipeline]] and [[plan-orchestration]] both build on.

## Diagrams

See the `receive(message)` pseudocode in Architecture above — that state machine is the diagram; there is no separate flow chart.

## References

- Firestore `runTransaction` semantics (optimistic concurrency via read update-time).
- Google Cloud Pub/Sub dead-letter topics and `maxDeliveryAttempts`.

## Explicitly accepted tradeoff

Duplicate **concurrent** runs of one unit are possible when a redelivery overlaps a still-running attempt. This is not prevented — preventing it is the lease-holder trap that fails on spot. It's made harmless (idempotent CAS) and *reduced* in frequency by per-instance `maxMessages=1`.

## Progress condition

A unit makes progress iff it can finish within one instance's lifetime (spot mean-time-to-preemption). If generation time can exceed that, the unit will be killed and re-run forever — mitigate by chunking units smaller, or checkpoint+resume (a reclaimer continuing from streamed partial output). The dispatch layer cannot fix work that outlives its worker.

## Dev / emulator note

The Pub/Sub emulator ignores client lease extension and over-delivers across StreamingPull resets. Under this design that only causes extra *duplicate* runs (harmless via idempotent CAS), never corruption. `maxMessages=1` still limits what each dev worker pulls; no emulator-specific code path is needed.
