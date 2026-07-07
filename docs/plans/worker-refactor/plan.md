---
modified: 2026-07-06
supersedes: null
---

# Worker Refactor

## Problem

`worker/index.js` mixes five unrelated concerns in one file — infra/config, Mongo/Firestore access, RAG retrieval, per-type message-building, and the two inference paths (`useGateway ? chatViaOpenClaw : chatWithTools/chatNoTools`) — so new code has no obvious, single-responsibility home. `steps/compliance.js` exists but is not wired into the dispatch table.

## Solution

Extract `worker/index.js` into single-responsibility modules (`config.js`, `db.js`, `rag.js`, `caches.js`, `inference/{index,ollama,openclaw}.js`, `handler.js`) with zero behavior change, replace the `useGateway` ternary with an `inference/index.js` factory returning a `{stream}` interface, and wire `steps/compliance.js` into the dispatch table.

> **Status: incomplete / mid-flight.** Moved here from `design/worker-architecture.md` during a docs cleanup pass. Diffed against the actual `worker/` code (2026-07-05): `admission.js`, `semaphore.js`, `steps/{step,planner,compliance,outcome}.js`, `lib/inventory.js`, and `tools/search-pool.js` now exist as separate modules — a real step toward this plan's goal — but `config.js`, `db.js`, `rag.js`, `caches.js`, the `inference/` factory, and `handler.js` do **not** exist; `worker/index.js` is still ~1000 lines and still contains the exact `useGateway ? chatViaOpenClaw : chatWithTools/chatNoTools`-shaped branch (now `useGateway = GATEWAY === "openclaw"` at `worker/index.js:850`) that this plan says to replace with a factory. **This plan does not describe the current state of the code — treat the divergence below as real, not as this plan being "basically done."** No `tasks.md` exists for it; before resuming this work, run it back through `plan-changes` to get a plan that reflects what's actually left, rather than resuming against this stale one.

Refactor `worker/index.js` (currently mixing five unrelated concerns in one file: infra, caches, RAG, message-building per type, and the two inference paths) into small, single-responsibility modules, so new code has an obvious, readable home. Nothing about this plan changes worker *behavior* — it is structure only.

## Target Design Docs

- [[llm-pipeline]] — the worker's execution model and API surface this refactor must not change behaviorally.
- [[worker-dispatch]] — the admission/CAS logic already extracted into `admission.js`, which this refactor keeps calling as-is.

## Target layout (not yet reached)

```
worker/
  index.js          # entrypoint ONLY: startup, mongo connect, subscription loop, dispatch
  config.js         # parse + validate process.env (the destructured constants live here)
  db.js             # Mongo connect + collection accessors; Firestore client; chunk flusher
  rag.js            # getEmbedding + retrieveContext  (Mongo $vectorSearch)
  caches.js         # prompt_library + llmtools load/cache; systemPromptFor(); getTools()
  inference/
    index.js        # FACTORY: pick the engine by GATEWAY ("openclaw" → gateway, else ollama)
    ollama.js       # raw path: chatRound, chatWithTools, chatNoTools, executeTool
    openclaw.js      # gateway path: chatViaOpenClaw
  steps/
    step.js         # shared step assembly: buildMessages() + common helpers
    planner.js       # buildPlannerMessages
    compliance.js    # compliance step (own tools + RAG)
  handler.js         # handleMessage: dispatch by type, RAG opt-in, stream, ack/nack
```
This is a target, not a mandate — collapse `inference/` back to one file if it stays small.

**The "step" model (already implemented — keep as-is):** every unit of LLM work is a step; the worker dispatches by message `type` through a lookup table (`MESSAGE_BUILDERS`); each builder takes `(payload, context)` and returns chat messages. Shared step assembly (`steps/step.js`) provides `buildMessages(system, query, context)` — the common "system message (+ RAG context) then user message" shape every builder ends with. Compliance is a step like any other (`steps/compliance.js` exists as a documented stub) but differs in two reserved ways: it may load a compliance-specific tool set, and it pulls RAG context from Mongo `regulations` instead of the default source. Wiring it into the dispatch table is a one-line change, not yet done.

**Inference factory (not yet done):** replace the current `useGateway ? chatViaOpenClaw : chatWithTools/chatNoTools` ternary (still literally present in `worker/index.js`) with a factory `getInference(GATEWAY) -> { stream(messages, {tools}, onChunk) -> Promise<string> }` in `inference/index.js`, so the handler calls one interface and never branches on engine. `executeTool` (the raw-path web_search/web_fetch tool loop) is a deliberate stopgap per spec — tools should eventually load via `ollama launch openclaw --model …` and run by the gateway; remove `executeTool` in Phase 2 once the gateway path is verified, not before.

**RAG:** "context" here is RAG reference material, not conversation state. Mongo Atlas stores the `regulations` collection with embeddings; `retrieveContext()` runs a `$vectorSearch` to pull the most relevant chunks and inject them as a system-message preamble; `getEmbedding()` turns the query into a vector for that search. RAG is opt-in (`payload.metadata.rag`) and non-fatal — a failure runs the query without context.

## Testing strategy (already in effect — keep as-is)

Fast unit tests, no real services. Mock only third-party boundaries (Ollama HTTP `fetch`, Mongo, Firestore, Pub/Sub) — never our own functions (`buildMessages`, builders, factory, handler are what's under test). Runner: Node's built-in `node:test` + `node:assert`. Layout: co-located `*.test.js` next to each module. `npm test` runs them; `npm run test:coverage` runs with coverage, gated (fails below lines 90 / funcs 80 / branches 60 — tune in `package.json` as coverage grows) — tests must always run paired with coverage, never bare. `*.test.js`/`*.spec.js`/`__tests__/` are excluded from the Docker build context (`.dockerignore`) so they never bake into a worker image.

Contracts worth a test each: `steps/planner.js` (given a payload, produces a `[system, user]` pair whose user block contains the tools list, subtypes list, and assigned model topic); the inference factory (`GATEWAY="openclaw"` → gateway impl, else ollama impl); `ollama.chatRound` (POSTs the correct body to `/api/chat` against a mocked `fetch`); the planner path runs tool-free (guards the "planner called tools" bug); context-too-large → terminal failure (job marked `error`, message **acked not nacked** — guards the redelivery loop).

## Testing Requirements

Runner: `node --test`, always paired with `npm run test:coverage` (gate: lines 90 / funcs 80 / branches 60). Layout: co-located `<module>.test.js` next to each new module, following `worker/steps/step.test.js` (pure-function tests, no mocks) and `worker/ollama.test.js` (real local `http` server standing in for the third-party boundary, no live Ollama/Mongo/network) as the two existing conventions to extend.

- `worker/config.js` → `worker/config.test.js`: valid `process.env` produces the expected parsed/typed config object; a missing/invalid required var throws at load time.
- `worker/db.js` → `worker/db.test.js`: Mongo/Firestore accessors and the chunk flusher, with the Mongo/Firestore clients mocked (per the existing "mock only third-party boundaries" rule already in effect for `admission.test.js`/`ollama.test.js`).
- `worker/rag.js` → `worker/rag.test.js`: `getEmbedding()` and `retrieveContext()` against a mocked Mongo `$vectorSearch`; a RAG failure returns no context and does not throw (covers the Target layout note that "RAG is opt-in and non-fatal — a failure runs the query without context").
- `worker/caches.js` → `worker/caches.test.js`: `systemPromptFor()` and `getTools()` load-and-cache from a mocked `prompt_library`/`llmtools` source, and return the cached value on a second call without re-querying.
- `worker/inference/index.js` → `worker/inference/index.test.js`: `getInference("openclaw")` returns the gateway impl, `getInference(<anything else>)` returns the ollama impl — the factory contract already named in "Testing strategy" above.
- `worker/inference/ollama.js` and `worker/inference/openclaw.js` → co-located `*.test.js` per module: each `{stream}` implementation is exercised the same way `worker/ollama.test.js` exercises `chatRound` today (real local `http` server, no live services), extended to the new file location.
- `steps/compliance.js` dispatch wiring: extend `worker/steps/builders.test.js` with a case asserting the dispatch table (`MESSAGE_BUILDERS`) routes the compliance message `type` to `buildComplianceMessages`, and that it pulls RAG context from `regulations` rather than the default source (per "Compliance is a step like any other... it pulls RAG context from Mongo `regulations` instead of the default source").
- Zero-behavior-change smoke check: for each Phase 1 move, a real smoke job (query → streamed Firestore result) run per the plan's own "Each move: `node --check` + one real smoke job" rule — not a `node --test` file, since this checks integration behavior across the real Pub/Sub/Ollama path, not a unit contract.
- Regression coverage already required and kept green through every extraction (no new test needed, just must continue to pass against the code at its new module locations): the planner-tool-free guard and the context-too-large → terminal-failure/acked-not-nacked guard, both named in "Testing strategy" above.

## Parallel / Dependent Breakdown

**Phase 1 — pure mechanical extraction, zero behavior change (partially done).**
- Done: extract `admission.js` (dispatch/CAS), `semaphore.js` (concurrency gate), `ollama.js` (HTTP transport), `steps/{step,planner,compliance,outcome}.js`, `lib/inventory.js`, `tools/search-pool.js` — each independently, each verified by `node --check` + a smoke job, each with its own `*.test.js`.
- Not done, and each independent of the others (can run in parallel once picked up): extract `config.js`; extract `db.js`; extract `rag.js`; extract `caches.js`; build the `inference/index.js` factory + `inference/ollama.js` + `inference/openclaw.js` (depends on `caches.js`/`config.js` existing first, since the factory needs config to pick the engine); wire `steps/compliance.js` into the dispatch table (one-line, independent of the above); reduce `index.js` to `handler.js` + a thin entrypoint once the above modules exist (this step depends on all the others — it's the integration step, not parallelizable with them).
- Each move: `node --check` + one real smoke job before moving to the next.

**Phase 2 — redesigns (behavior changes), separate and deliberate, only after Phase 1 is verified end-to-end.**
- Drop `executeTool` once the gateway path is verified.
- Flesh out per-subtype step builders as their flows land (compliance is the first candidate).

Do Phase 1 only from a known-good baseline (a plan building end-to-end), on a branch, reviewable step by step. Never big-bang.

## Conventions so new code is identifiable

Every module starts with a header: `// <path> — owns: <one line>`. One concern per file; `index.js` holds no business logic, only wiring. A new step type = a new file under `steps/` + one dispatch-table entry, never an `if (type === …)`. Placeholders say so loudly in the header and throw if called while unimplemented.

## Success Criteria

- `worker/index.js` reduced to startup/connect/subscription-loop/dispatch only — no inline config parsing, no inline Mongo/Firestore accessors, no inline RAG, no inline inference branching.
- `config.js`, `db.js`, `rag.js`, `caches.js`, `inference/{index,ollama,openclaw}.js`, and `handler.js` exist, each with the single responsibility named in the target layout, each with its header comment.
- The `useGateway ? … : …` ternary is gone from `index.js`, replaced by `getInference(GATEWAY)` returning a `{stream}` interface the handler calls without branching on engine.
- `steps/compliance.js` is wired into the dispatch table (no longer a documented-but-unreachable stub).
- Every extracted module has co-located unit tests; `npm run test:coverage` still passes the existing coverage gate (lines 90 / funcs 80 / branches 60) with the new module boundaries.
- Zero behavior change end-to-end: a real smoke job (query → streamed Firestore result) produces the same shape of result before and after each Phase 1 move.
- Phase 2 items (`executeTool` removal, per-subtype builders) are explicitly **not** required for this plan to be considered done — they're a separate, deliberate follow-on once the gateway path is verified.
