---
modified: 2026-08-30
dependencies: [tools-management, llm-pipeline]
supersedes: null
---

# sub_agent — a clean-context reviewer tool

## Problem

Over ~20 measured runs, a local model (llama3.1:8b, and the 70b tier) asked to review the table it just generated against stated Pass/Fail criteria never fails itself — it emits a satisfied review paragraph even on runs whose rows plainly violate the criteria. The same model, given the same criteria and a single defective row in a fresh call with no authorship of that row, flipped 3 of 4 defective rows to a correct verdict. The worker has no mechanism for routing a review to a clean context.

## Solution

Add one worker-executed tool, `sub_agent`, that issues a second `chatRound` on the same host and model with an absent tools array and a two-message payload the CODE builds: the Pass/Fail criteria lifted from the step's own rendered instruction, plus the artifact stripped of its thinking block, its status block and its reason columns. The model decides when to call it and supplies no arguments. When the model never calls it, `handleMessage` runs the same review once against the finished output.

## Target Design Docs

- [[tools-management]] — after the wiring lands, update this doc to describe `sub_agent` as a fourth worker-executed tool alongside `web_search`/`web_fetch`/`normalize_ingredients`/`note_write`/`note_read`. Add to **Architecture**: the tool is executed by `worker/index.js`'s `executeTool` against `worker/tools/subagent.js`, and its child call goes through the same `chatRound` transport and the same module-level keep-alive agent as the parent round. Add to **Functions**: `runSubAgent`, `criteriaFrom`, `artifactOf`, `SubAgent.observe`, `SubAgent.snapshot`. Add to **Models**: the tracking-record shape from `## Tracking Record` below, and the fact that `parameters.properties` is empty by design — arguments a model supplies are recorded in `modelArgs` and never used. Add to **Use Cases**: the use case in `## Use Cases` below. Add to **Tests**: `worker/tools/subagent.test.js`.
- [[llm-pipeline]] — after the wiring lands, update this doc to describe: `executeTool`'s fourth parameter (`sub`), `chatWithTools`'s `sub` parameter and its per-round `sub.observe(content)` call, the fallback review call site in `handleMessage` after `fullResponse` is final, and the run doc's new `review` field written inside the existing completion transaction.

## Scope

**`config/tools.js`** — append one entry to `DEFAULT_TOOLS`, exactly as given in `## Tool Definition`. No other entry changes. This is the only edit needed for the planner to see and assign the tool (`toolLine` in `worker/index.js` formats it into the planner's tool list, and `payload.tools` carries the assignment into the step).

**`worker/tools/subagent.js`** (new) — exports, matching `worker/tools/notepad.js`'s shape and comment discipline (a header comment stating why the file exists, with the measured failure it addresses):

- `SUB_AGENT_TOOL_NAME = "sub_agent"`.
- `REVIEW_SYSTEM` — the child's system message, verbatim text in `## Child-Call Mechanics`.
- `class SubAgent` — the per-run state: `criteria`, `numCtx`, `sampler`, `depth`, `artifact`, `calls`; methods `observe(text)` and `snapshot()`.
- `criteriaFrom(messages)` — the criteria, from the step's own prompt. Take the last `role: "user"` message, slice the `# Instructions` section out of it with `/^# Instructions\n([\s\S]*?)(?=\n# |$)/m`, then slice from the first `/^Pass:/m` to the end of that section. No `Pass:` line present → the whole `# Instructions` section. Never the prior-step context blocks, and never the RAG context.
- `artifactOf(full)` — `splitOutcome(full).clean` (from `worker/steps/outcome.js`, which already removes THINKING blocks and the status block), then `dropReasonColumns` over the contiguous lines beginning with `|`. Two or more such lines → return only those lines; otherwise return the whole `clean` text.
- `dropReasonColumns(rows)` — split each row on `|`, drop every cell whose header cell matches `/^(reason|reasons|why|rationale|justification|notes?|comments?|explanation)$/i`, re-join. Carries a `ponytail:` comment naming the ceiling: a naive `|` split, upgrade to a real cell parser if an escaped pipe ever appears in a cell.
- `runSubAgent(sub, { trigger = "model", args = null, chat = chatRound })` — the child call and the tracking record. `chat` is injectable so the unit tests never reach Ollama, matching `worker/ollama.js`'s injectable-opts convention.

**`worker/tools/subagent.test.js`** (new) — `node:test` + `node:assert/strict`, no framework, stubbed `chat`. Tests named in `## Testing Requirements`.

**`worker/index.js`** — five edits, no others:

1. Import `SubAgent`, `runSubAgent`, `criteriaFrom`, `SUB_AGENT_TOOL_NAME` from `./tools/subagent.js`.
2. `condenseToolResult`: add `if (name === SUB_AGENT_TOOL_NAME) return result;` beside the existing `normalize_ingredients` and notepad pass-throughs — the verdict is the model's own text back, and the generic fall-through would `JSON.parse` a clipped string.
3. `executeTool(name, args, pad, sub)`: add a fourth parameter and a branch — no `sub` on this step returns `{ error: "No reviewer on this step." }`, otherwise `return await runSubAgent(sub, { trigger: "model", args })`. The branch discards `args` for the child call and hands them to the record only.
4. `chatWithTools(initialMessages, onChunk, numCtx, toolDefs, style, pad, sub)`: add the trailing `sub` parameter; call `sub?.observe(content)` immediately after the assistant round is pushed onto `messages`; pass `sub` through to `executeTool`.
5. `handleMessage`, in the non-fake, non-gateway path: resolve the sampler once with the existing helpers (`samplerForStyle(await getSampler(), genStyle, await getStyleTemps())`), construct `const sub = new SubAgent({ criteria: criteriaFrom(messages), numCtx, sampler })`, pass it as `chatWithTools`'s last argument, run the fallback described in `## Fallback Path` after `fullResponse` is final and before `splitOutcome(fullResponse)`, and add `review: sub.snapshot()` to the existing completion transaction's `tx.set` object.

**Not changed, deliberately:** `worker/admission.js` — `review` is added to `handleMessage`'s `tx.set` alongside `completionWrite`'s returned fields rather than threaded through `completionWrite`, so the CAS function's return shape (asserted by `worker/admission.test.js`) is untouched. `worker/ollama.js` — `chatRound` already takes `tools` as a parameter and already owns the keep-alive agents; the child call needs nothing new from it. `worker/tools/notepad.js` — the notepad's `pad` wiring is left exactly as it is. `dashboard/` — the `review` field is read from Firestore directly; no UI surface in this plan.

## Tool Definition

Appended as the last entry of `DEFAULT_TOOLS` in `config/tools.js`:

```js
  // The clean-context reviewer. The MODEL decides WHEN; the CODE decides WHAT is sent — see
  // worker/tools/subagent.js. `properties` is EMPTY on purpose: an argument is a lever, and left
  // to itself the model sends the rows it already believes are fine plus its defence of them.
  {
    name: "sub_agent",
    description:
      "Hand your finished table to a FRESH reviewer that has never seen your reasoning and did not write the table. " +
      "WHEN TO USE: once, as soon as the table is complete and BEFORE you write your own Pass or Fail verdict. " +
      "HOW TO CALL IT: with NO arguments. You do not choose what is sent — the system sends the table you just wrote and the Pass and Fail criteria from your instructions, and nothing else: not your thinking, not any reason column, not your defence of any row. " +
      "WHAT IT RETURNS: the reviewer's verdict — PASS, or FAIL naming the rows that break the criteria. " +
      "Treat that verdict as an independent finding, not a suggestion: if it names a row, correct that row and state what you changed. " +
      "WHEN NOT TO USE: do not call it before the table exists, and do not call it twice. " +
      "You cannot run this check yourself — you already believe your table is correct, which is exactly why this tool exists.",
    parameters: { type: "object", properties: {}, required: [] },
  },
```

## Child-Call Mechanics

The child system message, a constant in `worker/tools/subagent.js`:

```
You are reviewing a table you did not write. You have no stake in it.

Check the table against the criteria, row by row. Judge only what the table
says — there is no reasoning to consider, so do not imagine one and do not
give the table the benefit of the doubt. Name every row that breaks a
criterion, and the criterion it breaks.

End your reply with exactly one status block and nothing after it:
  @@::PASS::@@                   every row meets every criterion
  @@::FAIL:the reason::@@        one or more rows do not

Do not rewrite the table. Do not suggest improvements. Verdict only.
```

The child call, in `runSubAgent`:

```js
const started = Date.now();
const { content } = await chat(
  [
    { role: "system", content: REVIEW_SYSTEM },
    { role: "user", content: `# Criteria\n${sub.criteria}\n\n# Table\n${sub.artifact}` },
  ],
  undefined,        // tools: ABSENT. The child has no sub_agent to call, so recursion is not
                    // disabled at runtime — it does not exist. sub.depth is the caller-side backstop.
  () => {},         // onChunk: a sink. chatRound awaits it per piece; the child's text must never
                    // reach the parent's Firestore response stream or the live UI.
  sub.numCtx,       // the PARENT's num_ctx, UNCHANGED. A different num_ctx makes Ollama reload the
                    // runner — tens of seconds. Same host, same model, same window, same weights.
  { sampler: sub.sampler },  // the parent's resolved sampler. No host, model, or agent override, so
                    // chatRound's env defaults and its module-level keep-alive agent are reused:
                    // an already-open socket, ~2-3ms to first byte, no process, no model load.
);
const { status, reason } = splitOutcome(content);
```

Argument handling: `runSubAgent` receives the model's `args` and writes them to the record's `modelArgs` field. They reach no other line of the function — not the messages, not the criteria, not the artifact. The tool's schema declares no properties, so a conforming model sends none; a non-conforming one is recorded and ignored.

Depth guard (the backstop, not the mechanism): `runSubAgent` returns `{ error: "sub_agent is not available inside a review." }` without calling `chat` when `sub.depth > 0`. A `SubAgent` constructed for a child call would carry `depth: 1`; the plan constructs none, so the guard is unreachable by design and exists to stay that way.

Model-facing return value: `{ verdict: content, status, reason }`, passed through `condenseToolResult` unclipped.

## Per-Run State

One `SubAgent` per run, constructed in `handleMessage` where `messages` and `numCtx` already exist — not defaulted inside `chatWithTools`, because the run doc has to be able to write `sub.snapshot()` after generation returns.

```js
export class SubAgent {
  constructor({ criteria = "", numCtx, sampler, depth = 0 } = {}) {
    this.criteria = criteria;   // the step's own Pass/Fail block, lifted by criteriaFrom
    this.numCtx = numCtx;       // the parent's window — reused so Ollama keeps the loaded runner
    this.sampler = sampler;     // the parent's resolved sampler
    this.depth = depth;         // 0 = a parent run. > 0 refuses, see the depth guard
    this.artifact = "";         // latest scrubbed deliverable; set by observe()
    this.calls = [];            // every call, in order
  }
  observe(text) { const a = artifactOf(text); if (a.trim()) this.artifact = a; }
  snapshot() { return { calls: this.calls }; }
}
```

It reaches `executeTool` the same way `pad` does — as a parameter threaded `handleMessage` → `chatWithTools` → `executeTool` — with one addition: `chatWithTools` calls `sub.observe(content)` on each assistant round, so the artifact is the model's own latest output rather than anything the model chose to pass in.

## Tracking Record

One entry per call, appended to `sub.calls` before the child call is issued and completed in place, so a call that throws still appears — a silent tool is indistinguishable from one never called (the same rule `runNotepadTool` follows).

```js
{
  n: 1,                            // order, 1-based
  trigger: "model",                // "model" (the model called it) | "fallback" (the caller did)
  at: "2026-08-30T04:12:55.310Z",
  ms: 8412,                        // child generation time
  modelArgs: null,                 // what the model tried to send. Recorded, never used
  sent: { criteria: "Pass: …\nFail: …", artifact: "| Day | Dish |\n| --- | --- |\n…" },
  got: { verdict: "Row 3 …\n@@::FAIL:row 3 repeats …::@@", status: "FAIL", reason: "row 3 repeats …" },
  error: null,                     // set instead of `got` when the child call throws
}
```

Persisted as the run doc's `review` field (`llmResults/{job}/steps/{unit}`), written inside the existing completion transaction beside `response`/`outcome`/`thinking`, so only the CAS winner writes it. `sent` carries the full criteria and artifact — a wrong row is traceable to the exact text the reviewer judged.

## Fallback Path

In `handleMessage`, after `fullResponse` is final and before `splitOutcome(fullResponse)`, on the non-fake, non-gateway path:

```js
sub.observe(fullResponse);
if (!sub.calls.length && sub.artifact && sub.criteria) {
  await runSubAgent(sub, { trigger: "fallback" });
}
```

Placed there, not inside `chatWithTools`, so it covers every path that produces a response: a plain answer, the round-cap answer, the web-tool degraded answer, and `chatNoTools` on a step that was never assigned the tool. One review per run either way, and never two.

A failed child call is recorded with `error` and does not fail the run: the review is a record, and the run's `status`/`outcome` continue to come from `splitOutcome(fullResponse)` exactly as they do today. A `sub_agent` verdict of FAIL therefore shows up in `review`, not in the step's terminal status.

## Use Cases

### 1. The model hands its finished table to a clean reviewer

- **Goal:** Get a Pass/Fail verdict on a generated table from a model call that has no authorship of it.
- **Stakeholders:** Whoever consumes the run's table and currently cannot tell a reviewed one from an unreviewed one; platform ops paying for the extra generation.
- **Actors:** The generating model (decides when to call `sub_agent`); the worker (`executeTool` → `runSubAgent`, decides what is sent); the reviewing child call (same Ollama host, same model, no tools).
- **Preconditions:** The step was assigned `sub_agent` in `payload.tools`; `criteriaFrom(messages)` found a non-empty criteria block; the model has emitted at least one round whose `artifactOf(content)` is non-empty.
- **Postconditions:** `review.calls` on the run doc holds exactly one record with `trigger: "model"`, its `sent.criteria`/`sent.artifact` and its `got.verdict`/`got.status`; the model has received the verdict as a tool result and answered after it.
- **Basic Course of Events (BCE):**
  1. `handleMessage` builds `messages`, computes `numCtx`, resolves the sampler, and constructs `new SubAgent({ criteria: criteriaFrom(messages), numCtx, sampler })`.
  2. `chatWithTools` runs round 0 with `assignedTools`; the model returns the table as `content` plus a `sub_agent` tool call.
  3. `chatWithTools` pushes the assistant round onto `messages`, then calls `sub.observe(content)` — `artifactOf` strips the THINKING block, the status block and any reason column, and stores the result in `sub.artifact`.
  4. `executeTool` routes `sub_agent` to `runSubAgent(sub, { trigger: "model", args })`, which appends the record and issues `chat(...)` with `tools` absent, `onChunk` a sink, `sub.numCtx`, and `{ sampler: sub.sampler }`.
  5. `splitOutcome(content)` parses the child's status block into `status`/`reason`; the record's `got` and `ms` are filled in.
  6. `condenseToolResult` passes the verdict through unclipped; `chatWithTools` pushes it as a `role: "tool"` message.
  7. Round 1: the model reads the verdict, corrects any named row, and answers with its own status block.
  8. `handleMessage`'s fallback check sees `sub.calls.length === 1` and issues no second review; the completion transaction writes `review: sub.snapshot()`.
- **Alternate Flows:** The model writes the call as text instead of using the tool-call field — `parseTextToolCall` recovers it (the name is in `toolDefs`, the empty argument object parses) and steps 4 through 8 run unchanged. The model never calls the tool — `## Fallback Path` runs one review with `trigger: "fallback"` after generation, and the record is written the same way.
- **Exceptions:** No `sub` on the step (a caller that did not thread it) returns `{ error: "No reviewer on this step." }` to the model rather than executing. `sub.depth > 0` refuses without issuing a child call. The child call throws or stalls (`chatRound`'s watchdog) — the record keeps `error`, the run's status still comes from `splitOutcome(fullResponse)`, and the run does not fail. `criteriaFrom` finds no criteria — the fallback issues no review, and `review.calls` is empty, which is the one visible state that means "this step had nothing to review against."

## Testing Requirements

All unit tests, `node:test` + `node:assert/strict`, no framework, in the new file `worker/tools/subagent.test.js`, run by the existing `npm test` glob (`worker/**/*.test.js`) and subject to the existing `npm run test:coverage` gate (90% lines / 80% functions on `worker/**`). The child transport is stubbed via `runSubAgent`'s injectable `chat`, so no test starts Ollama and none needs the `chatRound` socket. No existing test file is edited.

1. `the child call is issued with no tools at all` — asserts the stubbed `chat`'s second argument is `undefined`. Fails if the child is ever handed a tools array, which is the only way `sub_agent` could recurse.
2. `a call at depth greater than zero is refused without a child call` — a `SubAgent` with `depth: 1` returns an error and the stub is never invoked. Fails if the backstop stops guarding.
3. `the child never receives the parent's thinking block` — parent output containing `--- THINKING START ---`/`--- THINKING END ---` produces a child user message with none of that text. Fails the moment the artifact stops going through `splitOutcome`.
4. `the child never receives the parent's own status block` — parent output ending in `@@::PASS::@@` produces a child user message containing no `@@::`. Fails if the parent's self-verdict leaks in and prejudices the reviewer.
5. `the child never receives a reason column` — a markdown table with `Reason`, `Why` and `Notes` columns produces a child user message with those headers and their cells gone and every other column intact. Fails if `dropReasonColumns` stops matching or drops the wrong cells.
6. `arguments the model supplies are recorded and never sent` — call with `args: { rows: "these rows are fine because…" }`; the child user message contains none of that string, and `calls[0].modelArgs` contains all of it. Fails if the model regains control of the payload.
7. `the criteria come from the step's own Pass and Fail block` — `criteriaFrom` over a `buildMessages`-shaped message set returns the text from `Pass:` to the end of `# Instructions`, and excludes the `# Result of step N` context blocks and the system message. Fails if the criteria widen to include prior-step output or narrow to nothing.
8. `criteria fall back to the whole instructions section when no Pass line exists` — returns the `# Instructions` body, not the empty string and not the whole user message.
9. `the child reuses the parent's num_ctx and sampler` — the stub receives the exact `numCtx` value and the same sampler object the `SubAgent` was constructed with. Fails if a child ever asks for a different window, which makes Ollama reload the weights.
10. `the child call adds no host, model, or agent override` — the stub's `opts` has exactly the `sampler` key. Fails if the child stops reusing the module-level keep-alive agent and the env-configured host and model.
11. `the child's output never reaches the parent's stream` — the `onChunk` the stub receives is not the parent's callback, and calling it with text does not touch a parent-side buffer. Fails if the review starts streaming into the run's visible response.
12. `every call is recorded in order with what was sent and what came back` — two successive calls produce `n: 1, 2` with distinct `sent.artifact` and matching `got.verdict`. Fails if a wrong row stops being traceable.
13. `a child call that throws is recorded with an error, not silently dropped` — a rejecting stub leaves one record carrying `error` and no `got`.
14. `a verdict with no status block is recorded with a null status` — asserts `got.status === null`. Fails if a non-conforming review is recorded as a pass.
15. `observe keeps the latest non-empty artifact and ignores empty rounds` — an empty round after a table leaves `sub.artifact` at the table.
16. `artifactOf returns the whole clean text when the output has no table` — a prose deliverable is still reviewable.
17. `the fallback records exactly one call and marks it as the caller's` — `runSubAgent(sub, { trigger: "fallback" })` on a `SubAgent` with no prior calls yields one record with `trigger: "fallback"`; a `SubAgent` that already has a model call is not reviewed twice by the guard in `## Fallback Path`.
18. `sub_agent is defined with an empty parameter object` — imports `DEFAULT_TOOLS` from `config/tools.js` and asserts the `sub_agent` entry exists, its `parameters.properties` has no keys, its `required` is empty, and its name is snake_case. Fails if a parameter is ever added, which is how the model would take back control of the payload.

## Parallel / Dependent Breakdown

Buildable in parallel:

- **A.** `worker/tools/subagent.js` and `worker/tools/subagent.test.js` (test 18 imports `config/tools.js`, so it needs B's entry present to pass).
- **B.** The `config/tools.js` entry from `## Tool Definition`.

Dependent, in order:

1. **C.** The five `worker/index.js` edits — needs A and B.
2. **D.** `npm test` green, and `npm run test:coverage` still meeting its thresholds — needs C.
3. **E.** The [[tools-management]] and [[llm-pipeline]] updates specified in `## Target Design Docs` — needs D, since a design doc describes only as-built state.

## Success Criteria

1. `config/tools.js` contains a `sub_agent` entry whose `parameters.properties` is empty; `getTools()`'s planner tool list includes a `- sub_agent: …` line.
2. `npm test` passes with the 18 tests in `worker/tools/subagent.test.js` present and none skipped; `npm run test:coverage` still meets its 90% lines / 80% functions thresholds.
3. `worker/admission.js` and `worker/admission.test.js` are byte-identical to their pre-change state.
4. On a run where the model calls the tool, the run doc's `review.calls` has exactly one entry with `trigger: "model"`, a non-empty `sent.criteria`, a non-empty `sent.artifact`, and a `got.status` of `PASS`, `FAIL`, or `null`.
5. On a run where the model never calls the tool, the run doc's `review.calls` has exactly one entry with `trigger: "fallback"`. No run with a non-empty artifact and non-empty criteria has an empty `review.calls`.
6. For every record written, `sent.artifact` contains no `@@::`, no `THINKING`, and no reason-column header.
7. The step's `status` and `outcome` for a given `fullResponse` are unchanged from before this plan — the reviewer's verdict is recorded, not enforced.
8. A grep of `worker/` finds no second `http.Agent`/`https.Agent` construction and no `host`/`model` override at the child call site.

## Open Questions

Each of these needs a decision before implementation; the plan above implements the stated current behaviour for each.

1. `MAX_TOOL_ROUNDS` defaults to 4. A model-issued review consumes one round to call the tool and one more for the model to act on the verdict, leaving two for everything else. The plan changes nothing about the cap — confirm 4 stands, or name a new value.
2. The reviewer's verdict is recorded only; the step's terminal status still comes from the parent's own status block. Should a reviewer FAIL instead set the run's `status`/`outcome`, which routes the orchestrator to `failStep` and re-runs the plan forward?
3. The child inherits the parent's style sampler, including its temperature. Should the reviewer instead run at a fixed low temperature? A temperature change does not reload the runner, so this is free.
4. The fallback runs on every non-fake, non-gateway step that has both an artifact and criteria, including steps never assigned the tool. That is one extra generation per step. Should it be limited to steps that were assigned `sub_agent`?
5. On the 70b tier the extra generation is materially more expensive per step. Enable the fallback there, or restrict it to the 8b tier?
