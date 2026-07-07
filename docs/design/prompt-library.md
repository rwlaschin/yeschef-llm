---
modified: 2026-07-06
dependencies: [llm-pipeline, plan-orchestration]
---

# Prompt Library

The worker/planner system-prompt store (Mongo `prompt_library`, assembled by subtype, authored via the dashboard's Prompts page) and the writing discipline its prompts must follow. Read this before editing any prompt in `prompt_library`, or before writing a new step type's prompt.

## Sensitive Areas

- **No versioning on `prompt_library` today** — back up before editing (`scripts/_prompt_backup.mjs`). An in-place edit that breaks format compliance breaks every step using that prompt immediately, with no rollback except a manual restore.
- **Format compliance is load-bearing, not cosmetic.** The `<@@::PASS/FAIL::@@>` marker (see [[plan-orchestration]]) is parsed programmatically while streaming; a prompt change that lets the model wrap or fuse the marker breaks the orchestrator's advance logic.

## Design Constraints

- **Zero prompts in code.** All LLM/AI prompts live in Mongo `prompt_library`, fetched via the worker's cache layer — never hardcoded in `worker/**` or `functions/**`.
- Prompt keys use **space-delimited** output-template YAML keys (not snake_case), except `web_search`/`web_fetch`/`menu_plan`, which stay underscored.
- Every step must be **self-contained**: the executing agent sees only its step's `instructions` (+ listed `contexts`) — never the original user request. Anything not copied verbatim into the step is lost.

## Feature Overview

Prompt quality, not model size, is what determines whether a small/fast model (`llama3.1:8b`) holds a strict output format reliably. This doc distills the discipline behind developit-ai's prompts (`developit-ai/llm/modules/llm/prompts.py` — `LLM_CONTEXT_PROMPT`, `CONTEXT_SYSTEM_INSTRUCTIONS`), which hit ~99% format compliance running mostly on cheap/fast models, into the rules every prompt in `prompt_library` should follow. It exists so that new prompts (or edits to existing ones) don't have to rediscover these lessons from scratch by trial and error against a live model.

## Architecture

Prompts are stored in Mongo `prompt_library`, keyed and assembled by subtype (see [[plan-orchestration]]'s `plan[].subtype`), and cached in-process by the worker (`caches.js`-equivalent load/cache layer — see the worker-refactor plan for exact module boundaries). The dashboard's Prompts page is the sole authoring surface; there is no code path that constructs a prompt string outside this store.

**The writing rules (source: developit-ai, adapted):**

1. **Every step is self-contained** — copy exact counts/numbers, full URLs and named sources, banned/required items, all constraints, and the exact output format verbatim into the step. Omitted context is lost; when in doubt, include it.
2. **Every step ends with explicit `PASS:`/`FAIL:` criteria** — the rubric the agent judges itself against. Concrete and checkable ("executes without runtime errors and output exactly matches X"), never vague ("works correctly"). A step without a rubric is invalid.
3. **Create, then validate, as separate steps** — a creation step is immediately followed by a distinct validation step targeting a *single* artifact, so its `failStep` is unambiguous. Never let one step both produce a deliverable and rubber-stamp its own success.
4. **Show a concrete worked example**, not just prose rules — models pattern-match from a literal example far more reliably.
5. **Define the status/output marker once, consolidated** — placement → delimiters → literal PASS form + when to use it → literal FAIL form + when to use it → "must be the very last element, nothing after." Show both forms side by side; never scatter or restate the definition per-subtype (it drifts).
6. **Lean toward failure** — state explicitly: "critically review the response and lean toward failure for any error that produces an incorrect, incomplete, or unusable result, or leaves any requirement unmet." An optimistic judge rubber-stamps; a skeptical one makes the verdict mean something.
7. **Deliverable first, marker after, never wrapped** — the deliverable comes first in full, then the marker as a separate final line; the marker is never part of the deliverable. Without this a weak model fuses its output into the marker (observed: `<@@::meal_plan:: …yaml… ::@@>`). Between the delimiters goes only the token, never a YAML key or other content.
8. **Distinctive, named markers** — developit uses `<?!PLAN_STATUS::PASS::PLAN_STATUS!?>`; we use the shorter `<@@::…::@@>` (see [[plan-orchestration]]). A named bookend can't false-trigger from prose. The named form is a robustness lever to reach for if a model keeps fumbling the shorter one.
9. **"EXACT AND LITERAL", repeated, capitalized, for non-negotiables** — weak models need the truly-non-bendable rules hammered ("No other characters are permitted", "nothing else", "MUST"); reserve the emphasis for the few things that truly can't vary.
10. **Output hygiene stated as negatives** — "Output ONLY the deliverable. No preamble, no commentary, no metadata, no markdown fences" — plus fence-nesting rules and "output/print from code must NOT be wrapped in fences." State what NOT to emit explicitly; don't assume the model infers it.
11. **Let the planner pick the model per step** — hand it a models list with a one-line `purpose` each, and instruct it to pick the most cost-effective/fastest fit. Run the planner itself at low temperature (developit uses 0.1) for deterministic plans.
12. **Personas embodied, not announced** — "embody this persona through tone and vocabulary; do not introduce yourself or describe your identity."
13. **Scope discipline baked into the prompt** — e.g. "when bug fixing, do NOT refactor unless asked — no renames, no style changes; if a fix needs a change, it must address only the bug." Constraints the model should always honor belong in the prompt, not left to chance.

## Functions

**`dashboard/server/api/admin/prompt.post.ts`** — creates a `prompt_library` entry.
**`dashboard/server/api/admin/prompts.get.ts`** — lists entries newest-first, excluding soft-deleted (`isDeleted: {$ne: true}`).
**`dashboard/server/api/admin/prompt.put.ts`** — updates an entry by `?id=`.
**`dashboard/server/api/admin/prompt.delete.ts`** — soft-deletes an entry by `?id=` **and deactivates it**, so the worker never loads it even before its in-process cache refreshes — a soft-delete that isn't also deactivated would leave a stale prompt live until the next cache cycle.
The worker's own prompt cache/load layer (assembly by subtype from these entries) and the marker parser (`worker/steps/outcome.js`) are documented under [[plan-orchestration]].

## Models

`prompt_library` document (MongoDB):
```json
{
  "_id": "ObjectId",
  "mapping": { "<type>": "<priority>" },
  "active": true,
  "content": "the prompt text, exactly as authored",
  "modelOverride": null,
  "isDeleted": false,
  "createdAt": "Date",
  "updatedAt": "Date"
}
```
`mapping` is how an entry attaches to one or more request `type`s (with a priority, for when more than one entry maps to the same type). `modelOverride: null` means "use the request's model" — a non-null value pins this prompt's step to a specific model regardless of what the request asked for (used by the planner override in [[plan-orchestration]]).

## Use Cases

### Use Case 1: Author or edit a prompt for a request type

**Goal:** A prompt engineer creates or edits the system prompt that will be sent to the worker for a given request `type`, so that a small/fast model holds the required output format.

**Stakeholders:** Prompt engineers/admins authoring prompts; the worker operator, whose format-compliance rate depends on prompt quality; end users, whose requests are served by whatever prompt is active for their request type.

**Actors:** An admin user, via the dashboard's Prompts page (`dashboard/pages/prompts.vue`, `dashboard/components/prompts/PromptForm.vue`).

**Preconditions:** The admin has access to the dashboard's Prompts page. For an edit, the target `prompt_library` document already exists and its `_id` is known to the page.

**Postconditions:** A `prompt_library` document exists (or is updated) with `content`, `mapping` (request type → order key), `active`, and `modelOverride`. The change is persisted in Mongo and will be picked up by the worker's prompt cache (immediately in dev, within a few requests in prod — see Alternate Flows).

**Basic Course of Events:**
1. Admin opens the Prompts page and selects "New Prompt" (or an existing entry to edit).
2. `PromptForm.vue` renders the editor: an "Active" toggle, a multi-select of request types (`availableTypes`) this prompt should map to, a "Model override" dropdown (default: "Not set — use the request's model"), and a `MarkdownEditor` content field.
3. Admin writes/edits `content` following the writing rules (self-contained step, explicit PASS/FAIL rubric, worked example, etc. — see Architecture), and selects one or more request types.
4. Admin clicks Save. The form is disabled from saving until `content` is non-empty and at least one type is selected (`canSave`).
5. The page calls `POST /api/admin/prompt` (new) or `PUT /api/admin/prompt?id=<id>` (edit) with `{ mapping, active, content, modelOverride }`.
6. The API upserts the document in `prompt_library`, setting `updatedAt` (and `createdAt`, `isDeleted: false` on create).
7. The worker's `getPrompts()` cache is stale until its next refresh (see Alternate Flows); once refreshed, `systemPromptFor(type)` includes this prompt's `content` for any type in its `mapping`, joined with any other prompts mapped to that same type in ascending order of their `mapping[type]` order key.

**Alternate Flows:**
- **Dev environment:** `INCLUDE_INACTIVE` is true (`NODE_ENV` doesn't match `/prod(uction)?/i`), so `getPrompts()` re-queries Mongo on every call — an edit is visible on the very next request, and inactive prompts are included too, so an admin can stage/preview a prompt before flipping Active on.
- **Prod environment:** only `active: true` prompts load, and the cache refreshes probabilistically (~5% of lookups trigger a re-query, no TTL) — an edit can take a variable number of requests to take effect, never a fixed delay.
- **Multiple prompts share a request type:** each prompt's `mapping[type]` value acts as a sort/order key (a lexBetween-style string, not a numeric priority); `systemPromptFor(type)` joins all matching prompts' `content`, sorted ascending by plain code-unit string compare — the same ordering the dashboard's drag-drop list produces and the same comparator the dashboard's own preview endpoint (`GET /api/llm/system-prompt`) uses, so the preview always matches what the worker actually builds.
- **Setting a model override:** choosing a value other than "Not set" writes a non-null `modelOverride`, pinning this prompt's step to that model regardless of the request's own model — a way to force a specific step (e.g. planner) onto a specific model.

**Exceptions:**
- Missing/invalid `id` on a `PUT` or `DELETE` → `400 Missing id parameter` / `400 Invalid id format`.
- `PUT` against a non-existent `_id` → `404 Prompt not found`.
- `content` empty or no request type selected → Save button stays disabled client-side; the request is never sent.
- Mongo write failure on create/update/delete → the API returns `500` with the underlying error message; no partial write is left in an ambiguous state (single `insertOne`/`updateOne` call).

### Use Case 2: Worker assembles the system prompt for an incoming request

**Goal:** The worker builds the exact system prompt text to send to Ollama for a request's `type`, using only what's currently active in `prompt_library`.

**Stakeholders:** End users waiting on a response; the worker operator, who needs prompt assembly to be deterministic and debuggable.

**Actors:** The worker process (`worker/index.js`), triggered by an incoming Pub/Sub job.

**Preconditions:** `prompt_library` contains zero or more non-deleted documents; the worker process is running and connected to Mongo.

**Postconditions:** `systemPromptFor(type)` returns a single string — the joined `content` of every prompt mapped to that type — which is embedded under the `# User Prompt`-adjacent labeled sections built by `steps/prompt.js` and sent to Ollama.

**Basic Course of Events:**
1. A job for message `type` arrives at the worker.
2. The worker calls `getPrompts()`, which returns the in-process `promptCache` if present and not due for refresh, else queries Mongo with `filter = { isDeleted: { $ne: true } }` (plus `active: true` in prod) and repopulates the cache.
3. `systemPromptFor(type)` filters the cached prompts to those whose `mapping[type]` is set, sorts them ascending by `mapping[type]` (code-unit compare), and maps to their `content`.
4. Stray markdown escape backslashes left by older editor saves (e.g. `\#`, `\-`) are stripped from each prompt's content before joining, so the model receives clean markdown.
5. The joined string becomes the system-prompt body, assembled by `steps/prompt.js`'s `section`/`joinSections` helpers alongside other labeled sections (tools, subtypes, the user's request) into the final request sent to Ollama.

**Alternate Flows:**
- **No prompt maps to the type:** `systemPromptFor(type)` returns an empty string; for the planner specifically, this logs `planner prompt EMPTY — nothing maps to "planner" in prompt_library"` (`worker/steps/planner.js`) rather than failing silently.
- **Mongo temporarily unreachable during a scheduled cache refresh:** `getPrompts()` catches the error, logs `prompt_library load failed (...) — using cached/empty set`, and continues serving the last good `promptCache` (or an empty array if there was never a successful load) rather than failing the request.

**Exceptions:**
- A prompt's `content` is blank/whitespace-only → it is filtered out (`.filter(Boolean)`) and contributes nothing to the joined result, rather than inserting an empty section.
- Two prompts map to the same type with equal order keys → both are included, in whatever order Mongo returns them (the sort is stable but ties are not otherwise broken) — an authoring-time hazard rather than a runtime error.

### Use Case 3: Retire a prompt without losing the ability to restore it

**Goal:** An admin removes a prompt from active use — because it's wrong, superseded, or being replaced — without permanently destroying it or leaving it live in the worker's cache.

**Stakeholders:** The admin performing the removal; the worker operator, who needs the retired prompt to stop affecting live requests immediately; anyone who might need to recover the prompt later.

**Actors:** An admin user, via the dashboard's Prompts page.

**Preconditions:** The target `prompt_library` document exists and is not already soft-deleted.

**Postconditions:** The document has `isDeleted: true` and `active: false`; it is excluded from every subsequent `getPrompts()`/`loadPrompts()` load (dev and prod alike, since the `isDeleted` filter is unconditional) and from the admin list view.

**Basic Course of Events:**
1. Admin selects "Delete" on a prompt in the Prompts list.
2. The page calls `DELETE /api/admin/prompt?id=<id>`.
3. `prompt.delete.ts` runs `updateOne({ _id }, { $set: { isDeleted: true, active: false, updatedAt: new Date() } })` — a soft delete, never a document removal.
4. The response confirms `{ success: true }`; the dashboard's list view (which excludes `isDeleted: {$ne: true}`) no longer shows the entry.
5. The worker's next cache load excludes the document via its `isDeleted: { $ne: true }` filter, regardless of environment.

**Alternate Flows:**
- **Restoring a soft-deleted prompt:** not exposed in the current UI or API — recovery requires a direct Mongo update (or restoring from one of the timestamped backups produced by `scripts/_prompt_backup.mjs`) since no "undelete" endpoint exists today.

**Exceptions:**
- Missing/invalid `id` → `400` (`Missing id parameter` / `Invalid id format`).
- `_id` not found (`matchedCount === 0`) → `404 Prompt not found`.
- Deactivating without also marking `isDeleted` would leave the worker still excluding it correctly in prod (`active: true` filter) but NOT in dev (`INCLUDE_INACTIVE` loads inactive prompts too) — this is why delete always sets both fields together rather than just `active: false`.

### Use Case 4: Back up `prompt_library` before an in-place edit

**Goal:** An admin captures the full current state of `prompt_library` before making a risky in-place edit, since the collection has no built-in versioning.

**Stakeholders:** The admin making the edit; the worker operator, who needs a rollback path if the edit breaks format compliance for every step using that prompt.

**Actors:** An admin/developer running a script from a local shell.

**Preconditions:** `MONGO_URI` (and optionally `MONGO_DB`, `PROMPT_COLLECTION`) are set in the environment; the operator has network access to the target Mongo instance.

**Postconditions:** A timestamped or manually-named JSON file (`prompt_library.backup.<stamp>.json`) exists on disk containing every document currently in the collection, and each document's `_id`, mapped types, `active` state, and content length/body have been printed to the console for a quick sanity check.

**Basic Course of Events:**
1. Operator runs `node scripts/_prompt_backup.mjs [stamp]`.
2. The script connects to Mongo, fetches every document in the configured collection (default `prompt_library`) with no filter (including soft-deleted and inactive documents).
3. It writes the full array to `prompt_library.backup.<stamp>.json` (`stamp` defaults to `"manual"` if not given).
4. It prints, per document, its `_id`, mapped type(s), `active` flag, and content length, followed by the full content — so the operator can visually confirm the backup before proceeding with the edit.
5. Operator makes the intended edit (via the dashboard or a direct Mongo update), confident a pre-edit snapshot exists.

**Alternate Flows:**
- **Restoring from a backup:** not automated — an operator restores by hand from the JSON file (there is no `_prompt_restore.mjs` counterpart), consistent with this being a manual/ad hoc safety net rather than a versioning system.

**Exceptions:**
- `MONGO_URI` missing/invalid → the `MongoClient` connection fails and the script throws before producing a backup file — no partial/empty backup is silently written.

## Tests

No automated tests validate prompt *content* against these rules (this is a writing discipline, not code) — the closest automated check is the marker parser's own test suite (`worker/steps/outcome.test.js`), which tests the parsing side, not prompt quality.

## UI/UX

Authored via the dashboard's Prompts page (`dashboard/pages/prompts.vue`, `dashboard/components/prompts/PromptForm.vue`, `PromptsList.vue`) — feature-level panels, not individually mocked-up. The editor field itself is a shared primitive with its own mockup: [[markdown-editor]] (CodeMirror-backed, pure pass-through — no markdown rendering, by design, since prompt whitespace/markers must survive editing byte-for-byte). See [[dashboard]] for the Prompts page's place in the overall UI.

## Dependencies

- [[llm-pipeline]] — prompts are assembled into the `systemPrompt` sent as part of every request.
- [[plan-orchestration]] — the PASS/FAIL marker these prompts must emit is that subsystem's contract.

## Diagrams

Not applicable — this doc is a writing-discipline checklist, not a system with its own control flow diagram.

## References

- `developit-ai/llm/modules/llm/prompts.py` (`LLM_CONTEXT_PROMPT`, `CONTEXT_SYSTEM_INSTRUCTIONS`) and `__init__.py` — the source this guideline distills.

## The through-line

Self-contained steps · explicit per-step Pass/Fail · producer ≠ judge · one literal marker definition · lean to failure · deliverable-before-marker · emphasis only where it must not bend. That combination — not model size — is what got developit to ~99% compliance.
