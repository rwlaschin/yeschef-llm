---
modified: 2026-07-06
dependencies: [llm-pipeline, plan-orchestration]
---

# Prompt Library

The worker/planner system-prompt store (Mongo `prompt_library`, assembled by subtype, authored via the dashboard's Prompts page) and the writing discipline its prompts must follow. Read this before editing any prompt in `prompt_library`, or before writing a new step type's prompt.

## Sensitive Areas

- **No versioning on `prompt_library` today** — back up before editing (`scripts/_prompt_backup.mjs`). An in-place edit that breaks format compliance breaks every step using that prompt immediately, with no rollback except a manual restore.
- **Format compliance is load-bearing, not cosmetic.** The `@@::PASS::@@` / `@@::FAIL:<reason>::@@` marker (see [[plan-orchestration]]; `worker/steps/outcome.js` is the source of truth) is parsed programmatically while streaming; a prompt change that lets the model wrap or fuse the marker breaks the orchestrator's advance logic. There are NO angle brackets around the delimiters, and `FAIL` requires a single-colon reason of at least one character.

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
7. **Deliverable first, marker after, never wrapped** — the deliverable comes first in full, then the marker as a separate final line; the marker is never part of the deliverable. Without this a weak model fuses its output into the marker (observed: `@@::meal_plan:: …yaml… ::@@`). Between the delimiters goes only the token, never a YAML key or other content.
8. **Distinctive, named markers** — developit uses `<?!PLAN_STATUS::PASS::PLAN_STATUS!?>`; we use the shorter `@@::…::@@` (see [[plan-orchestration]]). A named bookend can't false-trigger from prose. The named form is a robustness lever to reach for if a model keeps fumbling the shorter one.
9. **"EXACT AND LITERAL", repeated, capitalized, for non-negotiables** — weak models need the truly-non-bendable rules hammered ("No other characters are permitted", "nothing else", "MUST"); reserve the emphasis for the few things that truly can't vary.
10. **Output hygiene stated as negatives** — "Output ONLY the deliverable. No preamble, no commentary, no metadata, no markdown fences" — plus fence-nesting rules and "output/print from code must NOT be wrapped in fences." State what NOT to emit explicitly; don't assume the model infers it.
11. **Let the planner pick the model per step** — hand it a models list with a one-line `purpose` each, and instruct it to pick the most cost-effective/fastest fit. Run the planner itself at low temperature (developit uses 0.1) for deterministic plans.
12. **Personas embodied, not announced** — "embody this persona through tone and vocabulary; do not introduce yourself or describe your identity."
13. **Scope discipline baked into the prompt** — e.g. "when bug fixing, do NOT refactor unless asked — no renames, no style changes; if a fix needs a change, it must address only the bug." Constraints the model should always honor belong in the prompt, not left to chance.
14. **OBSERVE BEFORE YOU JUDGE — order of operations is the rule, not the wording.** Any prompt that asks the model to *check* something must make it write down what it SEES before it states a verdict: enumerate the items, count them, restate required-vs-found, and only then conclude. A verdict reached before the enumeration is written is a guess dressed as a judgement, and the model will defend it. This applies to every prompt, not just table steps — enumeration first, arithmetic second, verdict last.

### Why rule 14 exists (measured, 2026-08-14, `llama3.1:8b` via Ollama, temp 0.1)

The same table was reviewed under different system prompts, 3 reps per cell, against a course list of `3 appetizers, 2 entrees, 3 sides`:

| variant | prompt shape | correct table | table with 2 sides + an unrequested dessert |
|---|---|---|---|
| `bare` | "State only what is actually in the table." | **0/3** — invented "missing entrees" every rep | **0/3** — missed both defects |
| `min` | "Count the rows yourself and report the count." | 3/3 | **0/3** — missed both defects |
| `obs` | enumerate each Kind → count → *then* compare and judge | **3/3** | **3/3** — caught the short sides and the dessert |
| `cot` | 4 numbered STEPs: number every row → per-Kind row lists → required-vs-found → verdict | **0/3** — invented "missing entrees" | 3/3 |
| `tally` | cite the row numbers per position, count the citations | **0/3** — never stated the correct side count | 3/3 |

`min` and `obs` differ **only** in whether enumeration is forced before the verdict. That single ordering change is worth 0/3 → 3/3 on the faulty table.

**More scaffolding is not better — it trades one error for the other.** `cot` and `tally` are heavier, more explicit step-by-step forms, and both detect real defects reliably (3/3) while **false-positiving on every rep of the correct table** (0/3). `min` is the mirror image: never false-positives, never detects. Only `obs` does both, and it is the *shortest* of the three step-by-step variants — four plain lines, no numbered STEP scaffold, no citation protocol. Reach for ordering, not verbosity; a heavier procedure makes the model hunt for a fault until it finds one.

Every cell was unanimous across its 3 reps (no 2/3 anywhere), which is what makes n=3 adequate to separate these.

**The failure this prevents is sycophancy, not innumeracy.** The same model, same table, three framings:

- neutral framing → counted correctly
- "This table is BROKEN, list its faults" → invented faults that were not present, including entrée rows in a table with none
- "This table is CORRECT, confirm it" → confirmed, while its own enumeration listed only 2 of the 3 required sides

It counts fine until someone tells it what to conclude. **A stated expectation overrides its own observation.**

**This qualifies rules 2 and 6 above.** `PASS:`/`FAIL:` criteria and "lean toward failure" both put a conclusion in front of the model before it has looked at its own output, which is the exact trigger. Measured: a courses step self-assessed `@@::PASS::@@` on 5 consecutive runs while breaking its own named Fail conditions; a 9-item Pass checklist made it *worse* and added placeholder leakage. Keep rules 2 and 6 — the rubric still has to exist and the judge still has to be skeptical — but the rubric must be reached *through* the enumeration, never instead of it.

**A critic persona does not fix this and can make it worse.** A "Celebrated Critic who revels in finding even the smallest issue" persona left the acquiescence untouched and broke the previously-correct neutral case: it reported "only 2 sides" while naming all three. Personas set tone; they do not change order of operations. (Rule 12 still holds for *voice* — it is not a correctness lever.)

**Rule 14 is for CHECKING prompts. A build step still cannot audit itself — this is why rule 3 exists.** The `obs` ordering was transplanted into the courses *build* step as an audit block ("read back every row you wrote as `<n>. Kind=<…>`, count per Kind, compare required-vs-found, and only then the status block"). Result: **0/3**. The model emitted the table, skipped every audit line, and went straight to `@@::PASS::@@` — on a table holding 3 rows when 6 were required, in none of the required Kinds. All three runs were byte-identical, so this is the model's settled behaviour, not sampling noise.

The reason is placement, not wording: by the time the audit is reached the model has already produced its answer, and the block reads as an epilogue to ~1100t of generation instructions it has just finished executing. Self-assessment has now failed in every form tried — plain criteria, a 9-item checklist, and `obs`-ordered self-audit — while the same model, same fixture, judging a *separate* artifact scored 6/6. **The ordering rule buys you a reliable checker; it does not buy you a reliable self-checker.** Put the check in its own step, per rule 3.


### The checker pattern (measured 8/8, 660t — 2026-08-14, `llama3.1:8b`)

A check step that scored 8/8 across four fixtures (all-present, over-supplied, missing position, unlisted Kind), 2 reps each, emitting a correctly-formed status block as the last element every run. Structure, in order:

1. `# ROLE` — one line. "You check one table against one rule. You do not write menus."
2. `# ORDER OF WORK — STRICT` — numbered `## STEP n` markdown headings, with **"A verdict written before STEP 3 is INVALID."**
   - STEP 1 OBSERVE — list every row as `<n>. <value>`, copied. NO opinion.
   - STEP 2 COUNT — `<value>: <count>`.
   - STEP 3a — walk the REQUIRED list, one line each even when fine.
   - STEP 3b — walk YOUR OWN STEP 2 LIST, one line each.
   - STEP 4 STATUS — the block, nothing after.
3. `# THE RULE — IMPORTANT` — CAPS on the non-negotiables.
4. `# STATUS BLOCK — EXACT AND LITERAL` — both literal forms.
5. `# WORKED EXAMPLE` — a complete response for a small table, **ending in the marker**.

**NEVER ASK FOR A SET DIFFERENCE. ASK FOR A PER-ITEM LOOKUP.** This is the single highest-value finding.

    ✗  "NOT ON THE LIST: <any Kind you counted that the list never named, or none>"     → 0/4
    ✓  "Walk YOUR STEP 2 LIST. <Kind> — ON THE LIST | <Kind> — NOT ALLOWED"             → 4/4

Same information, opposite traversal. The failing form asks "what is in A that is not in B" and needs both sets held at once; the working form asks "is this one item in B" and repeats. Add the tie-back **"STEP 2 and STEP 3b MUST have the SAME NUMBER OF LINES"** — a self-check that is itself a lookup.

Isolated probe, no menu context, `A=[appetizer, side, dessert, side, drink, appetizer]`, `B=[appetizer, side]`:

| form | result |
|---|---|
| "Which items in A are not in B?" | `[side, dessert, drink]` — **returned an item that IS in B** |
| "Compute A \ B" (formal notation) | `{dessert, drink}` — correct |
| per-item: "is it in B?", one line each | all 6 correct |

So set operations are not impossible for this model — **informally-phrased negated exclusion** is what fails. Prefer per-item lookup; never phrase a rule as "which are not in".

**Two worked examples of the OUTPUT did not fix it** (0/4 before and after adding a second example covering the exact case). Examples teach the shape of the answer; they do not change the operation the model must perform. To fix a wrong answer, change the operation.

**The worked example IS what fixed the status block** — 0/n across every earlier variant, 8/8 once the example ended in the marker. This was the gap versus developit-ai, which frames a full worked example with `** Beginning Example … ** / ** Ending Example … **`.

**Caveat on the evidence:** 3 reps distinguishes 0/3 from 3/3 and nothing finer. It does not establish that `obs` is perfect, only that it is clearly better than the alternatives tested.

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
  "scopes": ["menu_plan", "task_list"],
  "active": true,
  "content": "the prompt text, exactly as authored",
  "modelOverride": null,
  "isDeleted": false,
  "createdAt": "Date",
  "updatedAt": "Date"
}
```
`mapping` is how an entry attaches to one or more request `type`s (with a priority, for when more than one entry maps to the same type). `modelOverride: null` means "use the request's model" — a non-null value pins this prompt's step to a specific model regardless of what the request asked for (used by the planner override in [[plan-orchestration]]).

### `scopes` — which pipeline a prompt applies to

`scopes` narrows an entry to one PIPELINE: `"menu_plan"` (a meal-plan build), `"task_list"` (a `/ai/tquery` task list), or both. It exists so **one subtype can serve both pipelines with different prompt text** — a `compliance` step inside a meal-plan build and a `compliance` step inside a task list need different instructions, and forking the subtype (`compliance_menu`, `compliance_task`) would be a subtype explosion that the planner menu, `MESSAGE_TYPES`, and every stored `mapping` would then have to carry. The subtype stays one name; the *prompt* carries the scope.

It is a flat array, not a second level inside `mapping`, because `mapping[<type>]` is a lexBetween **order key** and must stay one — and a prompt's order within a type does not differ per pipeline.

**Absent or empty `scopes` means `menu_plan`.** Every entry authored before this field existed is a meal-plan prompt (task lists had no prompts at all: `task` and `analytics_widget` map zero), so reading absent as "menu_plan" is what makes this need **no backfill and no migration**. Reading it as "both" would pour the entire meal-plan library into every task list; reading it as "neither" would silently empty the meal-plan pipeline.

The vocabulary and both decisions live in `config/promptSections.js` beside `normalizeRelatesTo`, for the same reason: `PROMPT_SCOPES`, `inScope(prompt, scope)` (read side), `scopeOfJobType(jobType)` (`"tquery"` → `task_list`, everything else → `menu_plan`), and `normalizeScopes(value)` (the one decision about what may reach the database — the dashboard's two write handlers call it instead of holding their own copy).

The worker learns the scope from the **job doc's `type`**, which `worker/steps/step.js` `loadStep` already reads — so no new field rides in the Pub/Sub message. It is then passed to `fragmentsFor`/`assembleFor` (`{ scope }`), to `systemPromptFor(type, scope)`, and on to any subtype builder. Callers that pass no scope (the dashboard's `GET /api/llm/system-prompt` preview, a direct `/ai/query`, the planner) are unfiltered, exactly as before.

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
