# Prompt update — worklist

`[ ]` open · `[J]` Jess · `[K]` Kim · `[x]` done. Claim before you write. One player per record.
Numbers are permanent ids — never renumber. New work takes the next unused integer or a letter suffix.

Tool: `node scripts/prompt-patch.mjs --id <id> --field <f> --edits-file edits.json`
Dry run is default. Add `--commit`. Undo line printed on every write.

Order matters — items are numbered in execution order.

---

## 1. [J] `worker/steps/outcome.js` — extend `visibleResponse` + `splitOutcome`

Both already remove non-deliverable text from a streamed response. The thinking block is the same
class as the status block: a bookended region that is not the deliverable. Extend the two existing
functions; do not add a third.

```
+ const THINKING = /---\s*THINKING START\s*---[\s\S]*?---\s*THINKING END\s*---/g;
```

- `visibleResponse` — withhold from `--- THINKING START ---` onward, the same way it freezes at
  `OPENING`. Fixes the live-stream leak, which a terminal-only strip does not.
- `splitOutcome` — `clean` returns the response with both regions removed.

Remove **only when both markers are present**. START without END → leave the text and fail the run;
an unterminated block must not delete the deliverable.

## 1b. [ ] KEEP the thinking — do not discard it. **Before item 4.**

Robert: "WE have to keep the thinking for the LLM, we can't just throw it away."

As written it is deleted: `visibleResponse:69` and `splitOutcome:90` both `.replace(THINKING, "")`
and nothing captures the removed text. After the deploy it is unrecoverable, not merely misplaced.

- `splitOutcome` returns `thinking` alongside `{status, reason, clean}`.
- `worker/index.js:1009` persists it as its own field beside `response`.
- `visibleResponse` unchanged — it must keep withholding mid-stream; that is the live-leak fix.
- Unterminated block still leaves the text and fails the run; nothing captured, which is correct.

The dashboard already has a home for it: `useJob.ts:118` switches on
`def.includeInResults ? 'output' : 'thinking'`.

## 2. [J] `outcome.test.js` — extend the existing suite

Cases: both markers → region gone from `clean`; no markers → byte-identical; START without END →
unchanged; block + status block together; `visibleResponse` mid-stream with a half-written START.

## 3. [J] `worker/index.js` — no new call sites

`:1009` and `:1047` already route through `splitOutcome`, and the chunk flusher at `:712-747`
already routes through `visibleResponse`. Extending those two covers all three paths. Verify, do not
add.

## 4. [ ] `compose.js` — two generic helpers, no courses-specific function

`courseCounts` is already in ctx (`:307`). Handlebars iterates objects natively (`{{#each}}` + `@key`)
and `join`/`eq`/`ne`/`gt` already exist. The only gap is object → array, which is what stops `join`
from being reused. Two one-liners beside the existing helpers (`:16-19`):

```
+ hb.registerHelper("keys", (o) => (o && typeof o === "object" ? Object.keys(o) : []));
+ hb.registerHelper("without", (arr, ...a) => {
+   const drop = a.slice(0, -1).map(String);            // last arg is Handlebars' options object
+   return Array.isArray(arr) ? arr.filter((x) => !drop.includes(String(x))) : [];
+ });
```

Both work on any object/array in ctx — `flags`, `dietWeights`, `proteins`, `courseCounts` — and
compose with the `join` that is already there. No new ctx property.

Item 8 then uses:
```
{{join (without (keys courseCounts) "entree") ", "}}
```

`courseListNoEntree` (`:316-319`) is removed by item 9a — it bakes `/^entr[ée]e?s?$/i` into the
Function. `courseList` (`:308-311`) stays for now; its only consumer is the Build Courses paragraph
that items 8-10 do not touch.

## 5. [ ] `compose.test.js` — cover `keys` and `without`

Cases: `keys` on a non-object → `[]`; `without` on a non-array → `[]`; `without` with several values;
entrée-only `courseCounts` → empty string through the full `{{join (without (keys …) "entree")}}`.

## 6. [x] `plan_library/Build Courses`.instruction — `6a774dee46da04360288571f`

Kind vocabulary only. Bind where handlebars renders; the excluded position is prompt data.

```
- Kind is one of: side, dessert, drink, appetizer, soup, salad, starch, vegetable. Never `entree`.
+ The course positions for this call are: {{join (without (keys courseCounts) "entree") ", "}}.
+ Kind is one of those positions. Never `entree`. No other value may appear in that column.
```

Guard: renders `""` for an entrée-only plan. Wrap in `{{#if …}}` or confirm the existing `{{else}}`
branch covers it.

## 6a. [ ] BLOCKED on item 17 — thinking block goes in a fragment slot, not the instruction

The measured snippet (`complete: N of N` lines + the diet line) belongs in a `relatesTo` slot on a
`prompt_library` fragment, shared across subtypes. Do NOT inline it into `Build Courses.instruction`
— that restates response shape per step, which is what item 19 exists to stop.

Re-measure after placement: fragment position in the merge is unmeasured; the 18/18 was inline.

## 7. [x] `prompt_library/Courses system`.content — `6a774dee46da043602885720`

Fragments are NOT handlebars-rendered (`worker/index.js:371-386`). Static text only — reference the
label item 8 binds.

```
- Kind ∈ {side, dessert, drink, appetizer, soup, salad, starch, vegetable}. Never `entree`.
+ Kind is one of the course positions named in the instructions. Never `entree`.
```

Same record, same patch — remove the two statements that contradict item 8's response shape:
```
- Your deliverable begins at the header row — no preamble, no "Here is the output", no closing note, no code fence.
- Output ONLY pipe-delimited rows, one per line, with this header and nothing else, UNLESS you are specifically instructed to overload it:
```

Also in this record: the Kind definitions block still enumerates all eight kinds
(`- side —`, `- soup / salad / starch / vegetable / drink / appetizer — as named.`) for kinds that
are no longer legal. Decide keep or cut.

## 7a. [x] `plan_library/Verify Course Positions`.instruction — `6a7e6f6adff6312de744477a`

```
- {{courseListNoEntree}}
+ {{join (without (keys courseCounts) "entree") ", "}}
```

Renders `appetizer, side` instead of `3 appetizers, 3 sides`. The counts were never usable here —
STEP 2 compares a Kind cell (`appetizer`) against "that exact word on the list above", and
`3 appetizers` never matches.

Then delete `courseListNoEntree` from `compose.js:316-319`. This is its only consumer.

## 8. [ ] BLOCKED with 6a — `prompt_library/Courses status contract`.content — `6a7dea88dff6312de743c22d`

```
- ## STEP 1 — WRITE THE TABLE
- Output your COMPLETE table first, in full, and NOTHING before it.
```
"NOTHING before it" only conflicts once the thinking block exists. Removing it before 6a lands
would loosen a live constraint with nothing replacing it. Gated on 6a / item 17.

## 9. [ ] Re-measure against live Mongo

`combineK.tmp.mjs`, units day 1 / 4 / 7, N=6. Target: floor 6/6, uncovered 0/10, marker 6/6 per unit.
In-memory result was 18/18, measured with a **literal** Kind list — items 8–10 use the reference
form, so this is a confirm run, not a formality.

## 10. [ ] Create a NEW plan and run it step 3 → 4

`step.js:41-42` reads the plan **frozen into the job doc**. Re-running job
`6be54418-776d-4e74-b465-eb01c8dcfd4c` replays its captured prompts and tests none of the above.
Compose a fresh job.

## 11. [ ] `plan_library/Verify Course Positions` — `6a7e6f6adff6312de744477a`

Stacks two criteria in one checker (zero-row positions + off-list Kind). K measured 1 rule = 12/12,
6 rules = collapse. Split or measure at 2.
Also `model=""` — inherits a default rather than running on a cheaper model.

## 12. [ ] `prompt_library/Reason column mechanism` `6a7dea49dff6312de743c1ef` + `Courses reason content` `6a7dea49dff6312de743c1f0`

Both `active: true`, but `Build Courses` pass/fail never mention a Reason cell. Decide keep or
deactivate.

## 13. [ ] Shared snippet migration — 8 records, 6 subtypes

Blocked until 1–3 are `[x]`. A shared fragment can carry **static text only** — bind any variable in
the `plan_library` step and reference it by name from the fragment.

## 14. [x] `plan_library/Build Recipes`.instruction — response shape + drop the second list

DONE. Applied 2026-08-14, 5366c → 5250c. Backup
`scripts/backups/plan_library-Build_Recipes-instruction-1786743207150.json`.
Measured live after the write, N=6 per unit, days 1/4/7: marker 6/6 on all three (day 4 was 0/8
before), header 6/6, one row 6/6. **Do not re-run the patch** — a second append duplicates the
sentence.

Two edits, one patch. NOT gated on 1–4: neither introduces a thinking block.

Edit A — the affirmative response shape. The record forbids things but never states what the
response IS. Measured on the day-4 unit: marker 0/8 without it, 24/24 with it (three units, plus a
same-session unpatched control at 0/8).
```
+ Your response is two things in this order: the table, then the status block on the last line by itself.
```

Edit B — delete the cooking-method rotation, per Robert. It is a SECOND list to count and the model
never counts it: measured 0/8 correct, and it asserts without enumerating ("the 4th in the list:
baked", "…: braised" — 4 is grilled). The dish-variety sentence after it stays.

## 15. [K] `plan_library/Verify Recipes` — NEW record, one rule

The build step cannot fail its own work: PASS 6/6 on a missing pool, 6/6 on vegan+meat-only, and
3/3 on its OWN live output while serving Lamb/Beef/Turkey to vegans. A separate checker on the same
model caught all three, and passed a clean plan 3/3.

ONE rule per checker — 1 rule = 12/12, 6 rules in one prompt = collapse, 5 numbered checks in one
prompt = 3/24 with no marker in 21 runs. Rule: diet claims. Question form, subject first:
`On a STRICT <diet> diet, is <ingredient> allowed? yes/no` — 8/8, where statement forms leaked.

**SUBTYPE FIRST — a new subtype maps to ZERO fragments.** Verified: the subtypes that have any
`prompt_library` fragment are categorize, compliance, course_check, courses, inventory, menu_plan,
normalize_ingredients, normalize_product, nutrients, nutrition, planner, procurement,
protein_dietary_categorization, protein_grid, query, recipe, recipe_detail, recipes,
resolve_combined_quantities. A step on `recipe_check` gets `systemPromptFor() === ""` — no status
contract, so no marker at all. Either map the shared status fragment to the new subtype (that record
is item 15's set — coordinate) or reuse an existing subtype.

Field names, verified against the live records rather than assumed: the authored field is
`includeInOutput`, which `compose.js:420` maps to the job's `includeInResults`. `Verify Course
Positions` is authored WRONG — it sets `includeInResults: false` and has no `includeInOutput` key,
so it works only because `!!undefined === false`. Do not copy that record as a template. `failStep`
is a step NAME string (`compose.js:496-499`); `successStep` is never authored — `compose.js:506`
overwrites it linearly.

## 15a. [K] `prompt_library/Recipes system` — same defect item 9 fixes for courses

Verified present, byte-for-byte the pair item 9 deletes from `Courses system`:
```
- Your deliverable begins at the header row — no preamble, no "Here is the output", no closing note, no code fence.
- Output ONLY pipe-delimited rows, one per line, with this header and nothing else, UNLESS you are specifically instructed to overload it:
```
"nothing else" excludes the status block; only the "UNLESS…overload" escape hatch saves it. This is
the likely reason the SHARED status contract was not landing and item 16 needed a local restatement —
the shared fragment already says "First output your COMPLETE deliverable. THEN, as a SEPARATE final
line… the VERY LAST element". Two records state the same rule and one of them contradicts it.
Removing this pair may make item 16's sentence redundant; measure before deleting either.

## 16. [K] Recipes thinking block — strip is written and green locally, not gated on a deploy

Validated (protein 0/40 → 16/16, correct end-to-end through strip → table → check). The strip is
ALREADY WRITTEN: `worker/steps/outcome.js:61` defines the `THINKING` regex and both `visibleResponse`
(`:69-75`) and `splitOutcome` (`:90`) apply it, both markers required. So the stored `response` is
already clean in code — it just is not deployed. Items 1–3 should be `[x]`.

Consumers that would have seen the leak, verified: `Build Courses` (`context: ["Build Recipes"]`) and
`Build Recipe Details` (`context: ["Build Recipes","Build Courses"]`).

## 17. [K] Fragment placement — `name` + `relatesTo`, substituted at send time

**IN PROGRESS (Kim).** Files I am in: `worker/lib/assemble.js` (new), `worker/steps/step.js`,
`functions/entry/ai/compose.js` (`renderUnit` only — NOT the helpers in item 5),
`dashboard/utils/assemblePrompt.js`, `dashboard/components/prompts/*`,
`dashboard/server/api/llm/system-prompt.get.ts`. Shout if you need any of them.

Two problems this fixes. The status contract has no `name` (we call it by a nickname), and every
fragment lands in one place — the system prompt — so a rule that belongs beside Pass/Fail can only be
restated inside a step's own instruction. That restatement is what item 16 had to do, and it violates
`prompt-library.md:35` rule 5 (define the marker once, never per-subtype).

**Schema, `prompt_library`:**
- `name` — optional string. Add unconditionally; it costs nothing and the nameless record is the one
  that has caused the most confusion today.
- `relatesTo` — one of `leading` · `conditions` · `pass` · `fail` · `trailing` · *blank*. Blank means
  the system prompt, i.e. exactly today's behaviour, so all existing fragments keep working untouched.

  **A section and its marker share ONE name**: `relatesTo: "pass"` is placed at `{pass}`. No
  translation table, nothing to grep for twice — the lesson from `includeInOutput`/`includeInResults`.

**Markers.** `renderUnit` emits all five, always, whether or not a fragment claims one:
```
{leading}
<instruction>
{conditions}
Pass: <pass>
{pass}
Fail: <fail>
{fail}
{trailing}
```
An unclaimed slot is replaced with the empty string, so every step has the same shape.

**Substitution happens in the WORKER at send time, not in compose.** This is the point of the design:
fragments stay live. Today a fragment edit reaches every running job on the next call while an
instruction edit does not, because `plan[]` is frozen into the job. Assembling fragments in compose
would freeze them too and destroy "edit a prompt without a release", which is why they are in the
database at all. Robert: "Just because we 'freeze' now doesn't mean that's how we will do it
tomorrow" — the markers make the frozen half inert, so freezing stops mattering here.

**Ordering within a slot** needs no new field: `mapping[<subtype>]` is already a string sort key, so
two fragments anchored to `{pass}` order by it the same way they order in the system prompt now.

**No-marker fallback.** Plans frozen before this change contain no markers. The worker must treat
"no markers present" as "put every fragment in the system prompt". Then nothing needs backfilling and
in-flight jobs keep running.

**Also change:** `GET /api/llm/system-prompt` (the dashboard preview) must run the same substitution.
Its whole purpose is that the preview matches what the worker sends; without this it shows raw
`{pass}` tokens and silently stops matching.

**State plainly in the fragment editor:** fragments are still never Handlebars-rendered
(`worker/index.js:371-386`), so a `{pass}`-anchored fragment cannot carry `{{days}}` or any other
variable. Bind variables in the `plan_library` step and reference them by name.

Single braces are safe against Handlebars, which owns `{{ }}`. The only collision is an author
typing a literal `{pass}` in prompt text.

**UI — three components, and the ordering moves with the sections.**

Today `PromptsList.vue` groups by request type and drag-drop reorders *within* a group;
`prompts.vue:193` mints the new key with `lexBetween` against the dropped-between neighbours. One
flat ordered list per subtype. With `relatesTo` each subtype's list becomes five sub-lists.

- `PromptForm.vue` — add the `name` field and a section selector for `relatesTo`.
- `PromptsList.vue` — group by subtype THEN section. Drag within a section = new `lexBetween` key,
  as now. Drag ACROSS sections must write **two** fields: the new `relatesTo` AND a fresh key
  computed against its new neighbours. That is the only genuinely new interaction.

  The page becomes two levels of grouping instead of one:
  ```
  recipes · 4
     leading        —
     system         —  Recipes system                  ← blank = default
     pass           —  Status contract
     trailing       —
  unassigned · 2                                        ← unchanged, no ordering
  ```
  Empty sections still render their header, otherwise there is nowhere to drop a fragment you want
  to move INTO a section. Concretely: the `groups` computed (`:80`) gains the inner grouping, the
  `<h3>` (`:8`) gains sub-headers, and `onDrop(type, items, dropId)` (`:21`) becomes
  `onDrop(type, section, items, dropId)`. `unassigned` keeps today's behaviour — no key, no drag.
- `AssembledPrompt.vue` + `server/api/llm/system-prompt.get.ts` — **this is the biggest UI change,
  not a reorder.** Today neither one sees the step: `system-prompt.get.ts:15-24` filters
  `prompt_library` by `mapping[type]`, sorts by the order key and joins `content` — instruction,
  Pass and Fail appear nowhere. "Preview" currently means "the system prompt".

  With sections that is no longer previewable alone: a `{pass}`-anchored fragment has no position
  except relative to a step's Pass text. The preview has to become **type + step** — assemble the
  fragments AND the step's rendered instruction/pass/fail, interleaved exactly as the worker sends
  them. Where more than one step shares a subtype, add a step picker.

  **Acceptance test for the whole item: preview output is byte-identical to what the worker sends.**

**No links, so no cleanup on delete.** Attachment stays by SUBTYPE (`mapping`), never by id from the
step. Nothing points at a fragment, so deleting one just removes it from the assembly, and deleting a
step leaves no fragment holding a dead reference. Option 1's per-step prefix/postfix lists would have
created exactly those links and made every delete a referential-integrity problem.

**No key migration.** The sort key only has to order fragments within a section, and sections are
disjoint subsets of a list that is already ordered — so every existing `mapping[<subtype>]` value
stays valid the moment sections are introduced. Unset `relatesTo` = blank = system prompt, so the
default view is byte-identical to today's.

## 18. [ ] `dashboard/components/JobResults.vue` — show the `thinking` field

The worker now persists `thinking` on each step doc (`worker/index.js`, via `completionWrite`).
Nothing displays it — `grep -rn thinking dashboard/` returns zero hits.

Shape already exists in the file: a collapsible per unit for "prompt sent" (`:65-70`) and a `<pre>`
for the response (`:46`). Thinking is a third block, same pattern, collapsed by default.

Order per unit: prompt sent → thinking → response. The working produced the deliverable, so it reads
in the order it happened.

Empty `thinking` renders nothing — most steps have no block and must not gain an empty section.

---

## Production release — NOT needed to test

`npm run dev` runs the emulator + worker locally from source, so every item above is testable with
no deploy. These are the release steps, after the work is proven:

- [ ] `npm run deploy:workers` — `NODE_ENV=production`, GCE MIG. Carries outcome.js / admission.js /
      index.js.
- [ ] `npm run deploy:orchestrator` — `firebase deploy --only functions:orchestrator`. Carries
      compose.js. `menu.js:111` reads `plan_library` fresh per request, so in production the helpers
      must be live BEFORE any prompt references them, or a plan composed in that window renders
      `Kind is one of: .`

---

## Do not re-run — already measured

- Status-block wording: K, 8 variants, 32/32 parse. Not the problem.
- Self-check clauses in the block: K, PASS 8/8 on missing pool, 6/6 on vegan+meat pool.
- Two-list example: K, method 0/8 → 1/8, cost Day cell 8/8 → 6/8. Use `complete: N of N`.
- Food-list definitions for `side`/`appetizer`: J, rewrite and deletion both inside baseline noise.
- Coverage stopping condition: J, tripled rows, marker 0/3.
- `seed` does not reproduce. slots=1, requests serialise. Don't read 1–2 runs as signal.
