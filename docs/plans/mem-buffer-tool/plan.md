---
modified: 2026-09-01
dependencies: [tools-management, llm-pipeline]
supersedes: null
---

# mem_buff — a rewritable, searchable buffer outside the model's context

## Problem

An autoregressive stream cannot erase: a diet audit on llama3.1:8b emitted "Cream — strikes: lactose-free" (correct) and "Lemon — strikes: low-sodium" (wrong) in one list, then carried the wrong strike into the final row, collapsing every row to the same two diets, because the only edit a stream has is appending "* Reason, corrected: …". Large payloads do not fit context either: 10 web results measured 347,790 chars, and "the 8192-ctx model truncated to 8191 and kept 4 tokens of the real prompt, so it produced nothing" (`worker/index.js:514`). The worker has no storage the model can rewrite or search.

## Solution

Add one worker-executed tool, `mem_buff`, with four verbs: `write` (stores text; a write about the same subject replaces the earlier one, which is the erasure), `read` (returns the next window of an entry), `query` (finds entries by content and returns the best window), `erase` (drops entries).

Storage is one `node:sqlite` FTS5 table in a per-run tempfile — no dependency, no native addon, no Docker change. Measured on `linux/amd64` in an image built from `docker/Dockerfile.base`: node 22.23.2, sqlite 3.51.3, FTS5 present, `pragma mmap_size` accepted. A 38 MB store indexed in 0.5 s at **+1 MB heapUsed / 50 MB rss**, so payload size does not enter the model's context or the worker's heap.

This plan is TEXT ONLY. No network fetch, no source specs, no URL handling.

## Target Design Docs

- [[tools-management]] — after the wiring lands, update this doc to describe `mem_buff` as a worker-executed tool alongside `web_search`/`web_fetch`/`normalize_ingredients`. Add to **Architecture**: the tool is executed by `worker/index.js`'s `executeTool` against `worker/tools/membuff.js`; every verb is one `node:sqlite` statement against a per-run FTS5 table in an unlinked tempfile, so no verb makes a model call, opens a socket, or spawns a process. Add to **Functions**: `MemBuff.write`, `MemBuff.read`, `MemBuff.query`, `MemBuff.erase`, `MemBuff.snapshot`, `MemBuff.close`, `subjectKey`, `runMemBuffTool`, `MEM_BUFF_TOOL_NAME`, `WINDOW_CHARS`. Add to **Models**: the row shape and cursor shape from `## Store and Cursor`, the tracking record from `## Tracking Record`, and the four return shapes from `## Verbs`. Add to **Use Cases**: the three use cases in `## Use Cases`. Add to **Tests**: `worker/tools/membuff.test.js`. State that FTS5 is lexical: it matches words and their stems, not meanings.
- [[llm-pipeline]] — after the wiring lands, update this doc to describe: `executeTool`'s `buff` parameter, `chatWithTools`'s `buff` parameter (declared with no default value, like `sub`), the construction site beside `let sub = null` at `worker/index.js:989`, the rewritten fall-through in `condenseToolResult` (no per-tool pass-through — the fix is that no result is ever parsed), `memory = buff.snapshot()` followed by `buff.close()` in the `finally` that frees the generation slot — in that order, because the tracking record is read out of the buffer and `close()` removes the tempfile — and the run doc's new `memory` field written inside the existing completion transaction.

## Scope

**`config/tools.js`** — append one entry to `DEFAULT_TOOLS`, exactly as given in `## Tool Definition`. No other entry is touched.

**`worker/tools/membuff.js`** (new) — a header comment naming both measured failures (the un-retractable "Lemon — strikes: low-sodium" row; the 347,790-char payload that left 4 tokens of the real prompt) and stating that the buffer is per-run and not durable. Exports:

- `MEM_BUFF_TOOL_NAME = "mem_buff"`.
- `WINDOW_CHARS = 400` — one module constant, **not** read from `process.env`.
- `subjectKey(text)` — the derived internal key. See `## Store and Cursor`.
- `class MemBuff` — per-run state: `db`, `dir`, `cursor`, `calls`; methods `write`, `read`, `query`, `erase`, `snapshot`, `close`. The constructor accepts `{ db }` so tests inject an in-memory database and never touch the filesystem.
- `runMemBuffTool(buff, args)` — records the call, dispatches on `args.op`, returns the model-facing value. Records the call **before** dispatching so a call that throws still appears in the run doc.

**FTS5 query syntax must never reach the model.** `args.match` is treated as plain words: tokenised to `[a-z0-9]{2,}` and joined with spaces before it reaches `MATCH`. A bare `"` , `*`, `:`, `-`, `NEAR`, `OR` or `AND` from the model is stripped, not passed through. This is the only thing coupling the model's learned behaviour to FTS5; keeping it out makes the engine one file to replace.

**`worker/tools/membuff.test.js`** (new) — `node:test` + `node:assert/strict`, no framework, no fixtures, injected in-memory db. Tests named in `## Testing Requirements`.

**`worker/index.js`** — four edits, no others:

1. Import `MemBuff`, `runMemBuffTool`, `MEM_BUFF_TOOL_NAME` from `./tools/membuff.js`.
2. `condenseToolResult`: **fix the generic fall-through, which throws.** No per-tool pass-through is added — a tool-name special case in a shared function is the thing to avoid, and the fixed fall-through returns a window unclipped on its own. `JSON.parse(clip(JSON.stringify(result), WEB_FETCH_CHARS))` clips mid-string and then parses the wreckage, and the call sits OUTSIDE the try/catch around `executeTool` — so an oversized result from ANY tool kills the whole step, for the one reason a tool result should degrade instead. Replace it with: stringify once, return `result` unchanged when it fits, and otherwise return `{ note: "tool result truncated from N chars", content: <clipped text> }`. No parse, so no throw. This is a pre-existing production crash path on the line the pass-through is added to, shared by every tool, and it is fixed once in the shared function rather than per caller.
3. `executeTool(name, args, sub, buff)`: add the `buff` parameter and a branch before the `normalize_ingredients` branch — no `buff` on this step returns `{ error: "No memory buffer on this step." }`, otherwise `return runMemBuffTool(buff, args)`.
4. `chatWithTools(initialMessages, onChunk, numCtx, toolDefs, style, sub, buff)`: add the trailing `buff` parameter **with no default value** and pass it to `executeTool`; in `handleMessage`, declare `buff` and `memory` beside `let sub = null` at `worker/index.js:989`, take `memory = buff.snapshot()` and then `buff.close()` in the `finally` that already frees the generation slot, add `memory` to the completion transaction's `tx.set` beside `response`/`outcome`/`thinking`.

**Not changed:** `worker/tools/search-pool.js`, `worker/ollama.js`, `worker/admission.js`, `worker/admission.test.js`, `package.json` (no dependency), `docker/`, and every existing `DEFAULT_TOOLS` entry.

**Known limit, stated so it is not discovered as a bug.** FTS5 is lexical. Measured on 30 real model outputs: `tofu brown rice` and `gluten free side` hit; `meat free meal` (corpus says vegetarian), `starter course` (appetizer), `morning meal` (breakfast) and `wheat allergy` (gluten) all MISS, as do the typos `vegetarain` and `brocolli`. The tool description therefore tells the model to query with words it expects to find in the text, and `read` — not `query` — is the guaranteed path to a payload the model itself just stored.

## Tool Definition

Appended as the last entry of `DEFAULT_TOOLS` in `config/tools.js`:

```js
  // Storage OUTSIDE the model's context that it can rewrite and search.
  // TWO measured failures, one tool: (1) a stream cannot erase — a diet audit emitted "Lemon —
  // strikes: low-sodium", could not retract it, and carried it to the final row; a write that
  // overwrites IS the erasure. (2) A payload does not fit context — 347,790 chars left 4 tokens
  // of the real prompt; the buffer holds it and hands back one window at a time.
  // NO KEYS CROSS THIS BOUNDARY: the same model wrote "Almonds:nut", "Almonds:starch" and
  // "Almonds:nuts" across three runs, so it cannot hold an identifier. It addresses data by the
  // WORDS it wrote (query) and by continuing (read).
  {
    name: "mem_buff",
    description:
      "Your working memory. It sits OUTSIDE what you have written, so unlike your reply it can be rewritten and searched. Pick one operation with `op`. " +
      "write — store something, or CORRECT something you already stored. Writing about the same thing again REPLACES what you stored about it and the old version stops counting: this is how you take a wrong line back. Do NOT write a correction underneath a mistake — write the line again, correctly. " +
      "query — find what you stored, using the WORDS you expect to be in it. Plain words only; it matches words and their endings, not meanings, so `dessert` finds `desserts` but `pudding` does not find `dessert`. You get back the best-matching piece. " +
      "read — CONTINUE. Call it to get the next piece of what you were just reading, again and again until you have as much as you need. It tells you when there is no more. " +
      "erase — drop what you are finished with, once you have used it and will not need it again. " +
      "ONE RULE. You never name, number or label anything in here: you find things by the words they contain (query), or by reading on. And a query that finds nothing means you were never given that fact — say you do not have it rather than filling the gap, the same way you write none for a medication list you were never given.",
    parameters: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["write", "read", "query", "erase"],
          description: "Which operation: \"write\" to store or correct, \"query\" to find by its words, \"read\" to continue reading, \"erase\" to drop what you are done with.",
        },
        text: { type: "string", description: "write only: the full text to store. Start it with what it is ABOUT (e.g. \"Lemon — strikes: none\"), because writing about the same thing again replaces it. Write the whole thing, not a patch." },
        match: { type: "string", description: "query: the words you expect to find in what you stored. erase: drop everything matching these words; omit to drop what you have just been reading." },
      },
      required: ["op"],
    },
  },
```

## Verbs

Exact argument and return shapes. No return value of any verb contains a key, a key list, a hit list, a per-hit snippet, or a count.

**`{ op: "write", text }`** — `delete from entries where subject = ?` then `insert`, in one transaction, keyed on `subjectKey(text)`. Any open cursor over that subject resets to offset 0. Returns `{ stored: true, replaced: true }` when a row already existed, `{ stored: true, replaced: false }` otherwise.

**`{ op: "read" }`** — returns the next `WINDOW_CHARS` characters of the entry the cursor is on, as a hard slice with no line-boundary adjustment:

```sql
select substr(body, :off + 1, :win) AS win, length(body) > :off + :win AS more
from entries where subject = :subject
```

Returns `{ text: "<window>", more: true }` while anything remains, `{ text: "<window>", more: false }` on the last window, and `{ text: "", more: false, exhausted: true }` when the cursor has passed the end. `more` is n+1 in spirit and never a total. With no cursor open, `read` opens one on the most recently written entry. `{ op: "read", restart: true }` sets the offset back to 0 on the entry the cursor is on.

**`{ op: "query", match }`** — `match` is tokenised to plain words, then:

```sql
select subject, max(0, instr(lower(body), :word) - 41) AS off
from entries where entries match :q order by bm25(entries) limit 2 offset :n
```

Two rows are requested and one is returned; the second row's existence is what sets `more`. The cursor opens on the returned subject **at that offset**, and `read` produces the window — so the model gets `WINDOW_CHARS` around its words with 40 chars of run-up, and a following `read` continues after it rather than from the top of the entry.

**Not `snippet()`.** Measured on 120 entries of 330 KB: `snippet()` takes 2,070 ms to return two rows, because it re-tokenises each whole body to place its window. `instr()` is a C byte scan over the same two bodies — 16.6 ms — and it returns a position, which is what lets the cursor land on the match. `bm25()` ordering itself is 16 ms; the ranking was never the cost.

- match found → `{ found: true, text: "<window>", more: <bool> }`
- no match → `{ found: false, note: "Nothing stored in this run matches those words. You were never given it — say you do not have it." }`

Nothing is ever dropped except by an `erase` the model asked for, so a no-match has one meaning and one note.

**`{ op: "erase" }`** — drops the entry the cursor is on and closes the cursor. With no cursor open, drops every entry. Returns `{ erased: true }`.

**`{ op: "erase", match }`** — drops every entry matching those words. Returns `{ erased: true }`.

**Unknown or missing `op`** returns `{ error: "mem_buff needs op: one of write, read, query, erase." }`. **`write` with no `text`** returns `{ error: "mem_buff write needs text." }`. **No buffer on the step** returns `{ error: "No memory buffer on this step." }`, from `executeTool`, before `runMemBuffTool` is reached.

## Store and Cursor

```sql
create virtual table entries using fts5(subject, body, tokenize='porter unicode61');
```

`subject` is the derived key and is never returned to the model. `body` is the stored text. The database is created with `fs.mkdtempSync(path.join(os.tmpdir(), "membuff-"))`, and `close()` removes that directory.

```js
// cursor: one per run, or null. `n` is query's rank offset — repeating the same words walks it.
{ subject: "lemon", off: 400, match: "lemon strikes", n: 0 }
```

**Pragmas**, set at construction: `mmap_size = 1073741824`, `journal_mode = WAL`, `synchronous = OFF`. The store is per-run scratch; durability across a crash is not wanted, and the run doc's `memory` field is the record that survives.

**Key derivation, internal, never returned.** `subjectKey(text)` takes the first line, cuts it at the first colon, em dash, hyphen, pipe or tab character, then lowercases it and collapses its whitespace. `"Almonds:nut"`, `"Almonds:starch"` and `"Almonds:nuts"` all derive `almonds`, so the model's third write overwrites its first two even though it demonstrably could not hold that identifier across three runs. `"Lemon — strikes: low-sodium"` and `"Lemon — strikes: none"` both derive `lemon`, so the correction erases the wrong strike. A first line with no separator derives the whole collapsed line. An empty derivation falls back to a positional key.

**No bounds and no eviction.** There is no maximum entry count and no maximum byte count, so nothing is discarded to make room and no configuration can cause silent data loss. SQLite pages the file; a 38 MB store measured +1 MB of heap.

## Tracking Record

One entry per call, appended to `buff.calls` **before** the verb runs and completed in place, so a call that throws still appears — a silent tool is indistinguishable from one never called.

```js
{
  n: 4,                                     // order, 1-based
  op: "write",                              // the verb, as the model sent it
  at: "2026-09-01T04:12:55.310Z",
  subject: "lemon",                         // the DERIVED key. Recorded for tracing, never returned
  replaced: "Lemon — strikes: low-sodium",  // the text this write overwrote, or null. The erasure, kept
  wrote: "Lemon — strikes: none",           // op:"write"
  match: null,                              // op:"query" / op:"erase", after tokenising
  found: null,                              // op:"query": true | false
  chars: 21,                                // characters returned to the model
  error: null,                              // set when the verb threw
}
```

Persisted as the run doc's `memory` field — `{ calls, entries: [{ subject, bytes }] }` from `buff.snapshot()` — at `llmResults/{job}/steps/{unit}`, written inside the existing completion transaction beside `response`/`outcome`/`thinking`, so only the CAS winner writes it. `replaced` carries the overwritten text, so a wrong final row is traceable to the revision that produced it. `snapshot().entries` carries subjects and sizes, not text.

## Speed

Measured on `linux/amd64` in an image built from `docker/Dockerfile.base`, and on 30 real model outputs (162 KB) from `.scratch/iter/results/*.json`.

| Operation | Measured |
| --- | --- |
| index 30 entries / 162 KB | 3.5 ms |
| index 120 entries / 38 MB | 0.5 s, +1 MB heapUsed, 50 MB rss |
| `query`, term in every one of 120 × 330 KB entries | 16.6 ms (`instr`) / 2,070 ms (`snippet`) |
| `query`, no match | 0.1 ms |
| `read`, one 400-char window | one `substr`, 3.4 ms on a 330 KB body |

The worst case found is a term present in all 120 entries, so bm25 ranks 120 rows — 16 ms of that measured budget is the ranking. Test 15 is the tripwire for a return to `snippet()`.

No verb makes a model call, opens a socket, or spawns a process.

## Use Cases

### 1. The model retracts a wrong line it already wrote

- **Goal:** Make a line the model has already emitted stop counting, so the final answer is built from the correction instead of the mistake.
- **Stakeholders:** Whoever consumes the run's table and today receives every row collapsed onto a wrong strike; the operator who cannot tell a corrected row from an uncorrected one.
- **Actors:** The generating model; the worker (`executeTool` routing to `runMemBuffTool`, deriving the subject, performing the delete-then-insert).
- **Preconditions:** The step was assigned `mem_buff` in `payload.tools`; `handleMessage` constructed a `MemBuff` and passed it to `chatWithTools`.
- **Postconditions:** Exactly one row exists under the derived subject, holding the corrected text; the run doc's `memory.calls` holds a record whose `replaced` is the wrong text; no value returned to the model contained the subject.
- **Basic Course of Events (BCE):**
  1. The model calls `{ op: "write", text: "Lemon — strikes: low-sodium" }`.
  2. `runMemBuffTool` appends the record; `write` derives `lemon`, inserts, returns `{ stored: true, replaced: false }`.
  3. `condenseToolResult` returns the result unchanged because it fits; `chatWithTools` pushes it as a `role: "tool"` message.
  4. The model recognises the strike is wrong and calls `{ op: "write", text: "Lemon — strikes: none" }`.
  5. `write` derives the same subject, copies the previous body into the record's `replaced`, deletes and reinserts, returns `{ stored: true, replaced: true }`.
  6. The model calls `{ op: "query", match: "Lemon strikes" }` and gets `{ found: true, text: "Lemon — strikes: none", more: false }`.
  7. The model writes the final row from that text and answers with its own status block.
  8. `handleMessage`'s completion transaction writes `memory: buff.snapshot()`.
- **Alternate Flows:** The correction drifts (`"Almonds:starch"` after `"Almonds:nut"`) — `subjectKey` cuts at the first colon, both derive `almonds`, step 5 runs unchanged. The model writes the call as text instead of a tool-call field — `parseTextToolCall` recovers it and steps 2–8 run unchanged.
- **Exceptions:** `write` with no `text` returns an error rather than storing an empty row. A step with no buffer gets `{ error: "No memory buffer on this step." }` from `executeTool`. A query for something never written returns `found: false` with the note, so absence is not read as a fact.

### 2. The model stores a payload too large for its context and reads only what it needs

- **Goal:** Get usable content out of text whose full length would truncate the prompt, without the model ever holding all of it.
- **Stakeholders:** Whoever depends on a grounded answer and today gets nothing when the payload overruns the window; the operator paying for a generation that produced no output.
- **Actors:** The generating model (decides how deep to read); the worker (the cursor and the `substr` window).
- **Preconditions:** The step was assigned `mem_buff`.
- **Postconditions:** The row holds the full text; the model received it only in `WINDOW_CHARS`-sized windows; `memory.entries` records the subject and byte size, not the text.
- **Basic Course of Events (BCE):**
  1. The model calls `{ op: "write", text: "<347,790 chars>" }`; the row is inserted and `{ stored: true, replaced: false }` returns.
  2. The model calls `{ op: "read" }`; the cursor opens on that entry and returns the first 400 chars with `more: true`.
  3. The model calls `{ op: "read" }` repeatedly; each call returns the next hard 400-char slice.
  4. The model has enough and calls `{ op: "erase" }`; the entry is dropped, the cursor closes, `{ erased: true }` returns.
  5. The model answers from the windows it read; the completion transaction writes `memory: buff.snapshot()`.
- **Alternate Flows:** The model reads to the end — the last window returns `more: false`, and a further `read` returns `{ text: "", more: false, exhausted: true }`. The model wants an earlier part again — `{ op: "read", restart: true }` sets the offset back to 0 without re-storing anything.
- **Exceptions:** `read` with no entries at all returns `{ text: "", more: false, exhausted: true }` rather than an error.

### 3. The model asks for something it never stored

- **Goal:** An absent fact is reported as absent, so the model states it does not have it instead of inventing one.
- **Stakeholders:** Whoever consumes a row whose Diets cell would otherwise carry a fabricated claim.
- **Actors:** The generating model; the worker (`query`).
- **Preconditions:** The step was assigned `mem_buff`; nothing matching was written.
- **Postconditions:** `found: false` with the note; no row was created; the call appears in `memory.calls` with `found: false`.
- **Basic Course of Events (BCE):**
  1. The model calls `{ op: "query", match: "sodium content of the broth" }`.
  2. `query` tokenises to plain words and finds no matching row.
  3. It returns `{ found: false, note: "Nothing stored in this run matches those words. You were never given it — say you do not have it." }`.
  4. The model states it does not have the figure.
- **Alternate Flows:** The words are present but phrased differently and FTS5 misses them lexically — the model gets the same `found: false`. This is the known limit in `## Scope`, and `read` is the path that does not depend on phrasing.
- **Exceptions:** `match` reduces to nothing after tokenising (the model sent only punctuation) — `query` returns `found: false` with the same note rather than an FTS5 syntax error.

## Testing Requirements

All unit tests, `node:test` + `node:assert/strict`, no framework and no fixtures, in the new file `worker/tools/membuff.test.js`, run by the existing `npm test` glob (`worker/**/*.test.js`) and subject to the existing `npm run test:coverage` gate (90% lines / 80% functions / 60% branches on `worker/**`). Every test injects an in-memory database, so no test touches the filesystem. No existing test file is edited.

Every test asserts the EXPECTED DATA — the exact text, the exact rows, the exact returned object — not the shape of a result or the presence of a field. `assert.deepEqual` against a literal, not `typeof`.

1. `a rewrite genuinely erases` — write `"Lemon — strikes: low-sodium"` then `"Lemon — strikes: none"`; the two writes return `{ stored: true, replaced: false }` then `{ stored: true, replaced: true }`, a query for `"Lemon strikes"` returns exactly `{ found: true, text: "Lemon — strikes: none", more: false }`, and the table holds exactly `[{ subject: "lemon", body: "Lemon — strikes: none" }]`. Fails if the buffer degrades into the append-only log the stream already is.
2. `a drifted label still overwrites` — `"Almonds:nut"`, `"Almonds:starch"`, `"Almonds:nuts"` leave exactly `[{ subject: "almonds", body: "Almonds:nuts" }]`. Fails if `subjectKey` stops cutting at the separator.
3. `no subject ever appears in any value returned to the model` — asserts the exact object returned by `write`, `query`, `read` and `erase`, so an added `subject` field is a diff; then asserts the derived key IS recorded internally (`calls[0].subject === "zubrowka"`), which is what makes the absence meaningful rather than vacuous.
4. `FTS5 syntax from the model is neutralised, not passed through` — `'"a" OR b*'`, `'body:x'`, `'NEAR(a b, 2)'`, `'-vegan'` and `'***'` tokenise to exactly `or`, `body`, `near`, `vegan`, `''`, and each returns the exact expected result (two hits with the full body, three no-matches with the note). Fails if the model's learned queries become coupled to FTS5.
5. `query matches a stem, not just the exact word` — body contains `desserts`; `match: "dessert"` returns the exact body.
6. `query is lexical and says so by missing a synonym` — body contains `vegetarian`; `match: "meat free meal"` returns exactly `{ found: false, note: <the note> }`. Fails if the known limit silently changes, which would make the tool description wrong.
7. `query returns the window AROUND the matched words, not the top of the entry` — a 4 KB body whose only mention of `sodium` is at the very end; the window ends with that sentence, the matched word sits at index 40 (the run-up), and a following `read` is exhausted. Fails if query goes back to returning the head of the entry.
8. `read walks an entry in windows and reports exhaustion` — a body of `WINDOW_CHARS * 2 + 10` chars yields windows of exactly `WINDOW_CHARS`, `WINDOW_CHARS` and 17 chars with `more` true, true, false; the first and last windows are asserted character-for-character; then `{ text: "", more: false, exhausted: true }`.
9. `the window is a hard slice, not a line-trimmed one` — a body with newlines either side of the boundary yields exactly `text.slice(0, WINDOW_CHARS)`.
10. `read restart returns to the start of the current entry` — the three windows equal `slice(0, W)`, `slice(W, 2W)`, `slice(0, W)`.
11. `read with no cursor opens on the most recently written entry` — write A then B, `read` returns exactly B's body.
12. `query returns one window, and repeating it walks the ranking n+1 with no total` — three matching entries of increasing length; three identical queries return the three bodies in bm25 order with `more` true, true, false. Asserted as one `deepEqual` on all three results, so a list-valued or count-valued field is a diff.
13. `erase with no argument drops the entry the cursor is on` — query, erase, then the same query returns the exact no-match object and the table holds exactly the other entry.
14. `erase with a match drops the matching entries only` — the table holds exactly the non-matching entry.
15. `the worst measured case stays inside its budget` — 120 entries of ~330 KB each (40 MB); the hit's text contains the queried words, the miss is the exact no-match object, the every-entry query is under 500 ms and the no-match under 5 ms, timed with `process.hrtime.bigint()`. The budgets are the measured 16.6 ms and 0.1 ms with headroom for a loaded CI box. Fails on a return to `snippet()`, which measured 2,070 ms on this corpus.
16. `a large body does not enter the heap` — one 10 MB body; 100 `read` calls each return exactly `WINDOW_CHARS` chars and `process.memoryUsage().heapUsed` grows less than 5 MB. Fails if `substr` materialises the whole row per call.
17. `an unknown op is an error, not a silent no-op` — `{ op: "digest" }` and `{}` both return the exact error string naming the four verbs, and nothing is stored.
18. `write with no text is an error` — a missing `text` and a whitespace-only `text` both return the exact error string, and nothing is stored.
19. `every call is recorded in order, including one that threw` — a stub whose verb throws returns exactly `{ error: "engine down" }`; the records' `[n, op, subject, replaced, error]` tuples are asserted as one literal, so the overwritten text and the numbering are both pinned.
20. `the snapshot carries subjects and sizes but not body text` — a 347,790-char entry produces `entries: [{ subject: "payload", bytes: 347800 }]`, a `wrote` record clipped to exactly 201 chars, and a serialized snapshot under 1000 chars.
21. `mem_buff is defined with the four verbs and no key parameter` — imports `DEFAULT_TOOLS` from `config/tools.js` and asserts `op`'s enum is exactly `["write","read","query","erase"]`, `required` is exactly `["op"]`, and the property names are exactly `["op","text","match"]` — so an added `key`/`slot`/`id`/`source` parameter is a diff.
22. `close removes the temp directory` — a file-backed buffer's directory exists, then does not after `close()`.
23. `subjectKey collapses a drifted first line to one key` — the four derivations asserted directly: `"almonds"`, `"lemon"`, `"two words"`, `""`.

## Parallel / Dependent Breakdown

Buildable in parallel:

- **A.** The `config/tools.js` entry from `## Tool Definition`.
- **B.** `worker/tools/membuff.test.js` — written FIRST, from `## Verbs` and `## Testing Requirements`, and failing.

Dependent, in order:

1. **C.** `worker/tools/membuff.js` — needs B, and A for test 21.
2. **D.** The four `worker/index.js` edits — needs A and C.
3. **E.** `npm test` green with no skips, and `npm run test:coverage` still meeting its thresholds — needs D.
4. **F.** The [[tools-management]] and [[llm-pipeline]] updates specified in `## Target Design Docs` — needs E, since a design doc describes only as-built state.

## Success Criteria

1. `config/tools.js` contains a `mem_buff` entry whose `op` enum is exactly the four verbs and whose schema has no property named `key`, `slot`, `id`, `name` or `source`; `getTools()`'s planner tool list includes a `- mem_buff: …` line.
2. `npm test` passes with the 35 tests in `worker/tools/memory-buffer.test.js` present and none skipped; `npm run test:coverage` still meets its 90% lines / 80% functions / 60% branches thresholds.
3. `worker/tools/search-pool.js`, `worker/ollama.js`, `worker/admission.js`, `worker/admission.test.js`, `package.json` and everything under `docker/` are byte-identical to their pre-change state.
4. `condenseToolResult` never parses a result: the `JSON.parse(clip(...))` fall-through is gone, and a run whose `read` window exceeds 6000 chars completes with no parse error.
5. `chatWithTools`'s `buff` parameter has no default value, and `handleMessage`'s call site passes one: a grep finds no `buff = new MemBuff()` in any parameter list.
6. On a run where the model writes twice about the same subject, the run doc's `memory.calls` holds a record whose `replaced` is the first text, and `memory.entries` holds exactly one entry for that subject.
7. A grep of `worker/tools/membuff.js` finds no `evict`, no `MAX_ENTRIES`, no `MAX_BYTES`, no `process.env` read, no `http`/`https`/`curl`/`fetch`, and no `spawn`/`execFile`.
8. A grep of `worker/tools/membuff.js` finds every `MATCH` parameter passing through the plain-words tokeniser, and no FTS5 operator character reaching a prepared statement from `args.match`.

## Open Questions

Each of these needs a decision before implementation; the plan above implements the stated behaviour for each.

1. **The key derivation.** `subjectKey` cuts the first line at the first colon, em dash, hyphen, pipe or tab, so `"Almonds:nut"` and `"Almonds:nuts"` collapse. Two genuinely different subjects sharing a prefix before the separator would also collapse and silently overwrite each other. The alternative is the whole first line as the key, which never over-collapses but restores the measured failure: three writes, three entries.
2. **The window size.** `WINDOW_CHARS = 400` implements "the first 100 tokens" at 4 chars per token. Confirm 400, or name a different number.
3. **Which steps get the tool.** `mem_buff` is assigned per step by the planner from its description, like every other tool. Confirm it is offered to every step, or name the steps (the diet audit, courses) it is assigned to.
4. **Firestore document size.** `memory: buff.snapshot()` holds one record per call plus the overwritten text in `replaced`. A run with many large corrections could approach Firestore's 1 MiB document limit alongside `response`, `prompt` and `thinking`. As built, `wrote` and `replaced` are each clipped to 200 characters (`RECORD_CHARS`), which bounds one record at ~500 bytes. Confirm 200, or name a different clip. (Superseded alternative: cap `replaced`'s length only, or leave it whole for traceability.)
5. **`node:sqlite` is experimental in Node 22** and prints one `ExperimentalWarning` to stderr per worker process. Verified working on the image's node 22.23.2 / sqlite 3.51.3. Accept the warning, or suppress it with `--no-warnings=ExperimentalWarning` in the worker's start command.
6. **The lexical limit.** FTS5 misses synonyms and typos (measured: 4 of 6 synonym queries and both typos). Accept that `query` is best-effort and `read` is the guaranteed path, or add a fuzzy/semantic layer as a separate plan once a measurement shows the model's phrasing is losing real content.
