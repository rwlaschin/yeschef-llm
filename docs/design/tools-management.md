---
modified: 2026-07-06
dependencies: [llm-pipeline]
---

# Tools Management

The admin system for defining, storing, and (eventually) executing tools that Ollama can call — the dashboard's `ToolForm`/`ToolsList`/`ToolImport` UI and its MongoDB-backed storage. Read this before touching `/api/admin/tool*`, the tool `definition`/`implementation` split, or anything about how the worker loads/executes tools. Tool *execution* is currently a stopgap (`executeTool` in the worker, see [[llm-pipeline]]) pending the WASM proposal below.

## Sensitive Areas

- **Secrets are stored in plaintext today.** `auth_value` / `connection` / `api_key` inside a tool's `implementation` are not encrypted at rest. Do not build features that assume this is safe — it's flagged as a known gap, not a design choice.
- **The two-part tool split must never blur.** `definition` (what Ollama sees) and `implementation` (how our code actually calls it) are stored together but serve completely different trust boundaries — `definition` is sent to the model, `implementation` never is.
- **Soft delete only** (`isDeleted`) — tools are never hard-deleted; `GET /api/admin/tools` excludes soft-deleted rows but the record persists.

## Design Constraints

- **Ollama has no tool storage/registry.** Tools are stateless per request — the worker passes the `tools` array on every `/api/chat` call. Changing the active tool set in our DB takes effect on the *next* request; nothing is "registered" into Ollama.
- **Version bumping happens only in the form** — the tool record (not any downstream publish step) owns the version number.
- **No hard-coded artifact URIs** in data (e.g. no literal `gs://…`) — a logical key (`name@version`) is resolved to a backend via env config, so dev (`fs`) and prod (`gcs`) differ only in configuration, never in code path.
- Scope boundary: the hardcoded Neo4j meal-plan constraint-solver tools (proposal, below) are **not** authored through this dashboard system and do not share its storage/lifecycle — the only shared contract is the Ollama wire tool-definition format.

## Feature Overview

Ollama's tool-calling is a two-part contract: a JSON-schema **definition** the model sees, and **code** that actually runs when the model returns a `tool_call` — Ollama never runs that code, our worker does, dispatched by name. This subsystem is the admin surface for authoring and versioning that pair without a code deploy per tool: an operator fills in a typed form (Web Search / API Call / Database Query / Data Transformation / Custom), the form emits both the Ollama-facing `definition` and a typed `implementation` config, and both are stored in Mongo. The worker fetches the active tool set at request time and passes it straight through to Ollama on every `/api/chat` call — dynamic tool loading is just "the DB has a new active list," nothing more exotic than that.

## Architecture

**Tool execution flow (target — see Design Constraints on today's stopgap):**
```
User Query → Ollama (streaming) → tool_calls + thinking
  → accumulate stream chunks → extract tool_calls → execute tool
  → append result to messages → send back to Ollama → repeat until no more tool_calls
```
> Today's worker uses Ollama's non-streaming `/api/generate` for the main response (see [[llm-pipeline]]); tool calling itself uses `/api/chat` with the `tools` array passed every turn (tools are stateless — Ollama persists nothing between turns). Streaming (`/api/chat` + `stream:true`) is preferred for UX but not required for tool calls. Fully switching the worker's default path to `/api/chat` is part of the unbuilt executor work below.

**Built-in Ollama capabilities** (do not rebuild as custom tools): `web_search` / `web_fetch` (Ollama's own hosted search, needs `OLLAMA_API_KEY`) and Vision (multimodal models read images directly). Note: this is **distinct from** the dashboard's `web_search` tool *type* below, which wraps a chosen provider (Google/Bing/etc.) as an ordinary custom tool — same name, different thing.

**Tool types** (the five implemented `type` options in `ToolForm`; each shows its own implementation fields, all produce the same Ollama `definition`): Web Search (preset), API Call (preset), Database Query (preset), Data Transformation (preset), Custom (blank — manual parameter builder). Empty `type` defaults to Custom.

**UI (as built).** A single inline form (`ToolForm.vue`), not a multi-page wizard: header (title, Active toggle, close) → Row 1 (Tool Name + Type dropdown) → Description → type-specific implementation fields (each with a docs link) → inline compact parameter builder (name/type/required, no raw JSON) → Actions (Cancel + Create, or a split-button Update/Save-as-new-version on edit). New tools default **inactive**. `ToolsList.vue` shows one card per tool name with version tabs; a card expands to a detail view. `ToolImport.vue` does bulk import (paste or upload JSON).

**Validation (AJV schemas):** tool definition must be valid Ollama format; parameters must have proper types; implementation must have required fields per type; auth credentials must be present if the service requires them. User feedback: red asterisks on required fields, help text per field, live validation, a warning on removing required fields.

## Functions

**API endpoints (as built):**
```
GET    /api/admin/tools        # list (excludes soft-deleted)
GET    /api/admin/tool?id=…    # single tool
POST   /api/admin/tool         # create (auto-increments version per name)
PUT    /api/admin/tool?id=…    # update in place (keeps version)
DELETE /api/admin/tool?id=…    # soft delete (sets isDeleted = true)

GET    /api/tools              # public; active tools (or ?inactive=true) — consumed by the worker
```
All single-tool routes use a `?id=` query param, not a path param. **Not built:** `GET /api/services` (no service registry — superseded by the typed `implementation` field), `POST /api/tools/execute` (no executor yet).

**Streaming integration (target execution loop):**
```python
for chunk in stream:
    if chunk.tool_calls:
        for tool_call in chunk.tool_calls:
            tool_name = tool_call.function.name
            arguments = tool_call.function.arguments
            tool = db.tools.findOne({name: tool_name})       # get definition + implementation
            result = execute_tool(tool.implementation, arguments)
            messages.append({"role": "tool", "content": result})
stream = chat(model, messages, tools, stream=True)
```

## Models

Tool document (MongoDB):
```json
{
  "_id": "507f1f77bcf86cd799439011",
  "name": "search_recipes", "version": 1, "active": true, "isDeleted": false, "type": "api_call",
  "definition": {
    "name": "search_recipes", "description": "Search recipes by ingredients",
    "parameters": { "type": "object", "properties": { "query": {"type":"string"}, "limit": {"type":"integer"} }, "required": ["query"] }
  },
  "implementation": {
    "endpoint": "https://api.recipes.com/search", "method": "GET",
    "auth_type": "api_key", "auth_value": "<secret>"
  },
  "createdAt": "2025-05-30T10:00:00Z", "updatedAt": "2025-05-30T10:00:00Z"
}
```
`implementation` is the actual flat shape persisted by POST/PUT (the form sends its whole `impl` object; which fields are used depends on `type` — `db_type`/`collection`/`connection`/`service`/`api_key`/`transform_rules`/`notes` also live here for other types).

## Use Cases

### UC1: Operator creates a new tool

**Goal:** Add a new tool (definition + implementation) that the worker can pass to Ollama, without a code deploy.

**Stakeholders:** Dashboard operator (author of the tool); the worker process (consumer of the active tool set); end users of the LLM feature the tool supports (indirectly affected once active).

**Actors:** Dashboard operator (primary).

**Preconditions:** Operator has access to the dashboard `tools.vue` page. No tool with the desired name exists yet, or the operator intends to create the first version of one.

**Postconditions:** A new document exists in `llmtools` with `version: 1`, `isDeleted: false`, the operator-chosen `active` flag, and both `definition` and `implementation` persisted. If `active: true`, `GET /api/tools` (default, non-`inactive`) will include it on the worker's next fetch.

**Basic Course of Events (BCE):**
1. Operator clicks "New Tool" on `tools.vue`, which sets `editingTool` to a blank shape (`name: ''`, `active: false`, empty `definition.parameters`) and renders `ToolForm.vue` inline in place of the list.
2. Operator fills Tool Name and picks a Type (Web Search / API Call / Database Query / Data Transformation / Custom); the form's implementation fields switch to match the chosen type's preset. Leaving Type empty defaults to `custom`.
3. Operator fills Description and the type-specific implementation fields (e.g., endpoint/auth for API Call), then adds parameters via the inline compact builder (name/type/required — no raw JSON).
4. Operator leaves the Active toggle off (new tools default inactive) and clicks Create, which calls `handleSubmit(false)`.
5. `saveTool` in `tools.vue` sees no existing `_id`, so it issues `POST /api/admin/tool` with the form payload.
6. The endpoint (`tool.post.ts`) runs `validateTool` (AJV) against the body; on success it queries `llmtools` for a non-deleted document with the same `name`. None is found, so `version` is set to `1`.
7. The endpoint inserts `{ name, version: 1, active, isDeleted: false, type, definition, implementation, createdAt, updatedAt }` into `llmtools` and returns the inserted document.
8. `tools.vue` calls `fetchTools()` (`GET /api/admin/tools`) to refresh the list and clears `editingTool`, returning the operator to `ToolsList.vue`, where the new tool now appears as a card (grouped by name, one version tab: v1).

**Alternate Flows:**
- **A1 — Operator activates immediately:** at step 4, operator leaves the Active toggle on instead. Same POST path; the resulting document has `active: true` and is immediately eligible for `GET /api/tools`'s default (active-only) filter.
- **A2 — Operator activates later from the list:** after BCE completes with an inactive tool, operator clicks the "Inactive" status badge on the card or in the detail view (`ToolsList.vue`'s `toggleActive`), which sends `PUT /api/admin/tool?id=…` with the current `definition` and the flipped `active` value, updating the same document in place (version unchanged).

**Exceptions:**
- **E1 — AJV validation fails** (e.g., malformed `definition.parameters`, missing required implementation field per type): `tool.post.ts` throws a 400 with `Validation failed: …` (joined AJV error messages); no document is written; the form remains open with the operator's input intact for correction.
- **E2 — Insert fails at the DB layer:** the endpoint's catch block returns a 500 with the underlying error message; `tools.vue`'s `saveTool` catches the thrown fetch error and logs it to console — the form does not close and no success feedback is shown beyond the request failing silently to the UI (no toast/inline error is rendered today).

---

### UC2: Operator ships a breaking change via a new version

**Goal:** Change a tool's parameters/definition without disrupting the currently-active version that the worker may be mid-using.

**Stakeholders:** Dashboard operator; the worker (must keep working off whichever version is `active` during the transition).

**Actors:** Dashboard operator (primary).

**Preconditions:** A tool with at least one existing version (`_id` present) is open for editing.

**Postconditions:** A second document exists in `llmtools` with the same `name`, `version` incremented by one over the highest existing version for that name, and its own `active`/`definition`/`implementation`. The prior version's document is untouched and still queryable.

**Basic Course of Events (BCE):**
1. Operator clicks the edit (pencil) action on a tool card or its expanded detail view in `ToolsList.vue`, which emits `edit` with that version's full document; `tools.vue`'s `editTool` deep-clones it into `editingTool`.
2. `ToolForm.vue` renders pre-filled with the existing `name`, `type`, `definition`, and `implementation`; the header shows "Edit Tool v{version}".
3. Operator changes a parameter (e.g., adds a new required field), then opens the split-button menu next to Update and clicks "Save as new version" (labeled "Creates v{version+1}, keeps v{version}"), which calls `handleSubmit(true)`.
4. `saveTool` sees `opts.asNewVersion === true`, so `updateInPlace` is false regardless of `_id` being present; it issues `POST /api/admin/tool` (not PUT) with the edited payload.
5. `tool.post.ts` looks up the existing non-deleted document by `name`, finds the prior version, and sets `version = existing.version + 1`.
6. A new document is inserted with the bumped version and the operator's edited `definition`/`implementation`/`active`; the prior version's document is not modified.
7. `tools.vue` refetches the list; `ToolsList.vue`'s `toolsByName` groups both versions under the same tool name, sorted descending, and renders both as version tabs (e.g., v1, v2) on the card.

**Alternate Flows:**
- **A1 — Operator instead clicks plain "Update":** at step 3, operator clicks Update instead of the split-button's "Save as new version." `handleSubmit(false)` runs; since `editingTool._id` is present and `asNewVersion` is false, `updateInPlace` is true, so `saveTool` issues `PUT /api/admin/tool?id=…` instead, modifying that same version's document in place (version number unchanged) — this is UC3, not a new version.

**Exceptions:**
- **E1 — AJV validation fails on the new-version payload:** same as UC1/E1 — `tool.post.ts` returns 400, no new document is inserted, old version remains the only one.
- **E2 — Name collision race:** if two operators create new versions for the same tool name concurrently, both reads of `existing.version` could observe the same prior version and both insert the same next version number (no unique index enforcing one document per name+version is evidenced in `tool.post.ts`); this is a real gap, not a handled case.

---

### UC3: Operator edits a tool in place

**Goal:** Correct or adjust an existing tool version's definition/implementation/active state without creating a new version.

**Stakeholders:** Dashboard operator; the worker (sees the change on its next `GET /api/tools` call if the edited version is active).

**Actors:** Dashboard operator (primary).

**Preconditions:** A tool version (with `_id`) is open for editing via `ToolForm.vue`.

**Postconditions:** The same `llmtools` document is updated (`name`, `active`, `type`, `definition`, `implementation`, `updatedAt`); its `version` number and `_id` are unchanged.

**Basic Course of Events (BCE):**
1. Operator opens a tool for edit (as in UC2 step 1–2).
2. Operator makes a non-breaking change (e.g., fixes a description typo, corrects an endpoint URL) and clicks the primary "Update" button, which calls `handleSubmit(false)`.
3. `saveTool` determines `isEdit` is true (`editingTool._id` present) and `opts.asNewVersion` is falsy, so `updateInPlace` is true; it issues `PUT /api/admin/tool?id={_id}`.
4. `tool.put.ts` runs `validateTool` on the body, confirms a document with that `_id` exists, then `$set`s `name`, `active`, `type`, `definition`, `implementation`, and `updatedAt` on it — `version` and `createdAt` are left untouched.
5. The endpoint returns the updated document; `tools.vue` refetches the list and closes the form.

**Alternate Flows:**
- **A1 — Toggling Active only, from the list (not the form):** operator clicks the Active/Inactive badge directly on a card or in the detail view; `ToolsList.vue`'s `toggleActive` sends `PUT /api/admin/tool?id=…` with just `{ name, active: !tool.active, definition }` (no form round-trip) and optimistically flips `tool.active` in local state on success.

**Exceptions:**
- **E1 — `id` missing or malformed:** `tool.put.ts` returns 400 (`Missing id parameter` or `Invalid id format`) before touching the DB.
- **E2 — Document not found:** returns 404 `Tool not found`.
- **E3 — AJV validation fails:** returns 400 with joined AJV messages; no update applied.
- **E4 — `updateOne` reports `modifiedCount === 0`** (e.g., submitted body is identical to stored document): endpoint treats this as failure and returns 500 `Failed to update tool`, even though no actual data corruption occurred — a known rough edge, not a data-loss case.

---

### UC4: Operator soft-deletes a tool

**Goal:** Remove a tool from operator-facing and worker-facing listings while preserving its record for audit/recovery.

**Stakeholders:** Dashboard operator; the worker (must never see a deleted tool).

**Actors:** Dashboard operator (primary).

**Preconditions:** A tool version exists and is currently `active: false` (the UI disables delete while active).

**Postconditions:** The document's `isDeleted` is `true`; it is excluded from `GET /api/admin/tools` and `GET /api/tools` (both filter `isDeleted: false`); the document itself still exists in `llmtools`.

**Basic Course of Events (BCE):**
1. Operator clicks the trash-can action on an inactive tool card or its detail view in `ToolsList.vue`, which emits `delete` with that version's `_id`.
2. `tools.vue`'s `deleteTool` opens `ConfirmDialog` with a destructive-action prompt ("Are you sure…This action cannot be undone.").
3. Operator confirms.
4. `tools.vue` issues `DELETE /api/admin/tool?id={_id}`.
5. `tool.delete.ts` validates the `id`, confirms the document exists, then `$set`s `isDeleted: true` and `updatedAt` — the document row is not removed.
6. `tools.vue` refetches the list; the deleted version no longer appears (its card, or that version tab, disappears from `ToolsList.vue`).

**Alternate Flows:**
- **A1 — Operator cancels the confirmation dialog:** at step 3, operator declines; `deleteTool` returns immediately with no request sent and no state change.

**Exceptions:**
- **E1 — Delete attempted on an active tool:** not reachable through the UI — both the card and detail-view delete buttons are `:disabled` when `tool.active` is true (title: "Cannot delete active tools"); the endpoint itself does not independently enforce this, so a direct API call could still soft-delete an active tool.
- **E2 — `id` missing/malformed or document not found:** same 400/404 handling as UC3/E1–E2.

---

### UC5: Operator bulk-imports tools from JSON

**Goal:** Load multiple pre-authored tools at once instead of hand-filling the form per tool.

**Stakeholders:** Dashboard operator.

**Actors:** Dashboard operator (primary).

**Preconditions:** Operator has a JSON array of tool objects, each shaped like the stored tool document (at minimum `active: boolean` and `definition.name`), either as pasted text or a `.json` file.

**Postconditions:** One new `llmtools` document per array entry is inserted via the same create path as UC1 (each gets `version: 1` unless a same-named tool already exists, in which case it gets the next version per the POST endpoint's existing-name logic).

**Basic Course of Events (BCE):**
1. Operator clicks "Import" on `tools.vue`, opening `ToolImport.vue` as a modal.
2. Operator pastes JSON into the textarea, or clicks the upload area to pick a `.json` file (`FileReader` reads it into the same textarea-bound value).
3. On every change to the JSON input, `parseAndPreview()` runs automatically: parses the JSON, checks it is a non-empty array, and checks each entry has a boolean `active` and a `definition.name`; if an entry lacks a top-level `name`, it is backfilled from `definition.name`.
4. On success, a green preview panel lists each tool by name and enables "Import N Tool(s)".
5. Operator clicks Import, emitting the parsed array to `tools.vue`'s `importTools`.
6. `importTools` loops the array and issues one `POST /api/admin/tool` per entry, sequentially, each going through the same validation/versioning logic as UC1 step 6–7.
7. After the loop completes, `tools.vue` refetches the list and closes the import modal.

**Alternate Flows:**
- **A1 — Importing a tool whose name already exists:** step 6's POST for that entry follows the UC2 versioning path (increments off the existing highest version) rather than creating a fresh v1.

**Exceptions:**
- **E1 — Invalid JSON:** `parseAndPreview` catches the parse error and shows `Invalid JSON: {message}`; Import stays disabled.
- **E2 — Not an array, empty array, or an entry missing `active`/`definition.name`:** a specific inline error is shown for each case (e.g., "JSON must be an array of tools", "Each tool must have an \"active\" boolean property"); Import stays disabled; no request is sent.
- **E3 — One entry's POST fails validation server-side (AJV) or fails the DB write:** `importTools`'s `try/catch` wraps the whole loop, so a single failing entry throws and aborts the loop — entries already inserted before the failing one remain persisted (no rollback), and entries after it are never attempted; the error is logged to console only.

---

### UC6: Worker fetches the active tool set for an inference request

**Goal:** Give the worker the current, non-deleted, active tool definitions to pass to Ollama's `tools` array on a `/api/chat` call.

**Stakeholders:** The worker process; indirectly, the operator (whose CRUD/versioning/activation decisions this reflects) and end users of whatever feature triggered the LLM call.

**Actors:** The worker (primary, machine actor).

**Preconditions:** Zero or more tools exist in `llmtools` with varying `active`/`isDeleted` states.

**Postconditions:** The worker receives the current set of tools matching the query (active-only by default); no state is mutated by this read.

**Basic Course of Events (BCE):**
1. Worker calls `GET /api/tools` (no query params) ahead of an Ollama `/api/chat` call requiring tool-calling.
2. `tools.get.ts` builds the filter `{ isDeleted: false, active: true }` (the `inactive` query param is absent, so it defaults to excluding inactive tools).
3. The endpoint queries `llmtools` with that filter and returns the matching array of full tool documents (including `implementation`, not just `definition`).
4. Worker passes the `definition` portion of each returned tool into the `tools` array on the outgoing `/api/chat` request; `implementation` is retained worker-side for later dispatch if Ollama returns a `tool_call` (per [[llm-pipeline]] — the executor itself is unbuilt, see Next Steps).

**Alternate Flows:**
- **A1 — Worker (or an admin caller) requests including inactive tools:** caller passes `?inactive=true`; the filter drops the `active: true` clause, returning both active and inactive (but still non-deleted) tools. Nothing in the worker code today is confirmed to use this variant — it exists as an endpoint capability for admin/debug use.

**Exceptions:**
- **E1 — DB query throws:** the endpoint returns a 500 with the error message; the worker's request for tools fails, and (per the two-part contract) the model would proceed with no `tools` array unless the worker has separate fallback handling — no such fallback is evidenced in this subsystem's code.

## Tests

No tests exist for the CRUD API (`/api/admin/tool*`), the AJV validation schemas, or the `ToolForm`/`ToolsList`/`ToolImport` UI — verified, none found. The worker's tool *executor* is unbuilt (see Next Steps above), so there is nothing to test on that side yet either; it will need coverage once built, per [[worker-dispatch]]'s and the worker-refactor plan's testing conventions (mock only third-party boundaries, `node --test` + coverage gate).

## UI/UX

Described under Architecture above (`ToolForm`, `ToolsList`, `ToolImport` — feature-level panels, not individually mocked-up per the docs/README convention). They compose shared primitives that do have their own mockups: [[select]] (type dropdown), [[toggle]] (Active switch), [[confirm-dialog]] (delete confirmation), [[chip-input]]-style option rows. See [[dashboard]] for the full shared-UI-primitive list.

## Dependencies

- [[llm-pipeline]] — the worker process that ultimately loads and calls these tools during inference.

## Diagrams

See the "Tool execution flow" ASCII diagram in Architecture.

## References

- Ollama tool-calling docs (`/api/chat` `tools` array, OpenAI-compatible function-calling wire format).

## What We DON'T Do

Structured Outputs (schema enforcement); rebuilding Ollama's hosted `web_search`/`web_fetch`; rebuilding Vision; a separate REST "execute" endpoint in the model loop (tool calls flow through `/api/chat` with `tools` passed each turn).

## Next Steps

1. ✅ Done — tool CRUD, versioning, soft delete, inline preset form, persisted `type` + `implementation`.
2. Build the tool **executor** in the worker (move to `/api/chat`, dispatch by name via a handler registry).
3. Encrypt secrets at rest (`auth_value`/`connection`/`api_key`).
4. Test against a real Ollama instance.

---

## PROPOSAL ONLY — NOT IMPLEMENTED: Tool Execution & WASM Publishing

> Captures a design discussion for how tools will eventually be *executed* at runtime (the `custom`/code path). None of it is built. The CRUD/versioning/`definition`+`implementation` storage above is the only thing that currently exists. This is a record of decisions, not a spec to implement now — kept here so the architecture isn't re-litigated.

**Ollama runtime facts.** No tool storage/registry/fetching in Ollama itself; tools are stateless per request. Changing the active tool set in our DB *is* the dynamic loading — nothing is registered into Ollama. The only non-dynamic thing is the worker's ability to *execute* a brand-new tool, which is the WASM path below.

**Execution strategy (decided directions).** HTTP-endpoint-per-tool: **rejected** (runtime latency, hard dependency on an external service, breaks dev without that service). WASM: **preferred** (sandboxed, language-agnostic, hot-loadable, runs in-worker via Node's built-in WASM runtime, no network hop). `switch` dispatcher: **rejected as the end state** (hard-coded, needs worker edits per new kind) — use a handler registry so kinds are additive.

**Artifact handling (decided).** No code in the database — binaries are artifacts, DB holds only a reference. No hard-coded URIs (`gs://…`) in data; store a logical key (`name@version`) resolved by an env-configured backend (dev → local folder, `TOOLS_ARTIFACT_BACKEND=fs`; prod → `gs://yc-tools/…`, `TOOLS_ARTIFACT_BACKEND=gcs` — mirrors the existing dotenv-flow layering). Integrity via `sha256` of the module bytes, guarding validation/promotion/deploy-preflight/runtime-load alike; mismatch fails closed.

**Two decoupled lifecycles.** The tool record (the form) is stable — name/description/parameters/type/version — and can be valid with no working code yet. The WASM artifact churns through dev builds (throwaway; nothing broken is stored) — only working bytes become an artifact. They meet at exactly one point: a tool version pins one proven artifact (`name@version` + `sha256`).

**Publishing (proposed mechanism, one operation, fail-closed):**
```
input: working module.wasm + tool name + version (from the form)
1. HASH      sha256(bytes)
2. VALIDATE  instantiate; assert `entry` export; smoke-run vs declared params (time/mem cap)
             ✗ fail → STOP (nothing written)
3. STORE     write bytes to artifact backend as name@version (immutable; no overwrite)
4. BIND      tool.implementation = { type:'wasm', artifact:'name@version', sha256, entry }
```
Dev publish: local CLI → fs backend → dev Mongo. Prod publish = promotion: CI only (devs lack prod creds) → re-hash + re-validate the SAME bytes → write to `gs://yc-tools` → prod Mongo, guaranteeing byte-identical dev/prod modules. `sha256` is computed once, at publish; never entered by a human, only re-verified downstream. **Open question:** auto-promote on merge vs. manual gated CI approval — undecided.

**Safeguards against shipping half-baked WASM:** the `active` flag as publish gate; a validation gate (must instantiate + smoke-test before going active); immutable hash-locked `name@version` (a good artifact can't be silently overwritten); devs can't write prod (only CI has prod-bucket creds).

**Deploy preflight (proposed).** For every `active` tool: verify its artifact exists in the target backend AND its `sha256` matches AND it instantiates. Any miss aborts the deploy entirely (never starts).

**Proposed `implementation` shape (future, additive — no form/model change needed to adopt):**
```json
{ "type": "wasm", "artifact": "search_recipes@1", "sha256": "abc123…", "entry": "run" }
```

## PROPOSAL ONLY — NOT IMPLEMENTED: Neo4j Meal Plan Constraint Solver as an LLM Tool

> No code for this exists anywhere in the repo (`queryRecipes`/`findOptimalCombination`/`getNutritionSummary`/`checkIngredientAvailability` are not implemented). Kept as a proposal record, not a spec to build now.

For meal-plan generation with complex dietary overlaps, the idea is for the LLM to act as a reasoning engine that queries Neo4j to find optimal recipe combinations, rather than the backend pre-filtering recipes. This would be a **purpose-built, domain-specific** feature — hardcoded constraint-solver tools backed by Cypher, owned by meal-planning code, **not** authored through this dashboard and **not** sharing storage/lifecycle with dashboard-managed tools. The only shared contract would be the Ollama wire tool-definition format when a call is actually sent to the model.

**Proposed flow:** chef selects constraints (`["low_sodium", "diabetic", "vegetarian"]`) → LLM calls `queryRecipes(constraints)` → gets back matching recipes → calls `findOptimalCombination(recipes, optimize_for: "ingredient_overlap")` → generates the meal-plan JSON. Four proposed tools: `queryRecipes`, `findOptimalCombination`, `getNutritionSummary`, `checkIngredientAvailability`, each backed by a specific Cypher query against the recipe/ingredient/nutrition graph. Proposed error handling: graceful degradation (return the error to the LLM with a suggestion) → retry (LLM reformulates, up to 3 attempts) → fallback to a template-based plan from company defaults if tools are unavailable.
