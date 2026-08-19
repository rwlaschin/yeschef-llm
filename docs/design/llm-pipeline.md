---
modified: 2026-07-06
dependencies: [worker-dispatch]
---

# LLM Pipeline

The end-to-end path a single LLM request takes: `yeschef` UI → `/api/llm` → Pub/Sub → worker → Ollama/OpenClaw → Firestore → UI. Read this before touching the request/response contract, the topic/model mapping, or the dev/deploy execution model. Worker-internal dispatch safety (crash recovery, idempotency, retries) is a separate concern — see [[worker-dispatch]].

## Sensitive Areas

- **Regulated data must not leave our infra.** Cloud-hosted model tags (e.g. `kimi-k2.5:cloud`) are ruled out for any tier handling company data — only local/self-hosted models run in production. Per-token cloud cost also makes them non-viable at scale.
- **Multi-tenant scoping.** Every request and Firestore doc is scoped to `userId` + `companyId`; the backend verifies company access via Neo4j before publishing. A bug here is a cross-tenant data leak.
- **Mid-request loss correctness.** Workers run on GPU instances that can die mid-request at any time — scale-in (autoscaler removing an idle instance), host maintenance (`onHostMaintenance=TERMINATE`), or a process/VM crash. The ack/idempotency contract (see [[worker-dispatch]]) is the only thing standing between that and duplicated or lost results — do not change ack timing without re-reading it.
- **Secrets in `.env` / `.env.production`** — `GOOGLE_APPLICATION_CREDENTIALS`, Mongo URI, OpenClaw gateway token. Never logged, never committed.

## Design Constraints

- **Single source of truth for models/topics**: `config/models.js`, imported everywhere via `#models`. Changing a topic name means changing one place.
- **One Docker image, two run targets** — the image (Ollama + worker + baked model) is built once; dev runs it directly via a `waker`, prod bakes it into a GCE custom image for the MIGs. No separate dev/prod build paths.
- **No runtime model pull** — the model is baked into the image at build time so cold-start never blocks on a download.
- **Local Macs have no GPU** — dev always runs the *slim* tier, CPU-only (slow but functionally correct).
- **Ack only after the final Firestore write** — required for redelivery-based recovery on instance loss (see [[worker-dispatch]]); nothing in this pipeline may ack earlier as an optimization.

## Feature Overview

This is the request/response backbone connecting the `yeschef` frontend to Ollama/OpenClaw inference. A user action in the UI becomes a Pub/Sub message; a worker (GPU-backed, autoscaled 0↔N) performs inference and streams the result into a single Firestore document that the UI subscribes to in real time. It exists so that inference — which is slow, GPU-bound, and needs to scale independently — is fully decoupled from the request-serving Next.js backend, and so that a page reload never loses track of an in-flight job (the client resubscribes from `localStorage`-tracked job IDs).

Four model tiers exist today (`config/models.js`): `llama3.1:8b` (1×L4, dev-enabled, 128K ctx), `llama3.3:70b-instruct-q4_K_M` (2×L4, no dev GPU, ≈44 GB at q4_K_M), `gemma4:12b-it-qat` (1×L4, dev-enabled, 256K ctx) and `qwen3.5:9b` (1×L4, dev-enabled, 256K ctx). A third tier, **OpenClaw**, is a gateway/abstraction layer (`ollama launch openclaw --model <backing>`) that fronts either of the above and adds a tool layer (web search/fetch, MCP servers, messaging channels, plugins) — it is not itself a model. OpenClaw tiers are `dev: false` in the registry until the gateway-launch wiring in `start.sh` is implemented.

## Architecture

**Topic/Model Mapping.** Topics are named after the model only (no function type in the name), e.g. `llama3_1_8b_v1`. The topic is the single value the dashboard and subscriptions derive from — change it once in `config/models.js` and everything follows.

**OpenClaw Gateway.** Backing model must be local/self-hosted (see Design Constraints). Features are CLI/config-managed:

| Capability | How | Notes |
|---|---|---|
| web_search / web_fetch | auto-on at launch; `openclaw configure --section web` | Uses Ollama's hosted search API (`OLLAMA_API_KEY`) — the query itself leaves our infra even though the model is local. Self-host SearXNG if queries must stay internal. |
| MCP servers | `openclaw mcp …` | General path for adding arbitrary tools. |
| channels | `openclaw configure --section channels` | WhatsApp, Telegram, Discord, Slack, iMessage. |
| plugins / skills | `--section plugins` / `--section skills` | Bundled capabilities and workflows. |

OpenClaw's gateway exposes an OpenAI-compatible endpoint (`POST http://localhost:18789/v1/chat/completions`, WS+HTTP on one port, disabled by default until `gateway.http.endpoints.chatCompletions.enabled=true`). Model routing encodes the agent in the OpenAI `model` field (`"openclaw:main"`); auth is `Authorization: Bearer <token>`; streaming is standard OpenAI SSE. For a `gateway: "openclaw"` tier the worker switches from Ollama's `POST /api/generate` to OpenClaw's `/v1/chat/completions`.

**Execution model — dev & deploy.** One build artifact, two run targets:

```
build Docker image (Ollama + worker + model baked in — no runtime pull)
   ├─ dev:    waker docker-starts it  ──────────────►  local emulation
   └─ deploy: bake into GCE custom image  ──────────►  GPU VMs (MIG)
```

The expensive GPU machine scales 0↔N; a cheap always-on **waker** brings it up on demand — it only *triggers*, it never consumes/acks the message, so cold-start time never counts against the Pub/Sub ack lease (the lease clock starts when the worker itself pulls, post-boot).

| | Wake mechanism | Notes |
|---|---|---|
| Dev | `scripts/waker.js` polls the emulator subscription; `docker start`s the container when a message exists and it's down | faithful stand-in for the prod autoscaler |
| Prod | GCE MIG autoscaler scales GPU VMs on Pub/Sub backlog (`num_undelivered_messages`), 0→N→0 | raw Compute; scale-to-zero, no cluster fee |

One VM per replica; GPU count is the model's machine description — 2B/OpenClaw → 1×L4 (`g2-standard-8`), 70B → 2×L4 on a single box (`g2-standard-24`). Distributed/multi-VM spread of one model across machines was considered and **rejected** — Ollama doesn't support it (llama.cpp-only feature) and 70B-Q4 (~40GB) fits a single 2×L4 box (48GB).

> **Status:** dev (Docker + waker) and image build/push are implemented. The GCE custom-image bake + MIG + autoscaler steps are written but not yet run — verify project params (zone/network/service account/GPU quota) and MIG scale-to-zero before a real deploy.

**Instance-loss resilience.**
- *Message retry* — dead-letter after 5 failed attempts; a worker crash returns the message to the queue automatically; 40s ack deadline before retry.
- *Stale job cleanup* — Cloud Scheduler every 5 minutes marks `status: "streaming" AND createdAt < now - 10 minutes"` as `error`.
- *Idempotency* — the worker uses `jobId` as the lookup key; a retried message that already has `llmResults/{jobId}` data is skipped. (Full CAS/idempotency detail: [[worker-dispatch]].)

**Security / data scoping.** All requests scoped to `userId` + `companyId` (multi-tenant). Backend verifies company access via Neo4j. The worker stores `jobId`/`userId`/`companyId` on the Firestore result doc. The frontend only watches Firestore docs it created (security rules).

**Logging.** Worker logs to Google Cloud Logging (Cloud Run default), tagged per job: `` console.log(`[${jobId}] Processing started`) ``, `` [${jobId}] RAG context: ${chunks} chunks retrieved ``, `` [${jobId}] Streaming complete, ${tokens} tokens ``. Query via `resource.type="cloud_run_revision" jsonPayload.jobId="<jobId>"`.

## Functions

**`POST /api/llm`** — the sole entry point from the frontend.

Request:
```json
{ "userId": "user-id", "companyId": "company-id", "type": "query", "userPrompt": "What are the allergen restrictions?", "model": "openclaw", "metadata": {} }
```
Response:
```json
{ "jobId": "uuid", "createdAt": "2026-05-28T...", "type": "query", "model": "openclaw" }
```

Backend steps:
1. **Validate** — `userId`, `companyId`, `type`, `userPrompt` required.
2. **Generate `jobId`** — UUID, links all related data.
3. **Look up context** — Mongo + Neo4j for user/company data and role/permissions.
4. **Build `systemPrompt`** — dynamic, based on `type` + context.
5. **Create Firestore doc** — `llmResults/{jobId}` with `status: "pending"`.
6. **Publish message** — to `{model}_v1` topic with `jobId`, `userId`, etc.
7. **Return `jobId`** — to the UI for polling/subscription.

## Models

**Pub/Sub message** (published to `{model}_v{version}` topic):
```json
{
  "jobId": "uuid", "userId": "user-id", "companyId": "company-id",
  "type": "query", "userPrompt": "What are the allergen restrictions?",
  "metadata": { "optional": "context" }
}
```
`model` is intentionally **not** included — it's implicit in the topic name. `systemPrompt` is built server-side before publishing, also not sent over the wire.

**Firestore `llmResults/{jobId}`:**
```json
{
  "jobId": "uuid", "userId": "user-id", "companyId": "company-id",
  "type": "query", "model": "openclaw", "userPrompt": "…",
  "status": "pending|streaming|complete|error",
  "response": "streamed in chunks",
  "error": "set only if status is error",
  "createdAt": "timestamp", "updatedAt": "timestamp", "completedAt": "timestamp"
}
```
Status lifecycle: `pending` (published, awaiting worker) → `streaming` (worker processing) → `complete` | `error`.

## Use Cases

### UC1 — User submits a query and watches the streamed answer

**Goal.** A `yeschef` user gets an LLM-generated answer to a prompt, rendered incrementally as it's produced, and does not lose track of it across a page reload.

**Stakeholders.** The end user asking the question; `yeschef` product owners (response latency/quality); the company the user belongs to (data must stay scoped to it).

**Actors.** The `yeschef` frontend (UI); the `/api/llm` backend route; the Ollama worker (`worker/index.js`).

**Preconditions.** The user is authenticated and scoped to a `companyId`; the target model's Pub/Sub topic and subscription exist (`config/models.js`); a worker is listening on that subscription.

**Postconditions.** `llmResults/{jobId}` holds `status: "complete"`, the full `response` text, and timestamps; the UI has rendered the final response and cleared its `localStorage` tracking entry.

**Basic Course of Events (BCE).**
1. UI `POST`s `{userId, companyId, type, userPrompt, model, metadata}` to `/api/llm`.
2. Backend validates required fields, generates a `jobId` (UUID), looks up user/company context (Mongo + Neo4j), and builds a `systemPrompt` for the request `type`.
3. Backend creates `llmResults/{jobId}` in Firestore with `status: "pending"`, then publishes `{jobId, userId, companyId, type, userPrompt, metadata}` to the `{model}_v1` topic, and returns `jobId` to the UI.
4. UI stores `{jobId, type, userPrompt, createdAt}` in `localStorage` under `llm_job_${jobId}` and opens an `onSnapshot` listener on `llmResults/{jobId}`.
5. The worker's Pub/Sub subscription delivers the message to `handleMessage`. In one Firestore transaction it decides whether to run (`shouldRun` in `worker/admission.js`) and, if so, marks the doc `status: "running"` for this delivery's `attempt`.
6. The worker builds the chat messages for the request `type`, sizes the context window, and streams the model's response via `chatRound` (`worker/ollama.js`, using `node:http`/`node:https` rather than `fetch`), pushing chunks through a batching flusher into `llmResults/{jobId}.response` (every 20 chunks or 500ms).
7. On completion, the worker writes the terminal result through a first-writer-wins compare-and-set (`completionWrite` in `worker/admission.js`) — `status: "complete"` (or `"error"` — see Exceptions) — and acks the Pub/Sub message.
8. The UI's `onSnapshot` listener renders `response` as it updates; when `status` reaches `"complete"`, the UI unsubscribes and removes the `llm_job_${jobId}` entry from `localStorage`.

**Alternate Flows.**
- **Page reload mid-flight.** If the user reloads before `status` reaches a terminal value, the UI scans `localStorage` for all `llm_job_*` keys on load and re-attaches an `onSnapshot` listener to each corresponding `llmResults/{jobId}` doc, resuming from BCE step 8 without re-submitting the request. On the next `complete`/`error`, the entry is cleared as usual.
- **Redelivered/duplicate message.** If Pub/Sub redelivers a message whose slot is already terminal for that `attempt`, `shouldRun` returns false; the worker acks immediately without re-running inference or re-writing the result (see `worker/admission.js`).

**Exceptions.**
- **Stalled generation.** If the model produces no output for `firstChunkMs` (default 600000ms, before the first token) or `idleMs` (default 120000ms, between tokens), `chatRound`'s `AbortController` aborts the request and throws a stall error.
- **Any inference/tool/Firestore error.** The worker's `catch` block classifies the failure, writes `status: "fail"`/`"error"` with the error message in `outcome` via the same first-writer-wins CAS, and always `ack`s the message (never `nack`s) — redelivery of a poison message is avoided; recovery is the orchestrator's job for orchestrated runs, not Pub/Sub's.
- **Superseded completion.** If `completionWrite` finds the slot already claimed by a newer or already-terminal `attempt`, the write is a no-op; only the run that actually wrote (the "winner") is treated as authoritative.

### UC2 — Orchestrator runs a multi-step plan to completion

**Goal.** A plan/step orchestration job (a sequence of LLM steps, each possibly fanned out into parallel units) runs unattended from its first step through to a final terminal state, retrying a failing step a bounded number of times before passing through rather than stalling.

**Stakeholders.** The end user or system that launched the plan; `yeschef` product owners (a plan must never wedge indefinitely); on-call engineers (failed/passed-through steps must be diagnosable from `outcome`).

**Actors.** The orchestrator (`functions/entry/ai/dispatch/dispatch.js`, `functions/entry/ai/dispatch/step.js`); the Ollama worker (`worker/index.js`); the model itself (via the `@@::PASS::@@` / `@@::FAIL:<reason>::@@` status block, parsed by `worker/steps/outcome.js`).

**Preconditions.** A job document exists with a non-empty `plan[]`, each entry naming a `model` topic; `cursor` identifies the currently-dispatched step.

**Postconditions.** The job's `cursor` has advanced past the last step; `status` is `"success"` (no step failed) or `"fail"` (one or more steps exhausted retries and were passed through, recorded in `failedSteps`).

**Basic Course of Events (BCE).**
1. The orchestrator dispatches step `N`: `dispatchStep` cleans up stale prior runs for that step, sets `cursor: N`, and publishes one Pub/Sub message per fanout unit (`unitCount`, branching on the step's `kind`: `fanout`/`chain` by item count, `chunks` by group count, `aggregation` = 1) to the step's model topic, with `report: "step"` so the worker pings the orchestrator on completion.
2. Each unit's message is picked up by a worker exactly as in UC1 BCE steps 5–7, writing to an ordered run-doc slot `steps/{step}-{unit}` (`unitDocId`).
3. The model ends its output with `@@::PASS::@@` or `@@::FAIL:<reason>::@@`; `worker/steps/outcome.js` (`splitOutcome`) strips the marker from the visible response and maps it to `runStatus`: `"success"` for PASS or no block, `"fail"` for FAIL (with the reason carried as `outcome`).
4. On completion the worker reports `{jobId, action: "step", step, runId, status: runStatus, outcome}` to the `orchestrate` Pub/Sub topic.
5. `step.js`'s `handle` waits until all of the step's expected units are terminal, then checks for any failure among them.
6. If none failed, `advance()` moves `cursor` to `step + 1` and dispatches it (repeating from BCE step 1), or — if `step + 1` is past the end of `plan[]` — finalizes the job with `status: "success"`.

**Alternate Flows.**
- **A step fails and is retried.** If any unit of the step reported `status: "fail"`, `step.js` claims a retry via a compare-and-set on `job.attempts[step]` (so concurrent fanout units reporting failure can't each trigger a separate retry), then re-dispatches — targeting `def.failStep` if it is a sane value in `0..step`, otherwise the same step — with an orchestrator-authored `query` that includes the target step's instructions plus the prior failure's reason and a snippet of its rejected output.
- **A step exhausts its retries.** After `MAX_GEN` (default 2) failed attempts at a step, `step.js` calls `advance()` with `failed: true` instead of retrying again: the step's index is recorded in `job.failedSteps`, and the plan proceeds to `step + 1` anyway ("pass through") rather than stalling indefinitely on a step it cannot pass.
- **Final step passed through as failed.** If the failed step is the last one, the job finalizes with `status: "fail"` and `outcome` naming which step(s) failed and were passed through.

**Exceptions.**
- **Stale report.** If a unit's completion report arrives for a `step` that no longer matches the job's current `cursor` (a later report for a step the flow already moved past), `step.js` ignores it.
- **Model topic not found.** If `dispatchStep`'s publish fails with a gRPC `NOT_FOUND` (the step's model topic isn't provisioned in this environment), the job is marked `status: "fail"` immediately rather than retried, since redelivery cannot fix a missing topic.
- **Infrastructure failure inside a step (stall/timeout/crash).** The worker's UC1 Exceptions handling applies per-unit; a resulting `status: "fail"` on the run doc drives the same retry/pass-through logic as a model-authored `@@::FAIL::@@`, so an infrastructure failure cannot wedge the plan any differently than a content failure.

## Tests

No pipeline-level (API route / Pub/Sub contract) tests are documented today. Worker-internal logic that this pipeline depends on is unit-tested under `worker/*.test.js` and `worker/steps/*.test.js` (`node --test`, coverage-gated — see [[worker-dispatch]] and the worker-refactor plan for what's covered).

## UI/UX

This subsystem is backend/API-only — the calling interface is `yeschef`'s Remy chat UI (a separate project/repo), not owned here. No mockups exist in this project for it.

## Dependencies

- [[worker-dispatch]] — the worker-side idempotency/ack contract that makes the "Instance-loss resilience" guarantees above true.

## Diagrams

```
Client → Pub/Sub topic → worker/index.js → MongoDB Atlas (RAG) → Ollama → Result
```

```
build Docker image (Ollama + worker + model baked in — no runtime pull)
   ├─ dev:    waker docker-starts it  ──────────────►  local emulation
   └─ deploy: bake into GCE custom image  ──────────►  GPU VMs (MIG)
```

## References

- Ollama API docs (`/api/generate`, `/api/chat`) and OpenClaw gateway docs (OpenAI-compatible `/v1/chat/completions`).
- GCP Pub/Sub dead-letter and Cloud Scheduler docs (stale-job cleanup).
