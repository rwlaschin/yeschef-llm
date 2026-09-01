# Courses under-fill and diet coverage: v18, v19 rejected

Date: 2026-08-28

## Question

The `courses` step under-fills (a position asked for 3 dishes gets 1) and leaves diets
uncovered. Can the step definition be reworded to fix both without causing a runaway?

## Controlled setup

- Harness: `.scratch/iter`, `node .scratch/iter/run.mjs <arm>`, track `courses`.
- Model `llama3.1:8b` on devbox `002` (L4, us-west4-a), `ITER_NUM_PREDICT=6000`.
- 15 runs per arm: units 1, 2, 5 × seeds 0,1,2,3,4.
- Every arm parented on `D3-live`. A rejected arm is never a parent.
- Edits target `plan_library` "Build Courses" `instruction` / `pass` / `fail` only.
  Nothing was written to Mongo.

## Result

| Arm | no_runaway | floor_met | all_diets_covered | verdict_agrees | score |
|---|---:|---:|---:|---:|---:|
| D3-live | 15/15 | 1/15 | 12/15 | 1/15 | 222 |
| D3-v18 | 12/15 | 7/15 | 12/15 | 2/15 | 209 |
| D3-v19 | 14/15 | 0/15 | 13/15 | 0/15 | 217 |
| D3-v21 | 14/15 | 3/15 | **14/15** | 2/15 | 221 |
| D3-v22 | 15/15 | 0/15 | 12/15 | 0/15 | 215 |
| D3-v23 | 14/15 | 0/15 | 11/15 | 1/15 | 215 |
| **D3-v24** | 14/15 | 1/15 | **14/15** | 0/15 | 219 |
| D3-v25 | 14/15 | 1/15 | 11/15 | 1/15 | 212 |
| D3-v27 | 15/15 | 1/15 | 11/15 | 1/15 | 218 |

`no_entree_rows`: live 15, v21 12, v22 12, v23 15, **v24 15**, v25 15, v27 12.

**KEEP v24.** It is the only arm that raised `all_diets_covered` (12 → 14) while breaking nothing
else, and it did so by DELETING 141 characters, not by adding a rule. Every arm that ADDED text
about entrées or counts made something worse; the one that REMOVED text helped.

## What each change was, and why it failed

### v18 — COVER → COUNT → TOP UP → ONE ROW PER DISH

> STEP 3 — TOP UP. While that count is below the requested number, add another different
> dish until it equals the requested number.

Fixed under-fill (floor_met 1 → 7) and is the only wording so far that moved that number.
But nothing bounded the top-up: 3 of 15 runs kept going (18, 27, 18 rows) and tripped
`no_runaway`, which live never does. The extra reasoning also leaked structure —
`no_table_inside_thinking` 13 → 11, `diets_from_list_only` 15 → 11, and one run never
closed the THINKING block.

**Keep:** the four-step COVER → COUNT → TOP UP → ONE ROW PER DISH shape, and
`standard` as a catch-all that never forces a row of its own.

### v19 — same four steps, plus a ceiling

> ...until the count EQUALS the requested number, then stop — the requested number is the
> ceiling as well as the target, and the only count that may exceed it is the one Step 1
> already needed to feed every diet.

**floor_met collapsed 7 → 0**, below even live. The model obeyed the stop and skipped the
add. Rows fell back to 6–15.

**Do not retry:** bounding the top-up with a prohibition. This is the known weakness with
negative context (same failure class as v15/v16). A ceiling stated as "stop" / "may not
exceed" / "is the ceiling" suppresses the action it is attached to.

### v21 — diet coverage only, one variable

Counts deliberately untouched (verified: the "floor FOR EACH MEALTIME" text is identical in
live and v21), so any move in `all_diets_covered` is this text alone.

> FEED EVERY DIET IN EVERY POSITION. Before you write any row for a position, walk this
> plan's diet list one diet at a time — {{join diets ", "}} — and for each one name the dish
> in that position it will eat. ... Where a diet has no dish yet, add a dish it can eat.

Best `all_diets_covered` of any arm (12 → 14), and it lifted `floor_met` 1 → 3 as a side
effect without touching the counts. But `no_entree_rows` fell 15 → 12: the walk does not say
WHICH positions, so on 3 runs the model walked the entrée position too and wrote entrée rows
that the previous step already owns. The same 3 runs carry the `diets_from_list_only` drop
15 → 13.

**Keep:** the walk-the-diet-list action. It is the only wording that has moved diet coverage.

**Fix in the next arm:** scope the walk to the non-entrée positions this step owns.

### v22 — v21's walk, scoped by naming the entrée as excluded

> The positions you write are {{...}} — do this walk for each of those, and never for the
> entrée, which the previous step already wrote.

Plus `fail` gaining "A row whose Kind is `entree`."

Failed on both counts. `no_entree_rows` did **not** improve (12/15, identical to v21), and
`all_diets_covered` fell straight back to live's 12/15. Naming the entrée twice more made it
more present in the output, not less, and the added prohibition suppressed the walk that was
the whole point — the same mechanism as v19's ceiling.

**Do not retry:** fixing entrée rows by telling the model not to write entrée rows. Two arms
(v19, v22) now show a prohibition attached to an action suppresses that action while not
preventing the thing it prohibits.

### v23 — v21's walk, scope stated positively, the word entrée never rendered

> The positions you write are appetizer, side, dessert, and the walk below applies to each
> one of those.

Verified by rendering the actual prompt: v22's segment contains "and never for the entrée",
v23's does not, and the enumeration is otherwise identical. Single variable against v22.

The prohibition really was the problem for entrée rows: **`no_entree_rows` went 12 → 15**,
a clean fix, and it confirms the v19/v22 rule from the other direction. But
`all_diets_covered` fell to 11/15 — below live. One run (unit 5 seed 3) also never closed
THINKING and reached 93 rows.

**The finding this arm isolates:** naming the positions *at all* — even as a positive
enumeration — competes with the diet walk for the model's attention and costs coverage.
v21 (walk with NO scope) is diets 14 / entrée 12; v23 (walk WITH scope) is diets 11 /
entrée 15. The scope sentence and the walk trade against each other.

## Open decision

Across five arms the two goals move in opposition and no arm beats live overall:

| | all_diets_covered | no_entree_rows | score |
|---|---:|---:|---:|
| live | 12 | 15 | 222 |
| v21 | **14** | 12 | 221 |
| v23 | 11 | **15** | 215 |

Nothing here is shippable as-is. The next arm has to get the diet walk to not compete with
position scoping — e.g. the walk placed where the positions are already established rather
than restating them, so there is one mention of the position list, not two.

### v24 — DELETE the defect explanation (KEPT)

One edit, to `prompt_library` `6a774dee46da043602885720` ("Courses system"), removing:

> Copying one is the single most common defect in this step — it puts the same coleslaw and the
> same fruit cup on all seven days of the cycle.

System prompt 11828 -> 11687 chars; user message byte-identical. `all_diets_covered` 12 -> 14,
`no_entree_rows` held at 15, `floor_met` unchanged at 1. The score dip to 219 is one runaway and
one off-list diet, single runs each.

The sentence names two concrete dishes (coleslaw, fruit cup) inside the paragraph that forbids
naming dishes — it demonstrates the defect it describes.

### v25 / v27 — the entrée pointer

The instruction pointed at the entrée table twice, and both pointers were wrong. Measured with
`scripts/prompt-build.mjs`: `PRINTED ABOVE` at char 478, the table at char 4867 — the LAST block
of the user message, under the `# Result of step 1` heading that loadStep writes.

- v25 fixed the first pointer only ("Included below"): `all_diets_covered` 12 -> 11, one run
  produced no table at all.
- v27 fixed BOTH and named the heading: `all_diets_covered` still 11, and `no_entree_rows` fell
  15 -> 12.

**A wrong explanation to not repeat:** v25's loss was attributed to the prompt "pointing both ways
at once". v27 points both ways CORRECTLY and scores the same 11, so that explanation was wrong.
What actually holds is the entrée-mention rule below.

**Do not retry:** repairing the entrée pointer by naming the entrée table more precisely. Every
arm that increases how often the entrée is mentioned lowers `no_entree_rows` — v21, v22 and v27
all land on 12.

## The tally (v32 / v33) — the mechanism that moves under-fill

Robert: "we should 'track' the number of filled dishes against the minimum and then stop when it's
done". Not one of v18's four steps — v18 counts ONCE, up front, and never re-checks while writing.

**BASELINE CHANGED HERE.** v24 was written to Mongo before these arms ran, so `D3-live` is now the
post-v24 prompt. Re-measured: score 219, floor_met 1/15, all_diets_covered 14/15, no_runaway 14/15
— which reproduces the v24 arm and confirms the DB write landed. Numbers above this section are
against the PRE-v24 live and are not comparable to these.

| Arm | floor_met | all_diets | no_runaway | no_table_inside_thinking | score |
|---|---:|---:|---:|---:|---:|
| live (post-v24) | 1/15 | 14/15 | 14/15 | 13/15 | 219 |
| D3-v32 tally, location unstated | **7/15** | 11/15 | 14/15 | 14/15 | 216 |
| **D3-v33 tally, inside THINKING** | 3/15 | 14/15 | **15/15** | 11/15 | **222** |

v32 is the second thing ever to move `floor_met` (1 -> 7), and unlike v18 it does so with NO
top-up step — the count is carried and re-read per row instead of committed once. Seven runs landed
on exactly 18 rows (3 mealtimes x 2+2+2) and unit 2 seeds 2 and 3 were 17/17, the first perfect runs
of the study.

v32's cost: the tally had no stated location, so it was written into the deliverable —
thinking_block_closed 15 -> 13, table_exists_after_thinking_close 13 -> 12,
diets_from_list_only 14 -> 10 (tally text in cells), two runs opening the table with
`--- THINKING START ---`.

v33 confines it to the THINKING block. Structure recovers and it becomes the first arm to BEAT the
standing baseline (222 vs 219, floor 3 vs 1, runaway 15 vs 14, diets tied at 14) — but half the
floor gain goes with it, and `no_table_inside_thinking` falls 13 -> 11.

**Open, and the next thing to try:** confinement costs counting accuracy. The `<position>: N of N`
line format parses as a table row, which is what `no_table_inside_thinking` 11/15 is detecting and
plausibly what suppresses the count. Keep the tally in THINKING, but as prose that cannot be read as
a row.

## v34 — INVALID ARM, EXCLUDED FROM ALL COMPARISONS

v34 was supposed to be a reorder and was not. It dropped the `1.`-`9.` numbering, changed the
lead-in from "Constraints, in order:" to "grouped by what they govern:", and added four headings.
Three structural changes rode along with the reorder, so its 214 / no_entree_rows 9 measures
nothing about ordering and must not be compared against live or against v35. Superseded by v35.

The check that let it through was too coarse — it compared sentences over 40 chars and stripped
list markers, so it reported "0 added, 0 lost" while numbering, the ordering claim and four
headings all changed. A reorder arm must be verified CRC-style: same line count, same total
character count, same set of numbers, same sorted constraint texts.

<details><summary>original (invalid) v34 record</summary>


Robert: the constraints "are not grouped, you have requirements for different aspects interleaved.
This reduces fidelity." Measured interleave in the composed prompt: FORMAT rules appear in 14
separate places, KIND/MEALTIME in 10, DIET in 9, across 16,832 chars.

Scope was ONE prompt, ONE block — the `Constraints, in order:` list in prompt_library
`6a774dee46da043602885720`. DIET was items 1, 4, 8; DISH was 2, 3, 5; COMPONENTS was 9 plus its two
unnumbered paragraphs; 6 and 7 sat between. Regrouped under four headings, every sentence
byte-identical (verified: 0 lost, 0 added). The example was NOT touched — it must show real
examples or it does not work.

| check | live (post-v24) | v34 |
|---|---:|---:|
| no_entree_rows | 15/15 | **9/15** |
| no_table_inside_thinking | 13/15 | 10/15 |
| all_diets_covered | 14/15 | 12/15 |
| floor_met | 1/15 | 2/15 |
| no_runaway | 14/15 | 15/15 |
| score | 219 | **214** |

`no_entree_rows` 15 -> 9 is the worst result of the study on that check.

**Unconfirmed reading:** grouping gathered the entrée references. AFFINITY ("each dish is chosen to
go WITH its entrée... the entrée is different on every day") landed under a heading named CHOOSING
THE DISH, concentrating entrée mentions the way v21, v22 and v27 did — all of which also landed on
12 or below. This is a hypothesis, not a measurement; two prior explanations offered in this study
(v25's "points both ways") turned out wrong when tested.

**Not yet tried:** a regroup that keeps the AFFINITY sentence away from the other entrée mentions.

</details>

## v35 — REORDER ONLY (valid arm)

Same lead-in, same nine `N. ` lines, same texts, byte for byte — only which number each constraint
sits on. Verified CRC-style: line count 25 -> 25, total chars 3715 -> 3715, numbers [1-9] -> [1-9],
sorted constraint texts sha `3e3ba0df5178` identical, no headings.

Order: diets 1-3 (DIET, REUSE, SAFETY CLAIM), dish 4-6 (EVERY ROW, STANDARD PREPARATIONS,
AFFINITY), scope 7-8 (RESTRAINT, AVAILABILITY), components 9.

| check | live (post-v24) | v35 |
|---|---:|---:|
| all_diets_covered | 14/15 | **15/15** |
| diets_from_list_only | 14/15 | **15/15** |
| no_runaway | 14/15 | **15/15** |
| no_entree_rows | 15/15 | **12/15** |
| floor_met | 1/15 | 1/15 |
| score | 219 | **220** |

**Pure reordering changes behaviour** — nothing was added, removed or reworded. Grouping the three
diet constraints contiguously produced the first perfect diet coverage of the study, and
`diets_from_list_only` maxed with it. Cost: 3 runs of `no_entree_rows`.

Attribution is OPEN. Nine constraints moved at once. Only three mention `entrée` at all — DIET (1
mention), AFFINITY (3), COMPONENTS (1) — and of those only AFFINITY moved, by one position (5->6).
The larger structural move is SAFETY CLAIM 8->3, the longest constraint at 398 chars promoted five
places. Arms A and B isolate these.

## Rules earned here

0. **Deletion beats addition in this prompt.** Eight arms: every one that ADDED text about entrées
   or counts made something worse; the only one that DELETED text (v24) is the only keeper. Try
   removing before writing.
1. Never parent a new arm on a rejected one. `D3-v19`'s parent is `D3-live`, not `D3-v18`.
2. Bounds must be stated as an action to take, never as a prohibition.
3. `floor_met` is the metric this work exists to move. An arm that improves score while
   dropping `floor_met` is a regression, not progress.
4. The live `fail` text only names "a course position left with no row at all", so one row
   where three were requested passes the model's own check. That is why
   `verdict_agrees_with_truth` is 1/15 on live. Any real fix has to name the count in `fail`.
5. The production runaway (job `0f0adcb6`, 120 rows / 27 distinct dishes) does NOT reproduce
   at units 1, 2, 5 — live scored 15/15 `no_runaway`. Do not claim the runaway is fixed or
   reproduced from these units.

6. **A literal value written into an example comes back as an answer.** v40 rewrote the worked
   example's THINKING with named dishes; the model returned those dishes as its own rows and
   reproduced the example's speaker order (chef B survived 8 of 8, because B survived in all three
   worked steps). The `usda_food_pick` work hit the same thing independently: a literal
   `{"fdcId": "170567"}` in the output-format block came back as the answer 12 times in one run, and
   replacing it with a placeholder dropped protocol failures 12 -> 2. Examples teach values, not
   just shape. Real examples are fine and are what makes an example work — but each one has to be
   MARKED as an example where it sits ("Example Given: ..."), not covered by a rule further up the
   prompt. The current prompt declares "forbidden as answers" once, ~40 lines above the dishes, and
   the model reads the dishes as data by the time it gets there.
7. **No diet name belongs in instruction text.** The diet list is per-plan and varies. v40 hardcoded
   seven, and its worked example reasoned over diets the example's own header said it did not have.
8. **Single-run comparisons are noise.** `usda_food_pick` measured ~19% run-to-run variance on an
   unchanged prompt — 37 of 193 answers differed between two identical runs. Here, D3-v35 scored 220
   sequential and 210 at 3 concurrent slots with nothing changed. Every version-to-version gap in
   the table above that is smaller than that band is unproven, including v39's rejection (v38 93% vs
   v39 83% on `all_diets_covered`, one run each). Run the parent twice before trusting a comparison.

## Versions run since (v39, v40)

- **v39** — deleted the three worked exclusions from constraint 3 ("meat/poultry/seafood ... never
  vegetarian or vegan" etc.) on the theory that the model already holds the domain. n=18.
  `all_diets_covered` 15/18, `diets_from_list_only` 13/18, `floor_met` 0/18, one runaway. Read as
  worse than v38, but see rule 8 — that read is not established.
- **v40** — three adversarial chefs, tree-of-thought per position, in the THINKING block. n=18.
  Fixed everything structural: 18/18 on thinking-block, table-placement, header and column checks,
  0 runaways, 18/18 `diets_from_list_only`. Broke coverage: `all_diets_covered` 7/18,
  `no_entree_rows` 11/18. Rejected. Defects were in the text I wrote, not the idea — see rules 6
  and 7.
- **v41** — same three-chef structure, no diet named in the instruction, balanced speaker wins.
  Reviewed BEFORE running (`.scratch/iter/export-prompt.mjs` + a reviewer agent) and held back: its
  worked example still knocked dishes out for dairy when the example's only two diets both allow
  dairy, and its conclusions named dishes the example's own table does not contain. Never run.

## Not yet tried

- v20: commit to the count in writing (`<position>: N dishes`), then match the row count to
  the committed N — a bound expressed as an action rather than a prohibition. Registered in
  `defs.mjs`, arm stopped before any run landed. No data.
