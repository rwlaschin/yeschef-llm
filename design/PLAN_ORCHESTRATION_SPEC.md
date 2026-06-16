# Plan Orchestration Spec

Stack: Node + Ollama + Pub/Sub + Firestore. A request runs as a **plan** (list of steps):
Build → Execution → Finalization. Port of developit-ai `process_context` + fan-out, fully async.

## Rules
1. Orchestrator never blocks, never calls the LLM — all LLM work is an agent job.
2. Branch via `successStep`/`failStep`, default to next-in-order; a per-step **generation cap** bounds correction loops.
3. Status is stored only on the unit; step status, job status, failure context, and loop count are **derived**.

## Topics
- `plan` → orchestrator (stateless routing/decision).
- per-model topics (`config/models.js`) → agents, one per model, waker-scaled. Orchestrator routes a unit to `step.model`'s topic; the agent runs it and reports on `plan`.
- `jobId` minted at intake — correlation key on every message and record.

## Messages
- **work** (orchestrator → model topic): `{ jobId, stepId, unitId }`
- **result** (agent → `plan`): `{ jobId, stepId, unitId, status, reason }`

## Phases
1. **Build** — publish a plan-build job to the **planner model's** topic (`plan prompt.modelOverride ?? request.model`); the agent emits the steps; save frozen; dispatch step 1.
2. **Execution** (per step) — fan out into units → each streams into its slot → when none still streaming, compute pass/fail → GOTO. Fail under the gen cap → correct; over → forward.
3. **Finalization** — no next step → complete + expire. Result = the `includeInResults` units in order (already streamed).

## Engine
```prolog
% BUILD
handle(start(J))         :- run_planner(J).
run_planner(J)           :- publish(model_topic(J,plan), work(J,plan,0)).  % planner model = plan prompt's override ?? request model
handle(created(J,Steps)) :- assert_steps(J,Steps), first_step(J,S), dispatch(J,S).

% EXECUTION
handle(result(J,S,U,fail)) :- attempts_left(J,U), !, refire(J,S,U).   % per-unit retry
handle(result(J,S,U,R))    :- record(J,S,U,R), check(J,S).

dispatch(J,S) :- new_generation(J,S,Items),                           % fresh unit docs {gen}.{seq}
                 forall(member(U,Items), publish(model_topic(J,S), work(J,S,U))).

check(J,S) :- \+ all_done(J,S), !.                                    % a unit still streaming -> wait
check(J,S) :- claim_advance(J,S), outcome(J,S,O), advance(J,S,O).     % cursor CAS fires once
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
Computed (never stored): `outcome`, `all_done`, `unit_streaming`, `generations`.
Effects: `publish, assert_steps, new_generation, refire, record, claim_advance, complete, expire`.

## Data model (Firestore — collection is `llmResults`, keyed by `jobId`, TTL'd)

Two ideas, kept separate:
- the **plan** (definitions: what each step IS) lives as metadata on the job doc;
- a **run** (an actual LLM call: its input + output) is a doc under `steps/`.

Every run doc has the SAME shape — planner run and step runs alike — so the UI renders any of
them with one component. Runs are keyed by the **Pub/Sub message id** (the id Pub/Sub assigns
the work message on publish — no minting, no dotted ids). A retry is a NEW message → a NEW run
doc; the old one is soft-deleted (`isDeleted:true`) and kept, so history survives. The `step`
field links a run to its plan entry (`"plan"` for the planner, the 0-based index for a step).

```
llmResults/{jobId}                                       # the request
  message              # original user request (input)
  status, cursor, stepCount, expireAt, createdAt          # cursor = current step + advance-once guard
  plan: [ { instructions, model, subtype, kind, count, tools, contexts,
            includeInResults, successStep, failStep }, … ]   # parsed plan = DEFINITIONS (metadata)

llmResults/{jobId}/steps/{pubsubMsgId}                   # one RUN per doc, identical shape
  step                 # "plan" | 0 | 1 …  → which plan entry this run is
  message              # the user message sent (input)
  prompt               # full assembled prompt: system + message (input)
  response             # the LLM output (the result)
  status               # streaming | complete | error
  isDeleted            # soft-delete marker; readers show only the active (non-deleted) run per step
```
Status lives on the run; step/job status is derived from the active run per `step`. Fanout >1
(future): multiple runs share the same `step` index, distinguished by their own message-id doc.

## Streaming & completion
- All unit docs created up front (`streaming`); each streams into its own slot (dashboard `onSnapshot`, `seq` order). No batch assemble.
- Step done = no unit still `streaming`. Advance fires once via compare-and-set on `cursor`.

## Status marker
- Delimiters: literal `<@@::` at the start, `::@@>` at the end. PASS alone; FAIL adds a single-colon reason.
  - PASS → `<@@::PASS::@@>`   FAIL → `<@@::FAIL:<reason>::@@>`
  - Parser `/<@@::(PASS|FAIL)(?::\s*([\s\S]*?))?\s*::@@>/i` (our tweak of developit-ai's `PLAN_STATUS`
    block: dropped the `?!`/`!?` weak models fumble; `<@@:: … ::@@>` bookend still can't false-trigger).
- Parsed while STREAMING (`worker/steps/outcome.js`): the visible response freezes at the opening and
  withholds any trailing partial of it, so a forming block never leaks into the live `response`.
  Content before the block = user data; the block = status → `outcome` field + orchestrate report.
- Unparseable at end-of-stream → retry the unit (never a silent pass).

## Model
Topic = `prompt.modelOverride ?? request.model` (orchestrator-resolved; worker unchanged). Override used by the planner.

## Config (env vars — `.env` / dotenv-flow, like the rest of the worker; not baked into the image)
Read from `process.env` (same as `OLLAMA_NUM_CTX`, `MAX_TOOL_ROUNDS`, …). Change the env, no code release:
- `DISPATCH_BATCH` (500) — work messages published per batch
- `MAX_ATTEMPTS` (3) — per-unit transient retries
- `MAX_GEN` — per-step generation cap (loop guard)
- `MAX_CONCURRENCY` (worker) — how many step units GENERATE at once (Pub/Sub flow control + an in-process semaphore). Dev=1, prod=2. Does NOT drop work — extra units queue and still complete.
- `TTL_HOURS` (48) — `expireAt = completedAt + TTL_HOURS`

Fan-out size — and single-vs-fan-out — are decided by the plan at runtime; config only sets the ceiling.

## Retention
Firestore TTL on `expireAt` for `jobs`, `steps`, `units` (no cascade — set on each). `npm run setup:firestore`.
