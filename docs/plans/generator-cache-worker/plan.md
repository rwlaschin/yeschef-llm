---
modified: 2026-07-07
dependencies: [worker-dispatch, llm-pipeline]
supersedes: null
---

# Generator (cache) worker

## Problem

The fake worker only ever returns hardcoded canned responses, so any test flow that needs a realistic, diet-specific answer has no source for one without hitting a real GPU model on every run. There is no way to build up a reusable body of real model output for repeated test runs.

## Solution

Add a second, separate lean worker — the generator — with its own topic/subscription and its own Docker image, opted into by a `cache: true` job flag mirroring the existing `fake` flag. On a job it looks up a Mongo cache keyed by `subtype:item`; on a hit it completes the slot from cache with no model call; on a miss it forwards the job to the real model already named in `payload.model`, keeping `cache: true` so the model worker writes its response through to the cache as it completes. The existing fake worker is left unchanged.

## Scope

### Routing (the `cache` flag)

- The generator is opted into per job by `cache: true` on the job doc, exactly parallel to `fake: true` on the menu path. `payload.model` continues to carry the real model topic (the backing model) in every case — the generator reads it directly on a miss; no new `backingModel` field is introduced. Scoped to the menu path (`/ai/menu`), where fanout steps such as `protein_grid` originate; the one-shot `/ai/query` path is out of scope.
- `functions/entry/ai/schemas.js` — add `cache: { type: "boolean" }` to `menuSchema` (line ~25, alongside `fake`); `additionalProperties:false` rejects the field otherwise.
- `functions/entry/ai/menu.js` — destructure `cache` from `req.body` (line ~141), `const isCache = cache === true`, and write `cache: isCache` into both job-doc writes (lines ~212 and ~220), mirroring `fake: isFake` exactly.
- `functions/entry/ai/dispatch/dispatch.js` — read `const cache = job.cache === true` (mirroring `const fake = job.fake === true` at line 73). Change the topic selection at line 104 from `fake ? FAKE_TOPIC : def.model` to `fake ? FAKE_TOPIC : (cache ? GENERATOR_TOPIC : def.model)`. In the published JSON (line 105), emit `item: Array.isArray(def.items) ? def.items[i] : null` and `cache: true` for a `cache` job (today `item` ships only under the `fake` spread; `subtype` and `model` already ship unconditionally, so both survive the generator's forward for free).

### New files

- `worker/generator.js` — generator worker entry point. Subscribes to `GENERATOR_SUBSCRIPTION`. Per message:
  1. Parse; malformed → nack (same poison-message rule as `worker/index.js`).
  2. `key = cacheKey(payload.subtype, payload.item)` (see Data model — coerces a non-string `item` deterministically).
  3. `getCannedResponse(cannedCollection, key)` against Mongo `canned_responses`.
  4. Hit → run the receive-claim + completion CAS from `worker/admission.js` (`shouldRun`/`completionWrite`) against `llmResults/{jobId}/steps/{unitDocId}` writing `status:"success"`, `response: cached`, then call the extracted `reportToOrchestrator` (see Modified files) and ack.
  5. Miss → publish the same `{jobId, step, unit, attempt, ...}` message, still carrying `cache:true`, to `payload.model`'s topic, then ack. No callback, no listener — the generator's work ends at the forward. (The generator publishes straight to the model topic, not via `dispatch.js`, so `cache:true` does not re-route.)
- `worker/generator.test.js` — `node:test`, injected in-memory fakes for Mongo/Pub/Sub/Firestore, matching `worker/admission.test.js`'s `CasStore` style. Covers: hit serves from cache and publishes nothing; miss publishes exactly one message to `payload.model` with `cache:true` intact; malformed → nack; `cacheKey` stable per identical `(subtype,item)`, distinct across different ones, `null`/object `item` coerced deterministically.
- `worker/mongo.js` — shared Mongo helper extracted from `worker/index.js`'s current connection block. Exposes the client/db connect plus the collection-handle wiring both workers need. `worker/index.js`'s four existing collection handles (`ragCollection`/`promptCollection`/`toolCollection`/`modelConfigCollection`) are module-level `let`s reassigned inside `connectMongo` and read as free variables across many functions; the extraction must move `connectMongo` and expose those handles via a getter object or ES live-bindings (an imported binding cannot be reassigned). The generator opens its own `canned_responses` handle and ensures the `{cacheKey:1}` unique index idempotently on startup.
- `worker/cacheKey.js` — the single source of `cacheKey(subtype, item)` and `stableString(item)` (Data model below). Imported by BOTH `worker/generator.js` (lookup) and `worker/index.js` (write-through) so the key computed on write matches the key computed on lookup.
- `worker/report.js` — `reportToOrchestrator` extracted from `worker/index.js` (currently a private, non-exported function closing over `ORCHESTRATE_TOPIC`/`GCP_PROJECT_ID`) into a shared module both workers import. Behavior-preserving.
- `docker/Dockerfile.generator` — minimal Node 22 image (`COPY package.json`, `npm install`, `COPY worker/ config/`). No `ollama` base, no model bake, no GPU. Plain file, not `.ejs` (no per-model templating).

### Modified files

- `config/models.js` — add, mirroring the existing `FAKE_TOPIC`/`FAKE_SUBSCRIPTION`/`FAKE_DEAD_LETTER` block: `GENERATOR_TOPIC = "generator_cache_v1"`, `GENERATOR_SUBSCRIPTION`, `GENERATOR_DEAD_LETTER`.
- `pubsub/setup.js` — add a `[Generator cache]` provisioning block mirroring the `[Fake canned]` block: `ensureTopic(GENERATOR_DEAD_LETTER)`, `ensureTopic(GENERATOR_TOPIC)`, `ensureSubscription({...DEFAULT_SUB_CONFIG, topic: GENERATOR_TOPIC, subscription: GENERATOR_SUBSCRIPTION, deadLetter: GENERATOR_DEAD_LETTER})`.
- `worker/index.js` — (a) replace the inline Mongo connection block with an import from `worker/mongo.js`, and the `reportToOrchestrator` definition with an import from `worker/report.js` (no behavior change); (b) inside the existing `if (wrote)` block of the completion path (line 939), when `payload.cache === true`, upsert into `canned_responses` keyed by `cacheKey(payload.subtype, payload.item)` (from `worker/cacheKey.js`), `$set: {response: clean, subtype, item, updatedAt}` — persisting the marker-stripped `clean` (the same value written to the slot at line 929), not the raw `fullResponse`. `payload.item`/`payload.subtype` arrive on the forwarded message and are inert for the model worker's normal build (`buildStepMessages` reads `plan[step]` + `payload.query`, not `item`). Additive; inert for every job without `cache:true`. Update the in-file comments that assert "Mongo is RAG-only" (`worker/index.js` lines 6 and 924) to note the `canned_responses` exception.
- `scripts/dev.js` — add an always-up `start("Generator worker", "node", ["worker/generator.js"], {...})` block mirroring the existing "Fake worker" block. `SUBSCRIPTION_NAME: GENERATOR_SUBSCRIPTION`, `MONGO_*`; no `OLLAMA_*` env. No `scripts/waker.js` change (always-up, not MIG-woken).
- `dashboard/components/MenuForm.vue` — add a "route through cache (generator)" toggle that sets `cache: true` on the `/ai/menu` request body (the same form that already carries a menu request; net-new toggle, no existing `fake` toggle to mirror here). The backing model comes from the step definitions the menu builds, unchanged. Do not add the generator as a flat model-dropdown option (it has no standalone model of its own), and do not wire this onto `Request.vue`/`/ai/plan` — `planSchema` has no `fake`/`cache` field and that path never sets `job.cache`.
- `dashboard/server/api/health.get.ts` — add a `GENERATOR_TOPIC` existence check to both the prod and dev branches, mirroring the `FAKE_TOPIC` check already present.
- `CLAUDE.md` (repo root) — update the Databases table note "MongoDB … Not used for LLM results" to record the `canned_responses` fake/test-only exception.

### Data model

- Mongo collection `canned_responses`. Document: `{ cacheKey, subtype, item, response, updatedAt, createdAt }`. Unique index `{ cacheKey: 1 }`, ensured idempotently at generator worker startup. `cacheKey = ${subtype}:${stableString(item)}` where `stableString` coerces `null`/`undefined` to the literal `"null"` and any non-string `item` (day number, list entry, object) via a stable serialization so the key never becomes `[object Object]`.

### Prod deploy

- `scripts/deploy.js` / `scripts/deploy-all.js` — add a Cloud Run deploy step for the generator image (`docker/Dockerfile.generator`), min-instances = 1, no GPU, no MIG. Separate from `deploy:workers` (GPU MIG) and `deploy:orchestrator`.

## Target Design Docs

- `docs/design/worker-dispatch.md` — add the generator worker as a new, non-model consumer type (this doc currently documents only the model-worker dispatch/CAS; it has no fake or generator content): the `cache` job flag and its dispatch routing, its own topic/subscription, the cache-lookup → hit-complete / miss-forward flow, and the `payload.cache` write-through hook on the model worker's completion path (persisting `clean`). Fold Use Cases 1–2 below into its Use Cases section. State that the miss path adds no new dispatch primitive — it reuses the existing publish-to-model-topic wake and first-writer-wins completion.
- `docs/design/llm-pipeline.md` — add a Design Constraint recording that `canned_responses` in Mongo holds fake/test model output gated behind the `cache` flag, never a real job's `llmResults`; this is the one exception to the "results live in Firestore, Mongo is RAG-only" rule asserted in the root `CLAUDE.md` Databases table and `worker/index.js` comments.

## Parallel / Dependent Breakdown

- **Group A (prerequisite, must land first):** `worker/mongo.js` + `worker/report.js` + `worker/cacheKey.js`, with `worker/index.js` repointed to import all three. Behavior-preserving for the first two; `cacheKey.js` is new shared code. Gates C, D.
- **Group B (parallel with A):** `config/models.js` + `pubsub/setup.js` provisioning; `schemas.js` + `menu.js` + `dispatch.js` `cache`-flag persistence and routing. Gates D.
- **Group C (after A):** `worker/index.js` `payload.cache` write-through hook (imports `cacheKey.js`) + the "Mongo is RAG-only" comment/`CLAUDE.md` updates.
- **Group D (after A and B):** `worker/generator.js` + `worker/generator.test.js`.
- **Group E (after D):** `scripts/dev.js` wiring + `docker/Dockerfile.generator`.
- **Group F (parallel, independent):** dashboard `MenuForm.vue` toggle + `health.get.ts` check.
- **Group G (after E):** prod Cloud Run deploy step.

## Use Cases

### Use Case 1: Cache hit serves a stored response with no model call

- **Goal.** Return a previously-generated response for a `(subtype, item)` without invoking any GPU model.
- **Stakeholders.** Test/dev users who need realistic output fast and cheaply; platform ops (no GPU spend).
- **Actors.** Generator worker; Mongo `canned_responses`; Firestore.
- **Preconditions.** A job with `cache: true` is enqueued on `GENERATOR_TOPIC`; `canned_responses` holds a doc for `cacheKey = ${subtype}:${stableString(item)}`.
- **Postconditions.** The job's `llmResults/{jobId}/steps/{unitDocId}` slot is terminal `success` with the cached `response`; the orchestrator is reported to; the message is acked; no model topic was published to.
- **Basic Course of Events.**
  1. `worker/generator.js` receives the message, parses it, computes `cacheKey`.
  2. `getCannedResponse(cannedCollection, cacheKey)` returns the stored response.
  3. The worker runs the receive-claim transaction (`shouldRun`) then `completionWrite(slot, {attempt, status:"success", response})` against the slot.
  4. It calls the extracted `reportToOrchestrator` with `runStatus:"success"` and acks.
- **Alternate Flows.** None.
- **Exceptions.** Slot already terminal / superseded → `completionWrite` returns `null`, worker acks as no-op (Use Case 3 of [[worker-dispatch]]).

### Use Case 2: Cache miss forwards to the backing model and caches the result

- **Goal.** Produce a real model response for an uncached `(subtype, item)`, persist it for reuse, and complete the job — without the generator running any model itself.
- **Stakeholders.** Test/dev users; platform ops (one model run per unique key, then cached).
- **Actors.** Generator worker; backing GPU model worker (`worker/index.js`); MIG autoscaler; Mongo; Firestore.
- **Preconditions.** A job with `cache: true` is enqueued on `GENERATOR_TOPIC`; `payload.model` names a real model topic; no `canned_responses` doc exists for its `cacheKey`.
- **Postconditions.** The job's slot is terminal `success` with the real model's `clean` response; `canned_responses` holds a doc for `cacheKey`; the orchestrator is reported to; both messages are acked.
- **Basic Course of Events.**
  1. `worker/generator.js` receives the message, computes `cacheKey`, and `getCannedResponse` returns `null`.
  2. It publishes the same message, `cache:true` intact, to `payload.model`'s topic, then acks.
  3. Backlog on that model's subscription causes the MIG autoscaler to start a worker (dev: `scripts/waker.js`).
  4. `worker/index.js` runs generation, computes `clean` via `splitOutcome`, and writes the slot terminal `success` via `completionWrite` (line 929).
  5. Inside the same `if (wrote)` block, because `payload.cache === true`, it upserts `{cacheKey, subtype, item, response: clean}` into `canned_responses`.
  6. It calls `reportToOrchestrator` and acks — the plan advances exactly as for any normal step.
- **Alternate Flows.** A concurrent second miss for the same `cacheKey` forwards its own job; the second upsert overwrites the first (last-write-wins, no lock).
- **Exceptions.** The backing model run fails → `worker/index.js` writes the slot `fail` via its existing `catch`/CAS and does not reach the `if (wrote)` upsert; the orchestrator retries per its policy.

## Success Criteria

- A job published with `cache: true` is consumed by the generator worker and routed to `GENERATOR_TOPIC` (verified: `dispatch.js` publishes to `GENERATOR_TOPIC` when `cache` is set; the generator worker logs receipt, no model worker does).
- Toggling "route through cache" in `MenuForm.vue` sets `cache: true` on the `/ai/menu` body, which reaches `job.cache`, which makes `dispatch.js` publish the step's units to `GENERATOR_TOPIC` (verified: the published message carries `cache:true`, `item`, and `model:<real topic>`).
- A first run for a new `(subtype, item)` produces a `canned_responses` doc keyed `subtype:item` (distinct per diet) and a completed slot; a second identical run completes from cache with no model container started (verified in dev by watching worker stdout: cache-hit log on the second run, no `waker` model start).
- `npm run test` is green including `worker/generator.test.js`; `worker/admission.test.js`, `worker/semaphore.test.js`, `worker/ollama.test.js` still pass unchanged.
- The existing fake worker path is unchanged (its topic, subscription, and canned output are untouched).

## Testing Requirements

- **Unit (`worker/generator.test.js`, new):** injected in-memory fakes, no real Mongo/Pub/Sub/Firestore. Covers UC1 hit (serves from cache, publishes nothing), UC2 miss (publishes exactly one message to `payload.model` with `cache:true` intact), malformed payload → nack, and `cacheKey` derivation (stable per identical `(subtype,item)`, distinct across different diets, `null` and object `item` coerced deterministically — never `[object Object]`).
- **Unit (`worker/admission.test.js`, existing):** must still pass unchanged — proves the shared CAS the generator reuses is untouched.
- **Regression (Group A):** `npm run test` green after the `worker/mongo.js` + `worker/report.js` extractions, proving the refactors are behavior-preserving; plus a dev smoke run confirming the existing fake worker still completes a canned job end-to-end.
- **Integration (dev, manual):** per [[llm-pipeline]]'s functions-emulator flow — dispatch a `cache:true` job for a `protein_grid` step with two diets, twice. First run: two distinct `canned_responses` docs written (one per diet key), backing model woken. Second run: both complete from cache with no model start. No Firestore emulator (Firestore stays prod in dev).
- **Routing (dispatch):** a unit test or emulator check that `dispatch.js` publishes a `cache:true` job to `GENERATOR_TOPIC` (not `def.model`) and that the message carries `item` per unit — closing the two defects (missing `item`, missing route) this plan exists to fix.
