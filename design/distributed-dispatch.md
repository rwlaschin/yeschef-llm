# Distributed unit dispatch — leaseless, idempotent, at-least-once

## Principle

Workers run on spot instances. **Any worker is guaranteed to die before some
units finish.** So no design may depend on a single process owning a unit from
start to completion. There is **no lease, no holder, no global `active`
counter** — nothing persistent that a crash can leak or strand.

Correctness rests on exactly one primitive: **first-writer-wins completion.**
Everything else (capacity, dedup, recovery) is emergent or advisory.

> Terminal-status names below (`done`/`failed`) are generic. In this codebase the run-slot
> vocabulary is **`success`/`fail`** (what the orchestrator's terminal check reads) — `done` ≡
> `success`, `failed` ≡ `fail`. The give-up decision is the orchestrator's (`attempts[step]` →
> `MAX_GEN` → passthrough), so the worker writes `success`/`fail`, acks, and reports; it never
> nack-retries or keeps its own give-up counter. Implemented in `worker/admission.js` (pure,
> unit-tested) + `worker/index.js`.

## Components

- **One topic + one subscription per model** (unchanged).
- **N worker instances per model**, all subscribed — competing consumers.
- **Firestore** `llmResults/{job}/steps/{unit}` — the unit slot: `status`,
  `result`, `attempts`, `lastError`, `updatedAt`. This is the only shared state.
- **Dead-letter topic per model** + a **dead-letter consumer** (see below).
- Per-instance Pub/Sub flow control `maxMessages = 1` — a worker only pulls
  what it can actually run.

## Message

```
{ jobId, step, unit, def… }        // identity of the WORK, stable across redelivery
```

No lease id, no attempt count in the message. Identity = `(jobId, step, unit)`,
immutable. Attempt accounting lives in Firestore, not the envelope.

## Worker: receive(message)

```
1. parse. malformed -> ack + dead-letter-mark (see DLQ)   // poison, don't loop
2. read slot.
     status in {done, failed} -> ack, return   // already terminal — don't re-run
3. RUN the generation. No claim, no lease. A concurrent duplicate run is
   possible (rare: redelivery overlapping a still-running attempt). That is
   wasted compute, NOT corruption — completion is idempotent.
4. completion, in ONE transaction (the transaction IS the CAS):
     slot = tx.get(ref)
     if slot.status in {done, failed} -> return TERMINAL  // idempotent guard; ack, no write
     on SUCCESS                   -> tx.set(status=done, result); ack
     on FAILURE                   -> n = (attempts||0)+1
                                     if n >= MAX -> tx.set(status=failed, attempts=n, lastError); ack
                                     else        -> tx.set(status=error,  attempts=n, lastError); nack
```

- `done` and `failed` are both terminal and idempotent: the first writer wins,
  every later duplicate sees a terminal status and no-ops.
- **No explicit `version` field.** Firestore `runTransaction` tracks the
  update-time of every doc read and aborts+retries on a concurrent commit, so
  the `status == done` check is the compare and the txn engine is the swap. If
  two workers race, one commits against the read snapshot; the other aborts,
  re-reads, sees `done`, and bails — the late writer never clobbers. An explicit
  `version`/`updateTime` precondition is only needed if you ever write OUTSIDE a
  transaction.
- A genuine generation **failure** bumps `attempts` **only when work actually
  ran** — never on preemption/redelivery. This is what separates a poison unit
  from an unlucky one.

## ack / nack / redelivery

| Outcome | Action | Why |
|---|---|---|
| Success | **ack** | done, idempotent |
| Already `done` (duplicate) | **ack** | nothing to do |
| Transient in-handler error, `attempts < MAX` | **nack** | fast retry |
| Real failure, `attempts >= MAX` | mark `failed`, **ack** | semantic give-up |
| Crash / preemption mid-run | (no ack) | Pub/Sub redelivers → another worker runs it |
| Capacity backpressure | not nacked | handled by backlog, not by burning delivery count |

**Crash recovery is just redelivery.** The message was never acked, so the
connection drop returns it to the subscription; another instance runs it.
Nothing to reclaim, nothing to compensate.

## Capacity is emergent, not enforced

Nobody sets "max N concurrent." Each instance does 1 generation at a time
(Ollama serializes) and pulls 1 message at a time. Unpulled work waits durably
in the **subscription backlog** — that backlog *is* the queue. The **MIG
autoscaler scales on backlog depth**: backlog grows → add instances → drains →
scale down. Fleet concurrency = number of living instances, a side effect, with
no shared number to leak. A dead instance simply stops pulling.

*Optional* explicit cap below fleet-max (cost control only): a re-admit delay
queue — publish a delayed clone + ack the original, jittered backoff
(`uniform(0.8d, 1.2d)`, ~5/10/30/30s) — gated on an observable signal
(backlog/rate), **never** on a held token. Default: don't; let capacity emerge.

## Give-up is semantic, NOT delivery count

Pub/Sub's `maxDeliveryAttempts` counts **every** delivery, including healthy
redeliveries caused by spot preemption. If it were the give-up authority, a
perfectly good unit preempted N times would dead-letter while never having
failed. So:

- **Give-up = Firestore `attempts`**, incremented only on a generation that ran
  and failed. At `attempts >= MAX` the worker writes `status=failed` and acks.
  The orchestrator sees the terminal state and fails the step / passes through.
- **Pub/Sub dead-letter is a transport backstop only** — set
  `maxDeliveryAttempts` high (e.g. 50). It catches messages that can never reach
  a clean terminal write (unparseable payload, repeated crash before any
  Firestore write), not normal failures.

## Dead-letter

Nothing is attached to the dead-letter topic. It is the **natural terminal
sink** — messages flow there on their own when transport delivery is exhausted,
and they rest there for manual inspection. No consumer, no disposition logic.

The job never depends on the DLQ to advance: **semantic give-up already handles
that.** When a unit truly fails, the worker writes `status=failed` and acks
(see above), and the orchestrator sees the terminal state and proceeds. So a
message only reaches the dead-letter topic when it could never reach a clean
terminal write at all (unparseable payload, repeated crash before any Firestore
write). Those are genuinely stuck; letting them flow to the DLQ and stop there —
off the main subscription, inspectable later — is the correct outcome.

## Explicitly accepted tradeoff

Duplicate **concurrent** runs of one unit are possible when a redelivery
overlaps a still-running attempt. We do not prevent them — preventing them is
the lease-holder trap that fails on spot. We make them harmless (idempotent CAS)
and *reduce* their frequency with per-instance `maxMessages=1`.

## Progress condition

A unit makes progress iff it can finish **within one instance's lifetime**
(spot mean-time-to-preemption). If gen-time can exceed that, the unit will be
killed and re-run forever. Mitigate by chunking units smaller, or by
checkpoint+resume (a reclaimer continues from streamed partial output). The
dispatch layer cannot fix work that outlives its worker.

## Dev / emulator note

The Pub/Sub emulator ignores client lease extension and over-delivers across
StreamingPull resets. Under this design that only causes extra *duplicate runs*
(harmless via idempotent CAS) — never corruption. `maxMessages=1` still limits
what each dev worker pulls. No emulator-specific code path needed.
