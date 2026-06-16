# Worker Architecture & Refactor Plan

> **How to read this doc:** it describes where the worker is going, not where it is today.
> `worker/index.js` is currently one ~600-line file; this is the plan to split it into small,
> single-responsibility modules so new code (like the compliance flow) has an obvious, readable
> home. Nothing here changes behavior — it's structure. Complements the system-level `DESIGN.md`.

---

## Why

`worker/index.js` mixes five unrelated concerns in one file: infra (Mongo/Firestore), caches
(prompts/tools), RAG, message-building per type, and the two inference paths. That makes it hard
to (a) find the code for a given concern, (b) tell new code from old, and (c) unit-test a piece
in isolation. The goal is a thin entrypoint plus focused modules, each with a one-line "owns:"
header so you can identify it at a glance.

## Target layout

```
worker/
  index.js          # entrypoint ONLY: startup, mongo connect, subscription loop, dispatch
  config.js         # parse + validate process.env (the destructured constants live here)
  db.js             # Mongo connect + collection accessors; Firestore client; chunk flusher
  rag.js            # getEmbedding + retrieveContext  (Mongo $vectorSearch — see "RAG" below)
  caches.js         # prompt_library + llmtools load/cache; systemPromptFor(); getTools()
  inference/
    index.js        # FACTORY: pick the engine by GATEWAY ("openclaw" → gateway, else ollama)
    ollama.js       # raw path: chatRound, chatWithTools, chatNoTools, executeTool
    openclaw.js     # gateway path: chatViaOpenClaw
  steps/
    step.js         # shared step assembly: buildMessages() + common helpers
    planner.js      # buildPlannerMessages (planner prompt + tools + subtypes)
    compliance.js   # PLACEHOLDER — compliance step (own tools + RAG). See below.
  handler.js        # handleMessage: dispatch by type, RAG opt-in, stream, ack/nack
```

This is a target, not a mandate — collapse `inference/` back to one file if it stays small.

## The "step" model

Every unit of LLM work is a **step**. The worker dispatches by message `type` through a lookup
table (`MESSAGE_BUILDERS`); each builder takes `(payload, context)` and returns chat messages.

- **Shared step assembly** (`steps/step.js`) — `buildMessages(system, query, context)`: the common
  "system message (+ RAG context) then user message" shape. Every step builder ends here.
- **Per-type builders** layer their specifics on top. Today only `planner` has its own builder;
  every other type falls through to the standard builder. New step types (like compliance) add a
  builder file + one entry in the dispatch table — nothing else branches on type.

### Compliance as a step (the placeholder)

Compliance is being built in a **separate flow**. It is a step like any other — it runs the shared
step assembly — but it differs in two ways the placeholder reserves room for:

1. **Tools** — it may load a compliance-specific tool set, not the default web tools.
2. **RAG** — it pulls reference context from Mongo `regulations` (`$vectorSearch`) so the model
   checks against real legal/allergen/safety rules instead of its own memory.

`steps/compliance.js` exists now as a documented stub with that contract. It is **not yet wired**
into the dispatch table, so today `type: "compliance"` still uses the standard builder (unchanged
behavior). Wiring it is a one-line change during Phase 1 / when the compliance flow lands.

## Inference factory (ollama vs openclaw)

Replace the current `useGateway ? chatViaOpenClaw : chatWithTools/chatNoTools` ternary with a
factory in `inference/index.js`:

```
getInference(GATEWAY) -> { stream(messages, { tools }, onChunk) -> Promise<string> }
```

- `ollama.js` implements the raw path (worker runs the tool loop via `executeTool`).
- `openclaw.js` implements the gateway path (OpenClaw runs the tools).
- The handler calls one interface and never branches on the engine.

> **Note on `executeTool` (raw-path web_search/web_fetch):** per spec, tools should be loaded via
> `ollama launch openclaw --model …` and run by the gateway. `executeTool` exists only because the
> gateway wiring is still pending; it's the *only working* tool path today. It's a deliberate
> stopgap, not dead code — remove it in Phase 2, once the gateway path is verified, not before.

## RAG (clears up "Mongo doesn't keep context")

"Context" here is **RAG reference material**, not conversation state. Mongo Atlas stores the
`regulations` collection *with embeddings*; `retrieveContext()` runs a `$vectorSearch` to pull the
most relevant chunks and inject them as a system-message preamble. `getEmbedding()` is just the
helper that turns the query into a vector for that search — it has no other use. RAG is **opt-in**
(`payload.metadata.rag`) and non-fatal: if it fails, the query runs without context.

## Testing strategy

Fast **unit tests**, no real services. The rule: **mock only third-party boundaries, never our own
functions** — so tests exercise our real logic and verify the *contracts* between modules.

- **Mock:** the Ollama HTTP endpoint (`fetch`), Mongo, Firestore, Pub/Sub. Nothing else.
- **Don't mock:** `buildMessages`, the builders, the factory, the handler — those are what we're testing.
- **Runner:** Node's built-in `node:test` + `node:assert` (zero new deps, ESM-native, fast).
- **Layout:** co-located `*.test.js` next to each module (e.g. `steps/planner.test.js`).
- **Commands:** `npm test` runs them; `npm run test:coverage` runs them **with coverage, gated**
  (fails if below lines 90 / funcs 80 / branches 60 — tweak in `package.json` as coverage grows).
  Tests must always be paired with a coverage run, not run bare.
- **Never deployed:** `*.test.js` / `*.spec.js` / `__tests__/` are excluded from the Docker build
  context by `.dockerignore`, so they never bake into a worker image (`COPY worker/` would
  otherwise include them). Keep test files matching those patterns so the exclusion holds.

Contracts worth a test each:
- `steps/planner.js` — given a payload, produces a `[system, user]` pair; the user block contains the
  tools list, subtypes list, and the assigned model topic.
- `inference` factory — `GATEWAY="openclaw"` returns the gateway impl; otherwise the ollama impl.
- `ollama.chatRound` — POSTs the correct body (`model`, `messages`, `options.num_ctx`) to `/api/chat`
  (assert against a mocked `fetch`).
- planner path runs **tool-free** (no executable tools passed) — guards the "planner called tools" bug.
- context-too-large → **terminal** failure (job marked `error`, message **acked not nacked**) — guards
  the redelivery loop.

## Migration plan (do NOT big-bang)

**Phase 1 — pure mechanical extraction, zero behavior change.** Move code into the modules above one
at a time; after each move: `node --check` + one real smoke job. Add the `inference` factory. Wire the
compliance placeholder. Land unit tests alongside.

**Phase 2 — redesigns (behavior changes), separate and deliberate.** Drop `executeTool` once the
gateway path is verified; flesh out per-subtype builders as their flows land.

Do Phase 1 only from a known-good baseline (a plan building end-to-end), on a branch, reviewable
step by step.

## Conventions so new code is identifiable

- Every module starts with a header: `// <path> — owns: <one line>`.
- One concern per file; `index.js` holds no business logic, only wiring.
- A new step type = a new file under `steps/` + one dispatch-table entry. Never an `if (type === …)`.
- Placeholders say so loudly in the header and throw if called while unimplemented.
