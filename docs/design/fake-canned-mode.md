---
modified: 2026-07-08
dependencies: [llm-pipeline, worker-dispatch]
---

# Fake / Canned Mode

The fake/canned-response transport — deterministic, no-Ollama output for dev and testing, delivered over the exact same Pub/Sub → worker → Firestore path as a real inference run. Read this before adding a canned subtype to `worker/cannedResponses.js`, before wiring a new client flow that passes `fake: true`, or when a fake run returns a generic stub where structured output was expected.

## Sensitive Areas

- **An unmatched `cannedKey` fails silently, not loudly.** `cannedResponse()` falls through to a plain string stub (`"Canned <subtype> response."`) when the key has no `BY_SUBTYPE` entry. A caller that expects structured output — e.g. `recipe_suggestion`'s strict JSON array — gets a valid-looking string back, marked `success`, and only discovers the problem as a downstream parse failure. If `subtype` isn't forwarded end-to-end (client → orchestrator → Pub/Sub message → worker), the symptom is a silent stub, never an error.
- **Canned output must match the real parser contracts byte-for-byte where a parser exists.** `nutrients` must emit the exact `Day | Mealtime | Calories | Protein g | Sodium mg | Carbs g` header (the `plan_library` + `seed-recipes-nutrients.mjs` contract); `protein_grid` must emit `Day | Mealtime | Type | Cut` rows; `recipe_suggestion` must emit a plain JSON array (no fences, no wrapping object). Drift here makes fake runs pass while real runs fail, or vice versa.
- **`compliance` must emit the terminal `@@::PASS::@@` block** — the worker's `splitOutcome` reads it to mark the run `success`, exactly like a real compliance step. Removing the block changes the run's terminal status semantics.
- **The canned `planner` must return a valid YAML step list** routed back to `FAKE_TOPIC`, or `build.js` rejects it and the fake pipeline never dispatches step 0. The planner carries no `subtype` (type `"planner"`), which is why the worker's key resolution falls back to `payload.type`.
- **A dish exists once and declares the diets it satisfies.** Canned data must never put meat on a vegan grid, and it must never carry the same dish under a per-diet rewording — the entrée catalogue (`MAIN_ENTREES`/`BREAKFAST_ENTREES`) is SHARED, and a diet selects from it by declaration (`entreePoolFor`). Keying a pool by diet is what put "Egg scramble", "Egg & veggie scramble" and "Plain egg scramble" in one cell as three dishes. `PROTEIN_POOLS` stays keyed by diet: it answers which raw protein a diet may be assigned, not which dish it is served.

## Design Constraints

- **Fakes use the real transport.** A fake job flows through actual Pub/Sub publish → worker subscription → Firestore write — never a client-side simulation. The only difference from a real run is the topic it's published to.
- **One shared topic** (`FAKE_TOPIC = "fake_canned_v1"`, `config/models.js`) — no per-model fake topics.
- **Deterministic.** Same input → same output. Variation comes from an FNV-1a hash seeded by `(diet, day, meal)`, never from randomness.
- **No artificial delay.** The canned branch skips the generation gate and Ollama entirely; output is pushed through the same chunk flusher immediately.
- The fake worker is CPU-only (no GPU, no `OLLAMA_MODEL`, no web-search key) but still requires GCP, Mongo, and Firestore config like any worker (`worker/index.js` `FAKE_ONLY` required-env branch).
- The fake worker is part of the standard deploy (`scripts/deploy.js` `deployFake()`), and `pubsub/setup.js` provisions `FAKE_TOPIC`/`FAKE_SUBSCRIPTION`/`FAKE_DEAD_LETTER` alongside the real model topics.

## Feature Overview

Real inference runs on GPU VMs behind Ollama: slow, costly, non-deterministic, and sometimes simply not running in dev. That makes it a poor substrate for UI development, E2E tests, and pipeline plumbing checks, where what's under test is the transport and the parsers — not the model. Fake/canned mode gives every LLM entry point a `fake: true` escape hatch: the job is dispatched to a dedicated canned topic instead of a model topic, and a CPU worker returns deterministic, contract-shaped output through the identical Firestore write path. Because nothing downstream of topic selection changes, a fake run exercises the full real pipeline — dispatch, admission CAS, streaming flusher, completion transaction, orchestrator reports — with zero inference cost and stable output.

## Architecture

Routing happens at the orchestrator (`/ai` Firebase Function), which is the single dispatch authority for topic selection:

- **Single-shot query** (`functions/entry/ai/query.js`): `POST /ai/query` destructures `{ query, context, history, userId, companyId, companyName, fake, style, subtype }` from `req.body`. `const topic = fake ? FAKE_TOPIC : DEFAULT_QUERY_TOPIC`. It writes the `llmResults/{jobId}` doc with `subtype: subtype || ""` and `fake: !!fake`, then publishes `{ jobId, query, type: "task", subtype: subtype || "", model: topic, fake: !!fake, style }` to that topic.
- **Orchestrated pipeline** (`functions/entry/ai/menu.js` → `functions/entry/ai/dispatch/dispatch.js`): the build endpoint stores `fake: isFake` on the job doc; `dispatchStep()` reads `const fake = job.fake === true` and publishes each unit to `fake ? FAKE_TOPIC : def.model`. A fake step message additionally carries `fake: true`, the unit's `item` (its fan-out slice — a diet string, or a `{diet, day}` object for the day-fanned recipes step), and `ctx: { days, meals, proteins }` so the canned function can honour the unit's fan-out slice and mirror the committed protein grid. `subtype` comes from the step definition (`def.subtype`).
- **Worker** (`worker/index.js`): a worker whose `SUBSCRIPTION_NAME` equals `FAKE_SUBSCRIPTION` runs with `FAKE_ONLY = true` and cans everything routed to it — the fake topic behaves as a first-class model tier. The canned branch (`if (FAKE_ONLY || payload.fake)`, ~line 883) resolves `const cannedKey = payload.subtype || payload.type` (~line 890), calls `cannedResponse(cannedKey, payload)`, and pushes the result through the same chunk flusher → Firestore path a real generation uses. Everything after that point — `splitOutcome`, the first-writer-wins completion transaction, the orchestrator report — is the shared code path (see [[worker-dispatch]]).
- **Registry** (`worker/cannedResponses.js`): `cannedResponse(subtype, payload)` looks the key up in `BY_SUBTYPE` and falls through to the generic string stub on no match.

### Worked example: adding a new canned case (`recipe_suggestion`)

`recipe_suggestion` is the recipe-preview batch (protein grid → recipe suggestions) and shows the full pattern:

1. **Client sends `subtype`**: the yeschef app calls `POST /ai/query` with `fake: true, subtype: "recipe_suggestion"`. `query.js` forwards `subtype` into both the `llmResults` doc and the Pub/Sub message — without this forwarding the worker would resolve `cannedKey` to `"task"` and return the generic stub.
2. **Write the canned function** (`cannedRecipeSuggestion(payload)` in `worker/cannedResponses.js`): diet-aware via `recipePoolForDiet(payload.item)`, it takes the first two pool entries and returns `JSON.stringify(...)` of a strict JSON array — plain array, no fences, no wrapping object — of `{ proteinType, name, components[], nutrition{} }`, matching exactly what the client's `parsePreviewResponse` expects from a real model. `proteinType` is not taken from the pool: it echoes the protein named in the prompt's numbered target lines (`N. <proteinType> — cut: …` — regex over `payload.query`, multi-word proteins included), because the client discards items whose `proteinType` doesn't match the requesting slot — a canned response, like a real one, must mirror the request's parameters, not invent its own.
3. **Register it**: add `recipe_suggestion: cannedRecipeSuggestion` to `BY_SUBTYPE`.
4. **Test it** (`worker/cannedResponses.test.js`): assert the output parses as a JSON array of objects with `name` (string) and `components` (array).

## Functions

| Function | File | Role |
|---|---|---|
| `post` | `functions/entry/ai/query.js` | Routes a single-shot query to `FAKE_TOPIC` when `fake: true`; writes `subtype`/`fake` to the doc and message. |
| `dispatchStep` | `functions/entry/ai/dispatch/dispatch.js` | Routes a step's units to `FAKE_TOPIC` when `job.fake === true`; adds `fake/item/ctx` to the message. |
| `cannedResponse` | `worker/cannedResponses.js` | Registry lookup by subtype; generic string stub on no match. |
| `cannedPlanner` | `worker/cannedResponses.js` | Valid YAML plan with one step routed back to `FAKE_TOPIC` so `build.js` can parse and dispatch. |
| `cannedCompliance` | `worker/cannedResponses.js` | Compliance summary ending in the terminal `@@::PASS::@@` block. |
| `cannedMenuPlan` | `worker/cannedResponses.js` | YAML week of days; echoes the unit's rendered prompt (`payload.query`) as a comment. |
| `cannedRecipe` | `worker/cannedResponses.js` | Single-recipe YAML detail matching the `recipe:` output template in `prompt_library`; diet-aware via `recipePoolForDiet`. |
| `cannedProteinGrid` | `worker/cannedResponses.js` | `Day \| Mealtime \| Type \| Cut` rows per the unit's diet/meals/days; FNV-1a-seeded per slot. |
| `cannedRecipes` | `worker/cannedResponses.js` | `Day \| Mealtime \| Dish \| Protein \| Starch \| Vegetable \| Fruit` rows. Each slot's protein comes from the committed grid (`ctx.proteins`, seeded server-side at the `/ai` plan-build) so recipes MIRROR the grid; only slots with no grid protein fall back to the rotating entrée catalogue. The recipes step fans out per `(diet, day)`, so `payload.item` is a `{diet, day}` slot → emits ONLY that day (a diet-string `item` still emits all days for back-compat). |
| `cannedNutrients` | `worker/cannedResponses.js` | Exact 4-column nutrients pipe table; diet-shaped coefficients + per-slot jitter so every diet's table is distinct. |
| `cannedRecipeSuggestion` | `worker/cannedResponses.js` | Strict JSON array of `{proteinType, name, components[], nutrition{}}` (see worked example above). |
| `poolForDiet` | `worker/cannedResponses.js` | Map a diet string to its raw-protein pool; default omnivore. |
| `entreePoolFor` / `recipePoolForDiet` | `worker/cannedResponses.js` | Narrow the ONE entrée catalogue for this daypart to the dishes declaring this diet, minus what a halal/kosher restriction forbids. |
| `fnv1a` | `worker/cannedResponses.js` | Deterministic hash seeding per-slot selection/jitter. |

## Models

**Config** (`config/models.js`): `FAKE_TOPIC = "fake_canned_v1"`, `FAKE_SUBSCRIPTION = "sub_fake_canned_v1"`, `FAKE_DEAD_LETTER = "dead_letter_fake_canned_v1"`, and `FAKE_MODEL_OPTION = { value: FAKE_TOPIC, label: "Fake (canned)" }` — the single presentation of fake as a pickable model option.

**Message shapes carrying the fake flag:**
- Query: `{ jobId, query, type: "task", subtype, model: topic, fake, style }`
- Step unit: `{ jobId, step, unit, attempt, type: "step", model: def.model, subtype: def.subtype, tools, fake: true, item, ctx: { days, meals }, style?, report?, query? }` (fake-only fields appear only when the job is fake; `model` still names the step's real model even though the message is published to `FAKE_TOPIC`).

**`llmResults` doc** (query path): `{ jobId, query, type, subtype, model, fake, status, response, uid, companyId, organization, context, isDeleted, createdAt, completedAt }`. The job doc for an orchestrated build carries `fake: isFake` at the job level.

**`BY_SUBTYPE` registry** (complete, `worker/cannedResponses.js`):

| Key | Function | Output shape |
|---|---|---|
| `planner` | `cannedPlanner` | Fenced YAML step list (one step, `model: fake_canned_v1`, `subtype: task`) |
| `compliance` | `cannedCompliance` | Markdown checklist + `@@::PASS::@@` terminal block |
| `menu_plan` | `cannedMenuPlan` | Fenced YAML week (days → meals) |
| `recipe` | `cannedRecipe` | `recipe:` YAML detail (batch/prep/service/holding/elevation) |
| `protein_grid` | `cannedProteinGrid` | Pipe rows: `Day \| Mealtime \| Type \| Cut` |
| `recipes` | `cannedRecipes` | Pipe rows: `Day \| Mealtime \| Dish \| Protein \| Starch \| Vegetable \| Fruit` |
| `nutrients` | `cannedNutrients` | Pipe rows: `Day \| Mealtime \| Calories \| Protein g \| Sodium mg \| Carbs g` |
| `recipe_suggestion` | `cannedRecipeSuggestion` | Strict JSON array of `{proteinType, name, components[{ingredient, category, quantity, unit, prep}], nutrition{kcal, proteinG, fatG, carbG, sodiumMg, potassiumMg, phosphorusMg}}` |

Any other key → the string `` `Canned ${subtype || "step"} response.` ``.

**Pools:** `PROTEIN_POOLS` — `[type, cut]` pairs keyed by diet (vegan/vegetarian/renal/halal/kosher/omnivore). **Entrées are NOT keyed by diet:** `MAIN_ENTREES` and `BREAKFAST_ENTREES` are one shared catalogue per daypart of `[dish, protein, cookedIn, diets]`, where `cookedIn` is only what is cooked INTO the dish (never an accompaniment — those are dishes at their own course positions) and `diets` is the dish's own declaration. Catalogue ORDER is the menu: a slot takes a contiguous slice, so protein families are interleaved.

## Use Cases

### UC1 — Developer tests the recipe-suggestion client flow without inference

- **Goal:** Exercise the client's recipe-preview flow (request → stream → parse → render) with deterministic output and no GPU cost.
- **Stakeholders:** Frontend developers, test engineers, whoever pays the GPU bill.
- **Actors:** A developer (or an E2E test) driving the yeschef client; the `/ai` orchestrator; the fake worker.
- **Preconditions:** `FAKE_TOPIC`/`FAKE_SUBSCRIPTION` provisioned (`pubsub/setup.js`); a worker draining `FAKE_SUBSCRIPTION` (or any worker, since `payload.fake` is also honored per-message).
- **Postconditions:** `llmResults/{jobId}` holds `status: "success"` and a `response` that is a strict JSON array parseable by the client's `parsePreviewResponse`.
- **Basic Course of Events:**
  1. The client POSTs `/ai/query` with `{ query, fake: true, subtype: "recipe_suggestion", context: ... }`.
  2. `query.js` selects `topic = FAKE_TOPIC`, writes the `llmResults` doc (`subtype`, `fake: true`), and publishes the message with `subtype` and `fake` alongside `type`/`style`.
  3. The fake worker receives the message; `FAKE_ONLY || payload.fake` is true.
  4. The worker resolves `cannedKey = payload.subtype || payload.type` → `"recipe_suggestion"`.
  5. `cannedResponse("recipe_suggestion", payload)` calls `cannedRecipeSuggestion`, which picks two dishes from `recipePoolForDiet(payload.item)` (the shared entrée catalogue, narrowed to that diet), stamps each with the proteinType echoed from the prompt's target lines, and returns the JSON array string.
  6. The worker pushes the string through the chunk flusher, then runs the standard completion transaction — the doc goes `success` with the canned `response`.
  7. The client's `onSnapshot` listener sees the completed doc and parses the array.
- **Alternate Flows:** The message carries `item: "vegan"` (or any diet) → the pool switches and the suggestions contain no meat; parsing and rendering are otherwise identical.
- **Exceptions:** `subtype` omitted or dropped anywhere along the chain → step 4 resolves to `"task"`, `cannedResponse` returns the generic string stub, the run still completes `success`, and the client's JSON parse fails downstream (see Sensitive Areas — this is a silent failure by design of the fallback, not a worker error).

### UC2 — Developer runs a full fake pipeline build

- **Goal:** Verify the whole orchestrated pipeline — plan parse, step dispatch, fan-out, reports, cascade — without any model inference.
- **Stakeholders:** Pipeline developers; test engineers validating orchestration changes.
- **Actors:** A developer calling the build endpoint; the orchestrator; the fake worker.
- **Preconditions:** Fake topic/subscription provisioned; a fake worker running; the job's plan steps carry `subtype` values with `BY_SUBTYPE` entries.
- **Postconditions:** Every step's run docs (`llmResults/{job}/steps/{unit}`) are terminal `success` with contract-shaped canned output; the job completes end-to-end.
- **Basic Course of Events:**
  1. The caller POSTs the build endpoint (`functions/entry/ai/menu.js`) with `fake: true`; the job doc stores `fake: isFake`.
  2. The planner step is dispatched to `FAKE_TOPIC`; carrying no `subtype`, the worker's key falls back to `type` (`"planner"`) and `cannedPlanner` returns a valid YAML plan whose one step is itself routed to `FAKE_TOPIC`.
  3. `build.js` parses the canned plan and dispatches step 0 via `dispatchStep`.
  4. `dispatchStep` reads `job.fake === true` and publishes each unit to `FAKE_TOPIC` with `fake: true`, the unit's diet as `item`, and `ctx: { days, meals }`.
  5. The fake worker cans each unit by its step `subtype` (e.g. `protein_grid`, `recipes`, `nutrients`, `compliance`) and writes through the normal completion path.
  6. Each unit's `report: "step"` pings the orchestrator, which advances the cascade until the plan is exhausted.
- **Alternate Flows:** A `compliance` step returns `@@::PASS::@@` → `splitOutcome` strips the block, the run is `success`, and the orchestrator advances exactly as with a real model's PASS.
- **Exceptions:** A step's `subtype` has no registry entry → the generic stub is returned and the run is still `success`; whether the pipeline breaks depends on whether the next step's parser needs structured input (see Sensitive Areas). A missing fake topic surfaces as gRPC 5 NOT_FOUND at publish time → `dispatchStep` marks the job `fail` with a topic-not-found outcome.

## Tests

`worker/cannedResponses.test.js` (`node --test`, per-function convention — each canned function gets targeted assertions):

- `nutrients`: exact contract header, all-numeric columns, distinct table per diet (regression: identical-coefficient diets used to collapse), diet shaping (renal ↓ sodium/protein, diabetic ↓ carbs), determinism.
- unknown subtype: falls back to the generic stub.
- `planner`: parseable fenced YAML routed back to the fake topic.
- `compliance`: emits the terminal `@@::PASS::@@` block.
- `menu_plan`: echoes the unit context, yields a week of days.
- `recipe`/`recipes`/`protein_grid`: honor the diet pool (vegan output contains no meat), correct pipe headers.
- `recipe_suggestion`: output is a strict JSON array where every item has a string `name` and an array `components`.

The routing side (topic selection in `query.js`/`dispatch.js`, the worker's canned branch) has no dedicated unit tests; it is exercised by running fake jobs through the dev stack.

## UI/UX

No UI/UX in this repo beyond one element: the dashboard's model dropdown includes `FAKE_MODEL_OPTION` ("Fake (canned)") so a job can be pointed at the fake tier by hand. The client-side fake toggle that sets `fake: true` on requests lives in the yeschef app (see the yeschef repo's protein-recipe-suggestion docs), not here.

## Dependencies

- [[llm-pipeline]] — the real dispatch pipeline (topics, workers, Firestore write path) that fake mode rides on; fake changes only the topic-selection step.
- [[worker-dispatch]] — admission CAS, attempt semantics, and the first-writer-wins completion transaction. Fake runs use that machinery unchanged; this doc deliberately does not restate it.

## Diagrams

```
                         fake: true?
POST /ai/query ── query.js ──┬─ yes ──► FAKE_TOPIC ─────────┐
                             └─ no ───► model topic          │
                                                             ▼
build/resume ── dispatchStep ─┬─ job.fake ─► FAKE_TOPIC ► fake worker (FAKE_ONLY)
                              └─ else ────► def.model        │
                                                             ▼
                                       cannedKey = payload.subtype || payload.type
                                                             │
                                        BY_SUBTYPE[cannedKey] ── hit ──► canned function(payload)
                                                             └─ miss ─► "Canned <key> response."
                                                             │
                                          chunk flusher ► splitOutcome ► completion CAS
                                                             ▼
                                            Firestore llmResults (same path as real)
```

## References

No external references — this subsystem is internal convention only. Internal contracts it must track: the `prompt_library` output templates (the `recipe:` YAML shape) and the nutrients pipe-table contract shared with `seed-recipes-nutrients.mjs`.
