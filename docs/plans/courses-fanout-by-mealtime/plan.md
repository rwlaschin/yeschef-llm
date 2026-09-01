---
modified: 2026-08-29
dependencies: [design/llm-pipeline.md, design/plan-orchestration.md]
supersedes: null
---

# Build Courses writes one dish per kind; a group-by-day reduce builds the choice

## Problem

`Build Courses` is asked to do two jobs at once and does neither well.

Job one: pick an accompaniment that suits this diet and this entree. Job two: make sure each position
offers the diner a choice of two, and that every diet has something it can eat at every position.

The second job is not answerable inside a single call. The step fans out one unit per `(diet, day)` —
measured on the real composed plan, `2:courses/fanout x63`, unit 0 `{"diet":"standard","day":1}` — and
those 63 calls cannot see each other. A unit asked to guarantee coverage across diets is being asked
about eight tables it will never see.

The consequences, all measured:

- The floor ("2 appetizer, 2 side, 2 dessert at EACH mealtime") is met in 0-20% of runs across every
  prompt version tried (v18 through v43). It is the check the study existed to move and nothing moved
  it.
- The most-missed cell is `breakfast/appetizer: got=0` — the floor asks for two appetizer courses at
  breakfast, which the model declines to write.
- Runs that do hit 18 rows do it by writing the same six dishes at lunch and again at dinner, verbatim.
  Structurally green, useless to a kitchen.
- `all_diets_covered` required all nine diets in one unit's table. Fourteen versions were scored
  against a target the unit shape makes impossible.

## Solution

Split the two jobs across two passes.

**Pass one (this step, unchanged fan-out).** Each `(diet, day)` unit writes ONE dish per kind per
mealtime — one appetizer, one side, one dessert — for its own diet. It lists in the Diets cell every
diet on the plan's list that the dish would ALSO satisfy. That listing is best effort: it is what makes
the reduce's job smaller, not a safety guarantee, and nothing downstream may treat it as one. No floor,
no second choice, no cross-diet coverage. The call is asked only what it can answer from what it sees.

**Pass two (new, a group-by-day reduce).** Groups every course row by day, across all diets, dedupes,
and builds the diner's choice: where a kind has fewer than the required number of distinct dishes at a
mealtime, or a diet is left unsatisfied there, it generates what is missing. This pass sees the whole
day at once, which is the information the choice requires and no pass-one unit has.

## Scope

### Prompt (change — `plan_library` "Build Courses".instruction)
- The count sentence becomes one dish per kind per mealtime, not `2 appetizer, 2 side, 2 dessert`.
- Delete "One row in a position is a shortfall, not a choice" — under the new split one row IS the
  answer.
- Delete "Add a further row to one mealtime's position only when a diet on this plan's diet list can
  eat nothing already written at that mealtime" — that is the reduce's job, and this sentence is the
  source of the cross-diet reasoning a single unit cannot do.
- Keep the per-diet opening sentence. `for the {{slot.diet}} diet` is correct for this step: the
  fan-out is per diet and this pass genuinely answers for one diet.
- The Diets cell keeps listing every diet the dish would satisfy, and stops being written as a safety
  claim. Constraint 3's "An omitted diet costs a serving; a false one harms a resident" is already cut;
  the "SAFETY CLAIM, NOT A COURTESY" heading goes with it. The reduce re-derives what it needs.

### Entree context (change — drop it)
The entree is passed into this step so accompaniments can be chosen against it. It is also what makes
every day's output look alike: the same entree text arrives on every unit of a day and the model
anchors on it. Drop the entree from this step's context. Pass one chooses for the diet and the
mealtime; matching a dish to its entree, if it is still wanted, belongs to the reduce, which sees both.

### Merge pass (new)
- Input: every `(diet, day)` courses response for one day.
- Dedupe on the existing key `diet|day|mealtime|kind|name`
  (`yeschef/src/components/pages/recipeShared.ts:645`, `missingSlotInputs`).
- Fill to the required count per `(day, mealtime, kind)`, and ensure every diet on the plan's list has
  at least one dish it can eat at each position.
- The fill GENERATES. It cannot select from what pass one already wrote: nothing in those rows says
  whether a dish is safe for a diet that did not propose it. A standard-diet row does not carry a
  renal judgement, and reading one off it would be inventing a safety claim nobody made. So the merge
  is an LLM call that sees the day's existing dishes and writes the missing ones.
- What the merge is shown: the dishes already placed at that `(day, mealtime, kind)`, the plan's diet
  list, and which diets are still unfed there. What it returns: only the new dishes, each with the
  diets it feeds and its Components — same row shape as pass one.

### Harness (`.scratch/iter`) — done
- `all_diets_covered` replaced by `serves_own_diet` (`score.mjs`), fed the unit's own diet from
  `run.mjs`. Re-scored against stored runs: v38 93%, v41 94%, v42 100%.
- `floor_met` replaced by `one_per_kind`: exactly one row per kind per mealtime, short or extra both
  fail. The old floor was never met above 20% in any version and was never this step's job.
- `no_runaway` stays a hard check. A run that never closes its THINKING block produces nothing for the
  reduce to group, so it is a total loss, not a degraded answer.
- Measures for pass one: `no_runaway`, `one_per_kind`, `serves_own_diet`, `no_entree_rows`,
  `diets_from_list_only`, `components_categorized`.
- The Diets cell is best effort and is NOT scored for completeness. `serves_own_diet` checks only that
  the call's own diet is on every row it wrote.

## Parallel / Dependent Breakdown

- **A (independent)** — prompt change: one dish per position, delete the two cross-diet sentences.
- **B (independent)** — harness: retire `floor_met` for this step, keep the pass-one measures.
- **C (depends on A)** — merge pass: the gap calculation (what is short, which diets are unfed) in
  plain code, no model involved.
- **D (depends on C)** — the merge's generation call: prompt, fan-out grain, and its own tests.

## Success Criteria

- A pass-one response writes exactly one appetizer, one side and one dessert per mealtime for its own
  diet, and every row's Diets cell contains that diet.
- No pass-one response fails to close its THINKING block or hits the token cap.
- After the reduce, each `(day, mealtime, kind)` offers the required number of distinct dishes, and
  every diet on the plan has at least one dish it is satisfied by at each position.
- No dish is written twice at the same mealtime, and no day's dishes are a verbatim copy of another
  day's.
- Every diet claim surviving into the final plan was made by a call that had the dish's Components in
  front of it — a best-effort label from pass one is never the last word on safety.

## Use Cases

1. **Standard diet, Tuesday.** Pass one writes 3 rows per mealtime, 9 for the day, all chosen against
   Tuesday's entrees. It is never asked what the renal table looks like.
2. **Renal, vegetable-heavy day.** Pass one writes the best renal-safe dish it can for each position.
   If that is thin, the merge pass sees it against the other eight diets' output and fills the gap.
3. **Choice of two at lunch.** Nine diets each proposed a lunch side and after dedupe four distinct
   dishes remain — but each carries only the diets its own author vouched for. The merge cannot read a
   renal verdict off a dish the standard unit wrote, so it generates what is missing rather than
   re-labelling what is there.
4. **Breakfast appetizer.** Pass one writes one, or the model declines. The merge pass decides whether
   a breakfast appetizer course is required at all — a policy question, answered once, not re-litigated
   in 63 independent calls.

## Testing Requirements

- Harness: a pass-one version measured over unseeded trials on a devbox against the stored per-version
  baselines in `docs/incidents/2026-08-28-courses-underfill-v18-v19.md`, on `serves_own_diet`,
  `no_entree_rows`, `no_runaway` and `diets_from_list_only`. `floor_met` is expected to read 0 and is
  no longer a failure.
- Unit: pass-one output for a `(diet, day)` unit parses to exactly 3 rows per mealtime.
- Unit: the merge dedupes on `diet|day|mealtime|kind|name` and fills a position that is short.
- Unit: the merge leaves no diet without an edible dish at any position.
- Regression: a full 7-day 9-diet plan through both passes yields at least as many distinct dishes per
  `(day, mealtime, kind)` as the current single-pass pipeline does after dedupe.
