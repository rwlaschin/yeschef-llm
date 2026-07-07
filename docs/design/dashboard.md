---
modified: 2026-07-06
dependencies: [llm-pipeline, tools-management, plan-orchestration]
---

# Dashboard

The local Nuxt testing/admin UI for the LLM infrastructure — publish test queries, watch results stream, author tools, manage prompts, browse plans. Read this before touching `dashboard/**`. Practical run instructions live in `dashboard/README.md`; this doc is the architecture/rationale record.

## Sensitive Areas

- **Production mode uses real credentials.** The environment toggle (Local Dev / Production) switches to real GCP Pub/Sub + Cloud Run and requires real service-account credentials — don't wire test-only shortcuts into the production path.
- **This dashboard is a write surface for tools/prompts** (see [[tools-management]] and [[prompt-library]]) — changes made here go live for the worker on the next request, with no separate approval gate today.

## Design Constraints

- Local-only testing tool — not part of the production request path; it must keep working even when the main dev environment (`npm run dev` in the parent) isn't running, degrading gracefully with clear connection-status errors rather than crashing.
- Real-time results come from Firestore/Mongo change streams (`onSnapshot` / SSE), never polling.
- Theme, logs, and job tracking persist to `localStorage` (`yeschef-llm-theme`, `yeschef-llm-logs`) — no server-side session state for these.

## Feature Overview

Deploying to production to test a prompt or model change is slow. The dashboard exists so that publishing a test query, watching it stream through Ollama, and inspecting the exact prompt/tool/plan data that produced a result is a local, immediate loop. It has grown from a pure query-publisher into the operational home for three adjacent admin surfaces that share its UI conventions: [[tools-management]]'s tool CRUD, [[prompt-library]]'s prompt authoring, and [[plan-orchestration]]'s plan/step browsing.

## Architecture

```
Dashboard (Nuxt)
├── Publishes messages to Pub/Sub
├── Listens to MongoDB/Firestore results via change streams
├── Shows real-time status + responses
└── Links to external DB tools (MongoDB Compass, Neo4j Browser, Firebase Console)
```

**File structure:**
```
dashboard/
├── pages/            index (main), login, config, logs, menu, model-config, plan-library, prompts, store, tools
├── components/       ChipInput, CollapsibleSections, ConfirmDialog, ExternalTools, FirestoreNode,
│                      GraphExplorer, HealthRing, JobResults, LogsViewer, MarkdownEditor, MenuForm,
│                      Request, SearchableSelect, Select, StepForm, StepStatus, Store, ToastContainer,
│                      Toggle  (+ prompts/ and tools/ subcomponents for those two admin surfaces)
├── composables/      useTheme.ts (dark/light), useLogger.ts (Pino + localStorage), useJob.ts (job tracking/streaming)
├── server/api/       llm/ (request.post, models/types/system-prompt.get, [jobId].delete), pubsub/publish.post.ts,
│                      admin/ (tool.*, prompt.*, model-config*), db/ (companies, users), store/ (firestore/mongo/neo4j
│                      explorer endpoints), health.get.ts + health/{mongo,ollama,pubsub}.get.ts
├── assets/css/       main.css (glass-morphism styles)
└── nuxt.config.ts, tailwind.config.js
```

**Configuration panel** switches between local/production and checks connection status (MongoDB, Pub/Sub, Ollama). **External tools** panel links to MongoDB Compass (`results` collection), Neo4j Browser (regulations/allergen relationships), Firebase Console (Firestore/Pub/Sub), plus local Emulator UI and Ollama server info.

**Visual system (glass morphism):** frosted-glass cards with backdrop blur, unified across components; dark mode default, persisted toggle; focus-visible rings + ARIA labels for keyboard/screen-reader access; status shown as icon + text + color (never color-only, for contrast/accessibility); copy-to-clipboard buttons revealed on hover (not always visible, to avoid clutter) with toast confirmation; toast notifications (success/error/info/warning, 4s auto-dismiss + manual dismiss, bottom-right stack) as the single feedback mechanism across all actions (publish, copy, clear); responsive grid (single column on mobile, sidebar + 3-column on tablet/desktop).

## Functions

**`server/api/llm/request.post.ts`** — the dashboard's faithful stand-in for [[llm-pipeline]]'s real `POST /api/llm`: mints a `jobId`, creates the Firestore `llmResults/{jobId}` doc, and publishes to the resolved topic via the shared `#models` (`config/models.js`) mapping — same contract the real backend uses. `server/api/llm/{models,types,system-prompt}.get.ts` back the Publisher form's dropdowns; `server/api/llm/[jobId].delete.ts` clears a job.
**`server/api/pubsub/publish.post.ts`** — a lower-level raw publisher (arbitrary `{topic, message, environment}`), independent of the `llm/` request shape above — used where a raw Pub/Sub message is what's being tested, not a full simulated request.
**`server/api/admin/tool.*` / `admin/tools.get.ts`** — proxy to (or reimplementation of) [[tools-management]]'s tool CRUD, backing `ToolForm`/`ToolsList`/`ToolImport`.
**`server/api/admin/prompt.*` / `admin/prompts.get.ts`** — CRUD for [[prompt-library]]'s `prompt_library` entries (`{mapping, active, content, modelOverride}`), backing the Prompts page.
**`server/api/admin/model-config*.ts`** — reads/writes per-model configuration (surfaced by the `model-config.vue` page); not documented in any other design doc — see report.
**`server/api/health.get.ts`** (consolidated) and **`server/api/health/{mongo,ollama,pubsub}.get.ts`** (per-service) — connection checks surfaced by `HealthRing.vue`/`ConfigPanel`.
**`server/api/store/*.ts`** — Firestore/Mongo/Neo4j browsing endpoints (collections, children, rules, graph, GraphQL) backing the Store page and `GraphExplorer.vue`/`FirestoreNode.vue`.
**`composables/useJob.ts`** — subscribes to a job's live status (the client-side half of [[llm-pipeline]]'s `onSnapshot` pattern), used by `Request.vue`/`JobResults.vue` instead of a server-side SSE stream.
**`composables/useLogger.ts`** — Pino logger writing to `localStorage` (key `yeschef-llm-logs`), read by `LogsViewer.vue` with real-time search over message + module fields.
**`composables/useTheme.ts`** — dark/light toggle persisted to `localStorage` (key `yeschef-llm-theme`), defaulting to dark.

## Models

Job tracking is via the same `llmResults`/results shape described in [[llm-pipeline]] and [[plan-orchestration]] — the dashboard has no data model of its own beyond `localStorage` keys for theme and activity logs.

## Use Cases

### 1. Publish a test query and watch it stream

**Goal:** A developer wants to exercise the real `/ai/plan` orchestrator + worker pipeline against a live model without deploying, so they can see the exact prompt/response for a change they just made.
**Stakeholders:** The developer; the on-call engineer who needs the pipeline demonstrably working before a deploy.
**Actors:** A developer, using `Request.vue` (`dashboard/pages/index.vue`).
**Preconditions:** A company and user exist (or are created inline); `npm run dev` is running in the parent repo (worker + Ollama + emulator, for Local Dev) or production credentials are configured (for Production); the model list has loaded from `/api/llm/models`.
**Postconditions:** A `llmResults/{jobId}` Firestore document exists with a terminal `status` of `success` or `fail`, and one `steps/{msgId}` doc per planner/step run has been written by the worker.
**Basic Course of Events:**
1. Developer selects a company and user (Listbox pickers backed by `/api/db/companies` and `/api/db/users`).
2. Developer selects a model tier from the Model dropdown (populated by `/api/llm/models`, filtered to dev-capable tiers when Local Dev is active).
3. Developer types a prompt into the Request tab's textarea.
4. Developer clicks the floating Submit button (or presses Shift+Enter).
5. `submitRequest()` POSTs `{userId, companyId, userPrompt, model, metadata}` to `{aiBaseUrl}/plan` (the real orchestrator's `/ai/plan` endpoint, not a dashboard stand-in), with a bearer token from `useAuth().getToken()` and a 15s timeout.
6. The orchestrator returns a `jobId`; the dashboard shows a success toast, adds an optimistic entry to the request-history list (persisted to `localStorage` under `yeschef-llm-history`), selects the new request, and switches to the Results tab.
7. `useJob().bind(jobId)` subscribes via `onSnapshot` to the `llmResults/{jobId}` doc and its `steps` subcollection; `JobResults.vue` renders the planner run and each step/unit run as they arrive, with a pulsing indicator on the Results tab while `jobStatus` is `running`.
8. The job doc's `status` reaches `success` or `fail`; the pulsing indicator stops.

**Alternate Flows:**
- **Re-run an edited prompt:** developer selects a past request from the history list (`selectRequest`), which restores its company/user/model/prompt into the form; editing the prompt text re-enables Submit (`canSubmit` requires the text differ from the original), and submitting creates a brand-new `jobId` — the original request is never mutated.
- **Raw Pub/Sub message:** for testing a message shape rather than a full simulated request, `server/api/pubsub/publish.post.ts` publishes an arbitrary `{topic, message, environment}` directly, bypassing the `/plan` contract entirely.
- **Environment toggle:** switching Local Dev ↔ Production in `config.vue` re-fetches companies/users/models for that environment and changes whether Pub/Sub traffic goes to the emulator or real GCP; Firestore is unaffected either way.

**Exceptions:**
- Missing company, user, or prompt text: `submitRequest` shows a "Missing required fields" error toast and does not call `/plan`.
- The `/plan` POST fails or times out (15s): the failure is logged to console and surfaced via an error toast with the underlying message; no optimistic history entry is added and no job is created.
- The Firestore `onSnapshot` read fails (e.g. permissions, offline): `JobResults`/history reads show an error toast ("Could not read request" / "History read failed") rather than silently showing nothing.
- Deleting a request whose job is mid-run: `deleteRequest` calls `DELETE /api/llm/[jobId]`, which removes the Firestore doc; if the delete call itself fails, an error toast is shown and the item is left in the list.

---

### 2. Inspect a run's prompts, messages, and results

**Goal:** A developer wants to see exactly what was sent to the model (assembled prompt), what was published to the worker (message), and what came back (response), per planner/step run, to debug a bad output.
**Stakeholders:** The developer debugging a prompt or tool; the prompt author, whose prompt's real assembled output is otherwise invisible.
**Actors:** A developer, using `Request.vue`'s Message/Prompt/Results tabs, backed by `useJob.ts`.
**Preconditions:** A request has been selected (submitted or picked from history) so a `jobId` is bound.
**Postconditions:** No state changes — this is a read-only inspection use case.
**Basic Course of Events:**
1. Developer selects a request from the left history panel.
2. `useJob().bind(jobId)` subscribes to the job doc and its `steps` subcollection.
3. Developer opens the Message tab: `messageLog` lists each run (planner first, then steps by index) with its raw published message (the Pub/Sub input).
4. Developer opens the Prompt tab: the same run list, showing the fully assembled prompt (system + tools + subtypes + request) that was actually sent to the model — the model's input, not its output.
5. Developer opens the Results tab: `JobResults.vue` renders `steps` (joined plan definitions + unit runs from `useJob`), separating "output" steps (`includeInResults: true`) from "thinking" steps, each with status, runtime (`updatedAt - createdAt`), and a copy-to-clipboard control on prompt/message/response fields.
6. Developer copies a field via the clipboard icon; a toast confirms the copy.

**Alternate Flows:**
- **Fan-out/chain step with multiple units:** a step with more than one unit-run is aggregated (`aggregate()` in `useJob.ts`) into a single card — responses joined in unit order, status rolled up (any fail → fail; any running/pending → running; else success), runtime = the longest unit — rather than shown as separate unrelated cards.
- **Legacy/cold-start job with no `steps/` docs yet:** `messageLog` falls back to the job document's own top-level `message`/`prompt`/`response` fields so the tabs are never blank during the worker's cold-start window.
- **Debug re-run of a single step:** a step can be re-triggered from its card; a soft-deleted run (`isDeleted: true`) is filtered out of `runs`, so only the latest active run per step renders (`runFor`/`runsFor`).

**Exceptions:**
- No planner run doc exists yet: the Plan view shows "no plan" rather than falling back to a stale/legacy top-level `response` field — this is deliberate, to avoid masking a broken planner write.
- A run has an `outcome` (failure reason) written by the worker: it renders as `fail` even if a redelivered retry briefly reset `status` back to `running` — `outcome` always wins over `status` so the UI can never show contradictory state.
- No request is selected: all three tabs show a centered "Select a request to view…" placeholder instead of an empty table.

---

### 3. Author, edit, or import a tool

**Goal:** A developer wants the model to be able to call out to a new piece of functionality (an API, a DB query, etc.) during a run, without touching worker code.
**Stakeholders:** The developer adding the capability; the prompt author who will reference the tool by name; the on-call engineer, since a bad tool definition goes live for the next real request with no approval gate.
**Actors:** A developer, using `ToolForm.vue`, `ToolsList.vue`, and `ToolImport.vue` (`dashboard/pages/tools.vue`).
**Preconditions:** The developer knows the tool's name, description, and how it should run (API call vs. other implementation type).
**Postconditions:** A tool document exists (or is updated) via `/api/admin/tool.*`, immediately usable by the worker on its next request that includes tool-calling.
**Basic Course of Events:**
1. Developer opens the Tools page and clicks to create a new tool (or selects an existing one from `ToolsList.vue` to edit — the header then reads "Edit Tool v{version}").
2. Developer enters a snake_case Tool Name (e.g. `search_recipes`) and a Description — the description is what the model reads to decide *when* to call the tool, so the form calls this out explicitly.
3. Developer picks a Type (e.g. `api_call`), which reveals type-specific fields (for `api_call`: Endpoint URL, HTTP Method, etc.).
4. Developer configures parameters via `ParameterBuilder.vue`.
5. Developer toggles Active on, and submits the form.
6. The form POSTs (new) or PUTs (existing) to `/api/admin/tool.*`; on success the tool is live for the worker's next request.

**Alternate Flows:**
- **Bulk import:** instead of authoring one tool by hand, the developer opens `ToolImport.vue` and either pastes a JSON array of tool definitions or uploads a `.json` file; a preview lists each tool by name before the developer confirms the import.
- **Deactivate without deleting:** toggling Active off (the `Toggle` in the form header) keeps the tool definition but removes it from what the worker offers the model — used to retire a tool without losing its configuration.
- **Delete:** removing a tool via `ToolsList.vue` calls `/api/admin/tool.delete.ts`.

**Exceptions:**
- Required field validation fails (missing name, type, or description): the form shows inline field errors (`errors.name`, `errors.type`, `errors.description`) and does not submit.
- Pasted/uploaded JSON in `ToolImport.vue` is malformed or not an array of valid tool shapes: an error banner ("Error: …") is shown and nothing is imported.
- The save/import request to `/api/admin/tool.*` fails server-side: an error toast surfaces the failure; the tool list is not optimistically updated.

---

### 4. Author or edit a prompt

**Goal:** A developer or prompt author wants to change what system/step prompt the worker assembles for a given request type or model, without redeploying.
**Stakeholders:** The prompt author; the developer who needs the assembled result visible in the Prompt tab (use case 2) to verify the change; the on-call engineer, since prompt edits also go live immediately.
**Actors:** A developer or prompt author, using `PromptForm.vue`/`PromptsList.vue` and `MarkdownEditor.vue` (`dashboard/pages/prompts.vue`).
**Preconditions:** The `prompt_library` entry's target request type(s) are known; for a new prompt, at least one request type from the shared `/api/llm/types` list is selectable.
**Postconditions:** A `prompt_library` document is created or updated via `/api/admin/prompt.*`, active immediately for matching requests unless deactivated.
**Basic Course of Events:**
1. Developer opens the Prompts page and selects "New Prompt" or an existing one from `PromptsList.vue`.
2. Developer picks which request types this prompt applies to, via a searchable multi-select populated from the shared `availableTypes` list (order set by drag-drop in the list view).
3. Developer optionally sets a Model override — pinning a specific model for this prompt instead of inheriting the request's chosen model.
4. Developer writes/edits the prompt body in the WYSIWYG `MarkdownEditor.vue` (content stored as markdown).
5. Developer toggles Active on and clicks Save.
6. The form calls `/api/admin/prompt.post.ts` (new) or `/api/admin/prompt.put.ts` (existing); on success the prompt is what the worker assembles into requests of the selected type(s) going forward.

**Alternate Flows:**
- **Reorder which prompt applies:** when multiple prompts target overlapping types, `PromptsList.vue`'s drag-drop reordering determines precedence.
- **Deactivate without deleting:** toggling Active off removes the prompt from assembly without discarding its content — used to retire a prompt variant while keeping it for later reference.
- **Delete:** `/api/admin/prompt.delete.ts` removes the prompt entirely.

**Exceptions:**
- No request types are defined yet: the type-selector shows "No request types defined" and the prompt cannot be scoped to anything until `/api/llm/types` returns options.
- Save fails against `/api/admin/prompt.*`: an error toast surfaces the failure and the WYSIWYG content is preserved in the form (not cleared), so the developer doesn't lose their edit.
- Save is attempted with `canSave` false: the Save button is disabled client-side rather than issuing a bad request.

---

### 5. Diagnose an unreachable service via health checks

**Goal:** A developer whose test query is stuck or failing wants to know which upstream dependency (Mongo, Firebase, Neo4j, Pub/Sub, orchestrator, or a specific model) is actually down, rather than guessing from a generic error.
**Stakeholders:** The developer debugging a stuck run; the on-call engineer relying on the dashboard to distinguish "my change is broken" from "the local stack isn't running."
**Actors:** A developer, using `HealthRing.vue` and the Services panel on `config.vue`, backed by `useHealth.ts` and `server/api/health.get.ts`.
**Preconditions:** The dashboard is running (even if the parent `npm run dev` stack is not — health checks must degrade gracefully rather than crash the dashboard itself).
**Postconditions:** No state changes — the check is read-only; the developer knows which specific service is failing and why.
**Basic Course of Events:**
1. The leader tab (elected via the Web Locks API in `useHealth.ts`) polls `GET /api/health?env={local|production}` every 5 seconds.
2. `health.get.ts` checks MongoDB (client connect), Firebase (project ID configured), Neo4j (`verifyConnectivity`), Pub/Sub (topic existence check against a known topic), the orchestrator (`/ai/health`), and each model (Docker container running, for local; Pub/Sub topic + MIG size, for production).
3. The result is broadcast to all other tabs via `BroadcastChannel` and persisted to `localStorage` (`yeschef-health-state`) so a newly opened tab shows status instantly.
4. `HealthRing.vue`/the Services panel render each segment with an icon + text + color (never color-only), plus the healthy/total count (e.g. "3/5 Services Online").
5. Developer clicks/hovers the failing segment to see its specific error string (e.g. "Instance suspended (resume to use)" for a paused Neo4j Aura instance, or "container not running (cold)" for a model).
6. Developer consults the Troubleshooting table (below) for that specific error and resolves it (e.g. starts `npm run dev` in the parent, or runs `ollama serve`).

**Alternate Flows:**
- **Follower tab:** a non-leader tab never hits `/api/health` itself; on env change or manual refresh it posts a `refresh` message on the `BroadcastChannel` and renders whatever the leader broadcasts back.
- **No Web Locks API available (older browser):** `useHealth.ts` degrades to per-tab polling instead of leader election, so health checks still work, just without cross-tab coordination.
- **Environment switch mid-check:** switching Local Dev ↔ Production aborts any in-flight health fetch (`fetchAbort.abort()`) and immediately re-checks against the newly selected environment's config.

**Exceptions:**
- A service's env vars are missing (e.g. no `NEO4J_URI`): that segment reports `ok: false` with a specific "not configured" error rather than attempting and timing-out a connection.
- Neo4j Bolt connection fails: the check falls back to asking the Aura Admin API for instance state, distinguishing "paused/suspended" or "resuming" from a genuine connection failure, since a paused free-tier instance is the common case and looks identical to a real outage over Bolt alone.
- The orchestrator's `/ai/health` is unreachable: `orchestrator.ok` is `false` with the underlying fetch error message, which is what confirms "the parent `npm run dev` isn't running" versus a real regression.
- `/api/health` itself throws before returning (e.g. the shared `#models` config fails to load): models are left as an empty object rather than failing the whole health response, so the rest of the panel still renders.

## Tests

No test suite exists for `dashboard/` — verified against `dashboard/package.json` (no `test` script) and the absence of any `*.test.*`/`*.spec.*` file under `dashboard/`. This is a local testing tool for exercising [[llm-pipeline]]; the pipeline logic it exercises is unit-tested where it actually lives (worker/functions), not here.

## UI/UX

Glass-morphism theme (see Architecture) — one visual language shared across every page/component, dark mode default. Information architecture is a deliberate top-to-bottom flow: Config → Publisher → Results → Tools, with the primary action (Publish) visually prominent and logs visible-but-not-overwhelming in a side panel. The CSS system of record is `dashboard/assets/css/main.css`. Shared UI primitives used throughout have their own mockups: [[toggle]], [[select]], [[searchable-select]], [[confirm-dialog]], [[toast]], [[chip-input]], [[collapsible-sections]], [[health-ring]], [[step-status]], [[markdown-editor]]. Page-level panels that compose these (`ToolForm`, `ToolsList`, `JobResults`, `StepForm`, `MenuForm`, `GraphExplorer`, `Request`, `Store`, `PromptForm`, `PromptsList`, `FirestoreNode`, `ExternalTools`) are features, not individual elements, so per the docs/README convention they don't get their own mockup file — they're described at the feature level in this doc and in [[tools-management]]/[[plan-orchestration]]/[[prompt-library]].

**Troubleshooting reference:**

| Issue | Solution |
|-------|----------|
| "Cannot connect to MongoDB" | Check `.env.dev` has correct `MONGO_URI` |
| "Pub/Sub emulator not found" | Ensure `npm run dev` is running in the parent dir |
| "No results appearing" | Check the worker is running; inspect MongoDB directly |
| "Ollama offline" | Run `ollama serve` separately or restart `npm run dev` |

## Dependencies

- [[llm-pipeline]] — the request/result contract the Publisher and Results Viewer exercise.
- [[tools-management]] — the tool CRUD this dashboard's Tools pages are a UI for.
- [[plan-orchestration]] — the plan/step data this dashboard's plan-library/job views render.

## Diagrams

See the "Dashboard (Nuxt)" and "File structure" blocks in Architecture above.

## References

- Practical setup/run instructions: `dashboard/README.md` (kept separate from this design doc — quick-start, not architecture).
