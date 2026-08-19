---
modified: 2026-07-06
dependencies: [llm-pipeline, worker-dispatch]
---

# Plan Orchestration

A **plan** is a multi-step LLM request (Build → Execution → Finalization) — the layer above a single [[llm-pipeline]] request when a job needs more than one model call, with branching and retry between steps. Read this before touching `functions/entry/ai/dispatch/*`, the `plan` topic, or the `@@::PASS/FAIL::@@` status marker format. Port of developit-ai's `process_context` + fan-out, fully async. Implemented in `functions/entry/ai/dispatch/{start,build,dispatch,step,finalize}.js`.

## Sensitive Areas

- **The orchestrator never blocks and never calls the LLM directly.** All LLM work is dispatched as an agent job over Pub/Sub; violating this turns the orchestrator (a Cloud Function) into a long-running process, which breaks its stateless/scale-to-zero model.
- **`cursor` compare-and-set is the only thing allowed to advance a step.** It must fire exactly once per step transition — a double-fire would dispatch the next step twice.
- **The PASS/FAIL marker parser runs while streaming**, not just at the end — an unparseable block at end-of-stream must retry the unit, never silently pass.

## Design Constraints

- Status is stored **only on the unit**; step status, job status, failure context, and loop count are always **derived**, never separately persisted (avoids the two-sources-of-truth class of bug).
- Branch via `successStep`/`failStep`, defaulting to next-in-order; a per-step **generation cap** (`MAX_GEN`) bounds correction loops so a failing step can't retry forever.
- Every run doc (planner run and step runs alike) has the **same shape**, so the dashboard can render any of them with one component.
- Runs are keyed by the **Pub/Sub message id** (assigned at publish, never minted by us) — a retry is a new message → a new run doc; the old one is soft-deleted (`isDeleted: true`) and kept so history survives.
- Config is env-var driven (`.env`/dotenv-flow, same layering as the worker) — no code release needed to change `DISPATCH_BATCH`, `MAX_ATTEMPTS`, `MAX_GEN`, `MAX_CONCURRENCY`, or `TTL_HOURS`.

## Feature Overview

Some requests can't be answered by one model call — they need a sequence of steps (e.g. plan → generate → validate → finalize), possibly with retries and branching on failure. Plan Orchestration is that layer: an orchestrator (stateless, routing-only) that fans a plan out into per-step units, dispatches each unit to the right model's topic (reusing [[llm-pipeline]]'s per-model topics), and advances the plan based on each step's self-reported PASS/FAIL verdict. It exists so that multi-step LLM workflows get the same crash-safety and idempotency as a single request ([[worker-dispatch]]'s guarantees), without the orchestrator itself ever becoming a single point of failure — it holds no LLM-call state, only routing decisions over already-durable Firestore records.

## Architecture

**Topics:**
- `plan` → orchestrator (stateless routing/decision).
- per-model topics (`config/models.js`) → agents, one per model, waker-scaled. The orchestrator routes a unit to `step.model`'s topic; the agent runs it and reports back on `plan`.
- `jobId`, minted at intake, is the correlation key on every message and record.

**Messages:**
- work (orchestrator → model topic): `{ jobId, stepId, unitId }`
- result (agent → `plan`): `{ jobId, stepId, unitId, status, reason }`

**Phases:**
1. **Build** — publish a plan-build job to the planner model's topic (`plan prompt.modelOverride ?? request.model`); the agent emits the steps; save frozen; dispatch step 1.
2. **Execution** (per step) — fan out into units → each streams into its own slot → when none are still streaming, compute pass/fail → advance (GOTO).
3. **Finalization** — no next step → complete + expire. Result = the `includeInResults` units, in order (already streamed).

**Engine** (declarative core, Prolog-style — this is the actual decision logic, not pseudocode-for-illustration):
```prolog
% BUILD
handle(start(J))         :- run_planner(J).
run_planner(J)           :- publish(model_topic(J,plan), work(J,plan,0)).
handle(created(J,Steps)) :- assert_steps(J,Steps), first_step(J,S), dispatch(J,S).

% EXECUTION
handle(result(J,S,U,fail)) :- attempts_left(J,U), !, refire(J,S,U).
handle(result(J,S,U,R))    :- record(J,S,U,R), check(J,S).

dispatch(J,S) :- new_generation(J,S,Items),
                 forall(member(U,Items), publish(model_topic(J,S), work(J,S,U))).

check(J,S) :- \+ all_done(J,S), !.
check(J,S) :- claim_advance(J,S), outcome(J,S,O), advance(J,S,O).
all_done(J,S) :- \+ unit_streaming(J,S).

advance(J,S,pass) :- forward(J,S).
advance(J,S,fail) :- under_cap(J,S), !, correct(J,S).
advance(J,S,fail) :- forward(J,S).

forward(J,S) :- target(J,S,success,N), goto(J,N).
correct(J,S) :- target(J,S,fail,N), goto(J,N).

target(J,S,success,N) :- succ_step(J,S,N), N \= null, !.
target(J,S,fail,   N) :- fail_step(J,S,N), N \= null, !.
target(J,S,_,      N) :- next_in_order(J,S,N).

goto(J,null) :- !, finalize(J).
goto(J,Next) :- dispatch(J,Next).
under_cap(J,S) :- generations(J,S,G), max_gen(M), G < M.

% FINALIZATION
finalize(J) :- complete(J), expire(J).
```
Computed, never stored: `outcome`, `all_done`, `unit_streaming`, `generations`. Effects: `publish, assert_steps, new_generation, refire, record, claim_advance, complete, expire`.

**Status marker.** `worker/steps/outcome.js` is the source of truth for this format. Delimiters: literal `@@::` at the start, `::@@` at the end — **no angle brackets**, because weak models drop `<`/`>` and markdown renderers eat `<…>` as a tag. `PASS` alone; `FAIL` adds a single-colon reason of **at least one character** (a bare `@@::FAIL::@@` is non-compliant): `@@::PASS::@@` / `@@::FAIL:<reason>::@@`. Parser: `/@@::(?:(PASS)|FAIL:\s*([\s\S]+?))\s*::@@/i` — our tweak of developit-ai's `PLAN_STATUS` block (dropped the `?!`/`!?` weak models fumble; the `@@:: … ::@@` bookend still can't false-trigger). Parsed **while streaming** (`worker/steps/outcome.js`): the visible response freezes at the opening delimiter and withholds any trailing partial of it, so a forming block never leaks into the live `response` field. Content before the block is user data; the block itself becomes the `outcome` field and feeds the orchestrator's report. Unparseable at end-of-stream → retry the unit, never a silent pass.

## Functions

- **`assert_steps`** — persists the planner's emitted step list as frozen metadata on the job doc.
- **`dispatch`** — creates a fresh generation of unit docs and publishes work messages for them.
- **`claim_advance`** — the compare-and-set that fires the step transition exactly once.
- **`refire`** — per-unit transient retry while attempts remain.
- **`finalize`** — marks the job complete and sets its TTL expiry.

## Models

Firestore, collection `llmResults`, keyed by `jobId`, TTL'd. Two ideas kept separate:

```
llmResults/{jobId}                                       # the request
  message              # original user request (input)
  status, cursor, stepCount, expireAt, createdAt         # cursor = current step + advance-once guard
  plan: [ { instructions, model, subtype, kind, count, tools, contexts,
            includeInResults, successStep, failStep }, … ]  # parsed plan = DEFINITIONS (metadata)

llmResults/{jobId}/steps/{pubsubMsgId}                   # one RUN per doc, identical shape
  step                 # "plan" | 0 | 1 …  → which plan entry this run is
  message              # the user message sent (input)
  prompt               # full assembled prompt: system + message (input)
  response             # the LLM output (the result)
  status               # streaming | complete | error
  isDeleted            # soft-delete marker; readers show only the active (non-deleted) run per step
```
The **plan** (what each step *is*) lives as metadata on the job doc; a **run** (an actual LLM call — its input + output) is a doc under `steps/`. Step/job status is derived from the active run per `step`; fanout > 1 (future) would have multiple runs share the same `step` index, distinguished by their own message-id doc.

## Use Cases

### Run a multi-step plan end-to-end, unattended

**Goal.** A caller (e.g. `/ai/plan`) gets a multi-step LLM request carried from intake to a finished result with no human in the loop.

**Stakeholders.** The requesting product surface (e.g. yeschef's meal-plan flow) and its end user, who is waiting on the final result; whoever debugs stuck jobs from the dashboard.

**Actors.** `/ai/plan` (intake, external), the planner model agent, each step's model agent, the orchestrator (`dispatch/start.js`, `build.js`, `dispatch.js`, `step.js`).

**Preconditions.** `jobId` is minted by intake; `model` names a topic present in `config/models.js`; no `plan[]` already exists on the job doc (see the pre-composed-plan alternate flow below).

**Postconditions.** The job doc's `status` is `success` (all steps terminal, none failed) and `cursor` is past the last step index; every step's result lives under `steps/{pubsubMsgId}` in the order dispatched.

**Basic Course of Events.**
1. `start.js` writes the job doc (`status: "pending"`, `message`/`userPrompt`, `model`, `type: "plan"`) and publishes a `type: "planner"` work message to the model's topic, with `report: "build"`.
2. The worker streams the planner's run into `steps/{pubsubMsgId}` (`step: "plan"`) and, on completion, publishes `action: "build"` back to `orchestrate` with that run's id.
3. `build.js` reads the planner run's `response`, unfences and YAML-parses it into `plan[]`, writes `plan`, `stepCount`, and `status: "running"` onto the job doc, and calls `dispatchStep(jobId, 0)`.
4. `dispatch.js` computes step 0's unit count from its `kind` (`fanout`/`chain` → one per item, `chunks` → `groups`, `aggregation` → 1), clears any stale prior runs for that step, sets `cursor: 0`, and publishes one work message per unit to `plan[0].model`'s topic with `report: "step"`.
5. Each unit's worker streams its response into its own `steps/{pubsubMsgId}` slot, and `worker/steps/outcome.js` parses the trailing `@@::PASS::@@` / `@@::FAIL:<reason>::@@` marker off the completed stream into that run's terminal `status`/`outcome`.
6. Each unit's worker publishes `action: "step"` to `orchestrate` on completion; `step.js` waits until every unit for that step is terminal (`unitCount(def)` reached), then — since none failed — calls `advance(...)`, which claims the `cursor` transactionally, sets `cursor: step+1`, and dispatches the next step.
7. Steps 4-6 repeat for each entry in `plan[]`. When `advance` sees `next >= stepCount`, it writes `status: "success"` (since `failedSteps` is empty) and moves `cursor` past the last step — no further dispatch occurs.

**Alternate Flows.**
- **Pre-composed plan (no planner call).** If the job doc already carries a non-empty `plan[]` when `start.js` runs (e.g. `/ai/menu` composed it deterministically), `start.js` skips steps 1-3 entirely and calls `dispatchStep(jobId, 0)` directly, so the planner model is never invoked for that job.
- **Rebuild from existing planner output (`POST /ai/rebuild`).** Skips re-running the planner: reads the existing `steps/` doc with `step: "plan"`, hard-deletes any prior executable-step runs, and re-runs `buildPlanAndDispatch` on the already-produced YAML.
- **Resume from step 0 (`POST /ai/resume/plan`).** Hard-deletes every executable-step run (keeps the planner run), clears `failedSteps`/`attempts`/`outcome`, and dispatches step 0 fresh.
- **Run from step N through the end (`POST /ai/run/:step`).** Hard-deletes runs `>= N` (a re-run must not silently no-op against the worker's idempotency guard on reused `${step}-${unit}` slot ids), trims `failedSteps`/`attempts` to `< N`, and dispatches step N with the default `report: "step"` so `step.js` cascades N → end exactly as in a fresh run, including retry/pass-through.
- **Advance one step manually (`POST /ai/resume/:step`).** An operator declares step N finished: hard-deletes runs after N, repoints `cursor` at N (so a click on an earlier frontier isn't ignored as stale), and publishes a `manual: true` `action: "step"` message so `step.js` advances unconditionally from that step.

**Exceptions.**
- **Model topic not provisioned.** If `pubsub().topic(...).publishMessage` fails with gRPC code 5 (NOT_FOUND) in `start.js` or `dispatch.js`, the job doc is set to `status: "fail"` with an explanatory `outcome` and the function returns without throwing — this is terminal (retrying can't make the topic appear) and must not become a poison-message redelivery loop.
- **Planner output doesn't parse.** If `build.js`'s YAML parse fails, or the parsed value isn't a non-empty list, `buildPlanAndDispatch` returns `{ ok: false, error }`; `build.js`'s `handle` marks both the planner run and the job doc `status: "fail"` with that `error` as `outcome`.
- **Missing plan/model definition at dispatch time.** If `plan[step]` doesn't exist, or exists without a `model`, `dispatch.js` logs an error and returns without publishing anything (no job-status write) — this indicates a malformed plan and is treated as a bug to surface via logs, not a retryable condition.
- **Stale or duplicate step reports.** `step.js` ignores any report where `job.cursor !== step` (the flow already moved past it) and only acts once every unit for the step is terminal; `advance`'s transaction re-checks `cursor === step` before writing, so a duplicate terminal report after the cursor has already moved is a no-op (covered by `step.test.js`'s "duplicate report does NOT re-finalize" case).

### Retry and pass-through a step that fails validation

**Goal.** A step whose unit(s) self-report `FAIL` gets a bounded number of automatic retries before the plan is allowed to continue rather than stall forever.

**Stakeholders.** The end user waiting on a final result (an unattended run must not hang), whoever reviews failed jobs afterward (the failure and its reason must stay visible, not be silently swallowed).

**Actors.** The step's model agent (reports `FAIL:<reason>` via the streamed marker), the orchestrator (`step.js`).

**Preconditions.** A step is the active `cursor`; at least one of its units completed streaming with a `FAIL` marker (or the worker reported `status: "fail"` outright).

**Postconditions (retry path).** `job.attempts[step]` is incremented by exactly one; a new generation of run docs exists for the retried step (old ones soft-deleted, not overwritten); `status` is `running` again.

**Postconditions (exhausted path).** The step is recorded in `job.failedSteps`; the plan continues to the next step regardless; if it's the last step, final `status` is `fail` with an `outcome` naming the failed step(s).

**Basic Course of Events.**
1. Every unit for the active step reports terminal; `step.js` finds at least one with `status: "fail"` (`failedRun`).
2. It reads `job.attempts[step]` (default 0). If it's below `MAX_GEN` (env `MAX_GEN`, default 2), it claims a retry via a Firestore transaction that re-checks `cursor === step` and the expected current attempt count — only the first sibling report to reach the transaction wins; others see the count already bumped and skip.
3. The winning caller picks a retry target: `plan[step].failStep` if it's an integer in `0..step` (a sane revert), otherwise the same step.
4. It authors a retry prompt: the target step's own `instructions`, a note that the prior attempt was rejected with the failure `reason`, and (if available) up to 1500 characters of the rejected response as a `snippet`.
5. It calls `dispatchStep(jobId, target, { attempt: attempts + 1, query: retryPrompt })`. `dispatch.js` uses `query` as the unit's message content instead of re-rendering `plan[target]` from scratch, so the worker itself has no knowledge that this is a retry — it just runs what it's handed.
6. `dispatchStep` clears the target step's prior run docs (soft-deleted by default; slots that will be reused by the same fan-out count are left alone) and re-dispatches.
7. If the retried step's units later report `PASS`, the plan proceeds via the "success" flow above.

**Alternate Flows.**
- **Retries exhausted.** If `attempts >= MAX_GEN` when a fail is observed, `step.js` skips the retry claim entirely and calls `advance(..., "passthrough-after-fail", true)` — the step is added to `job.failedSteps` and the plan advances to `step + 1` as if it had passed, so one unrecoverable step never blocks the rest of an unattended run.
- **`failStep` present but insane.** If `plan[step].failStep` is not an integer in `0..step` (e.g. missing, or pointing forward), the retry target defaults to the step itself rather than following it — per the code comment, the plan's `successStep`/`failStep` graph is not currently trusted for forward jumps, only for backward "revert" targets.

**Exceptions.**
- **Concurrent fail reports from sibling units.** The compare-and-set transaction means only one of several simultaneous fail reports for the same step actually claims and fires the retry; the rest log "already claimed — skip" and take no action, preventing a double-dispatch of the same generation.
- **No reason given.** If neither the failed run's `outcome` nor the report payload's `outcome` carries a reason, `step.js` falls back to the literal string `"(no reason given)"` so the retry prompt and logs are never blank.

### Parse a streamed self-report into a terminal PASS/FAIL

**Goal.** Determine, from a model's own streamed output, whether its unit passed or failed — without ever leaking a partial marker into the visible response the dashboard renders live.

**Stakeholders.** Anyone reading a run's live `response` field while it streams (must never see a mangled trailing fragment of the marker); the orchestrator (`step.js`), which depends on an unambiguous terminal verdict to decide advance vs. retry.

**Actors.** The model agent (emits the marker as the final tokens of its stream), the worker's streaming write path (calls `visibleResponse` per flush), the worker's completion path (calls `splitOutcome` once the stream ends).

**Preconditions.** The model has been instructed (via its prompt) to end its output with `@@::PASS::@@` or `@@::FAIL:<reason>::@@`.

**Postconditions.** The run doc's stored `response` never contains a partial or full marker; the run's terminal `status` is `"success"` (PASS) or `"fail"` (FAIL), with `outcome` set to the FAIL reason when applicable.

**Basic Course of Events.**
1. On each streaming flush, the worker calls `visibleResponse(full)` with the full text received so far.
2. If the text already contains a full opening (`@@::PASS` or `@@::FAIL`), the visible text is frozen at the character before that opening — nothing from the marker onward is ever shown live.
3. If the trailing text merely matches a prefix that could still become that opening (e.g. ends in `@`, `@@:`, `@@::F`), the visible text is frozen before that prefix too, withholding it until the next chunk resolves it one way or the other.
4. Once the stream ends, the worker calls `splitOutcome(full)` against the complete text.
5. If the full well-formed marker matches (`MARKER` regex), it returns `status: "PASS"` or `"FAIL"`, the trimmed `reason` (empty for PASS), and `clean` (the response text with the marker stripped).
6. The worker maps `PASS` → the run's terminal `status: "success"`, `FAIL` → `status: "fail"` with `outcome: reason`, and stores `clean` as the final `response`.

**Alternate Flows.**
- **FAIL with no reason supplied.** A bare `@@::FAIL::@@` (no colon-reason) does not match the strict `MARKER` regex (FAIL requires ≥1 char of reason). `splitOutcome` falls back to matching just the `OPENING`, and if the status parsed out is `FAIL` with an empty trailing reason, substitutes the literal string `"no reason given"` rather than storing an empty outcome that would read as a mystery failure.

**Exceptions.**
- **No marker at end-of-stream.** If `splitOutcome` finds neither a well-formed `MARKER` nor even an `OPENING`, it returns `status: null` and the full text as `clean`. Per the Sensitive Areas note, an unparseable block at end-of-stream must be treated as a retry candidate for the unit, never silently treated as a pass — callers must not default a `null` status to success.

## Tests

Marker parsing is tested in `worker/steps/outcome.test.js`. Dispatch-stage logic lives in `functions/entry/ai/dispatch/step.test.js`.

## UI/UX

The dashboard's plan-library view (`dashboard/pages/plan-library.vue`) and job/step viewers (`dashboard/components/JobResults.vue`, `StepForm.vue`) render these run docs — feature-level panels, not individually mocked-up. The one reusable primitive they share is [[step-status]] (the pending/running/success/fail label). See [[dashboard]] for that UI's full design.

## Dependencies

- [[llm-pipeline]] — per-model Pub/Sub topics and the Firestore result-doc pattern this reuses.
- [[worker-dispatch]] — the unit-level idempotency/ack contract each step's fan-out relies on.

## Diagrams

See the Prolog engine block in Architecture above — it is the authoritative control-flow diagram for this subsystem.

## References

- developit-ai `process_context` + fan-out (the system this is a port of) — see `worker/steps/outcome.js` header and [[prompt-library]] for the prompt-writing side of the same lineage.

## Streaming & completion

All unit docs are created up front (`streaming`); each streams into its own slot (dashboard `onSnapshot`, `seq` order) — no batch assemble. Step-done = no unit still `streaming`; advance fires once via compare-and-set on `cursor`.

## Retention

Firestore TTL on `expireAt` for `jobs`, `steps`, `units` (no cascade — set on each individually). Provisioned via `npm run setup:firestore`.
