---
modified: 2026-08-12
priority: p2
dependencies: [design/prompt-library.md, design/plan-orchestration.md, design/llm-pipeline.md]
supersedes: null
---

# Protein categorization — one verb, branched by the model

## Problem

The `protein_dietary_categorization` prompt states its task three incompatible ways: the system half opens "You build the PROTEIN–DIET TABLE … one row per protein" (classify a supplied set), the step instruction opens "Propose the RAW PROTEINS this kitchen should rotate through" (generate a set), and the instruction's `{{#if proteinWeights}}` branch then says "do NOT propose your own. Use EXACTLY these". Its Pass criteria assert "Between 12 and 20 rows" and "named as the bare ingredient with no cut", both of which contradict the `Protein table format` partial's `Protein | Cut | Diets | Why` contract. Under contradiction the model copies the prompt's worked example: run `66838d82` returned 11 rows of which 5 were lifted verbatim from the example, emitted `vegetarian` and `renal` for a plan whose diets are `standard, diabetic, low-sodium`, echoed the rendered `{{proteinLines}}` block back as output rows, and self-graded `@@::PASS::@@`.

## Solution

Move the propose-vs-classify branch out of Handlebars and into a single LLM conditional stated once in the `prompt_library` child prompts; reduce the `plan_library` instruction to supplying data blocks only, always emitting the supplied-proteins section (with an explicit "none supplied" when empty) so the model's branch condition is unambiguous; and remove every row-count and cut-naming assertion from `pass`/`fail` that restates the branch or contradicts the format partial.

## Scope

### Why the branch cannot live in Handlebars

`systemPromptFor` (`worker/index.js:371-386`) joins `prompt_library.content` raw — `.map((p) => p.content).join("\n\n")`, no template compile, no context. A `{{#if}}` in a child prompt reaches the model as literal text. Only `plan_library`'s `instruction`/`pass`/`fail` are rendered, at `functions/entry/ai/compose.js:465`. The branch condition is a property of per-job data; the rule for each branch is invariant craft. The rule therefore belongs in a child prompt as an LLM conditional, and Handlebars is used only to include or omit DATA.

### Current composition (verified)

| Surface | Doc | Order key | Chars |
|---|---|---|---|
| `prompt_library` | `Protein Dietary Categorization system` | `a` | 784 |
| `prompt_library` | `Protein table format` | `c` | 2368 |
| `prompt_library` | shared status block, `_id 6a28a5a25b0a853a539963d2` | `m` | 1302 |
| `plan_library` | `instruction` | — | 1091 |
| `plan_library` | `pass` | — | 449 |
| `plan_library` | `fail` | — | 469 |

Step doc: `subtype: protein_dietary_categorization`, `kind: aggregation`, `inputs: ["diets"]`, `model: llama3_1_8b_v1`, `style: structured`.

### `prompt_library` — `Protein Dietary Categorization system` (key `a`)

- Replace the opening verb claim with a statement of the DELIVERABLE, not the method: the step produces the protein–diet table this plan's cycle will rotate through, one row per protein and cut.
- State the branch ONCE, as an LLM conditional the model evaluates against the data it is given:
  - a supplied protein list present → classify exactly those, adding a protein ONLY where a diet would otherwise have none;
  - no supplied list → propose a set spanning meat, poultry, seafood, egg, dairy and plant sources, then classify those by the same rules.
- Keep constraint 1 (DIET) verbatim.
- Rewrite constraint 2 (COVERAGE) so it holds in both branches: every diet ends with at least one suitable protein; in the supplied branch, additions are limited to that purpose.
- Carry no row count. Carry no cut-naming prohibition.

### `prompt_library` — `Protein table format` (key `c`)

- Unchanged contract: `Protein | Cut | Diets | Why`, blank Cut where none is meaningful, `Begin Example`/`End Example`, the no-leak clause, the expansive-domain closing paragraph.
- Add nothing about proposing or classifying — this partial owns the output shape only.

### `plan_library` step — `instruction`

- Remove "Propose the RAW PROTEINS…" and "Propose 12 to 20 distinct proteins…" — the verb and the count both move out.
- Emit the diets, cost tier (guarded), region (guarded), and added proteins (guarded) as today.
- ALWAYS emit the supplied-proteins section. When `proteinWeights` is empty, emit an explicit literal stating no proteins were supplied, rather than omitting the block. A silently absent block is not a readable branch condition.
- Remove the "do NOT propose your own. Use EXACTLY these" sentence — the rule now lives in the child prompt; the instruction supplies only the list.

### `plan_library` step — `pass` / `fail`

- Remove "Between 12 and 20 rows" and "Fewer than 12 or more than 20 rows" — a row count restates the branch.
- Remove "named as the bare ingredient with no cut, form, preparation or dish word" and the corresponding `fail` clause "a name carrying a cut" — both contradict the format partial's Cut column.
- Retain, restated against the four-column contract: every row distinct on protein+cut; non-empty Why naming the rule that decided it; Diets drawn only from the plan's diets; every plan diet served by at least one row; output is the pipe-delimited rows with no prose; every chef-added protein present.
- Add a criterion that no row may be copied from the example.

### Decision to confirm at sign-off

When a protein list IS supplied, the model may add a protein ONLY to cover a diet that would otherwise have none. This plan is written to that rule; it is the single line that changes if the answer is "never add".

## Use Cases

### 1. Chef arranges proteins on the setup page, then builds

- **Goal** — the categorization step classifies exactly the chef's arranged proteins and adds nothing except to cover an unserved diet.
- **Stakeholders** — chefs (their curation must survive), RDNs (diet claims must be safe), Alimenta.
- **Actors** — chef, `CreatePlanPage`, `/ai/menu`, the `llama3_1_8b_v1` worker.
- **Preconditions** — `meal_plans.proteinWeights` is non-empty; the plan's `values.diets` is non-empty.
- **Postconditions** — every supplied protein appears as a row; no proposed protein appears unless a diet had none; every Diets value is drawn from the plan's diets.
- **Basic Course of Events (BCE)** —
  1. Chef weights proteins; `CreatePlanPage.tsx:943` sends `{ protein, cut, diets, weight }` rows.
  2. `functions/entry/ai/menu.js:155` destructures `proteinWeights`; `compose.js:323` puts it in the render context.
  3. The instruction renders the supplied-proteins section via `{{proteinLines proteinWeights}}`.
  4. The worker joins the three `prompt_library` docs (`worker/index.js:371-386`) and dispatches.
  5. The model reads a non-empty supplied list and takes the classify branch.
  6. `CreatePlanPage.tsx:880-892` parses `Protein`/`Cut`/`Diets` back into rows.
- **Alternate Flows** —
  - A1 (chef also typed proteins by hand): `addedProteins` renders in its own block; every one appears in the output.
- **Exceptions** —
  - E1 (a supplied protein suits no diet): it is still emitted, with a Why naming what excluded each diet. It is never dropped.
  - E2 (a plan diet is served by no supplied protein): the model adds exactly enough to cover it, and each addition's Why says so.

### 2. Plan built with no arranged proteins

- **Goal** — the step proposes a rotation and classifies it, without a row count dictating the answer.
- **Stakeholders** — chefs starting from nothing.
- **Actors** — as above.
- **Preconditions** — `proteinWeights` is absent or empty.
- **Postconditions** — the output spans meat, poultry, seafood, egg, dairy and plant sources; every plan diet is served by at least one row.
- **Basic Course of Events (BCE)** —
  1. The instruction renders the supplied-proteins section carrying the explicit "none supplied" literal.
  2. The model reads it and takes the propose branch.
  3. It proposes, then classifies by the same DIET and COVERAGE rules.
- **Exceptions** —
  - E1 (a diet admits very few proteins, e.g. vegan): coverage is still met; breadth yields to the DIET constraint.

## Target Design Docs

- **`docs/design/prompt-library.md`** — record that `prompt_library` content is never Handlebars-rendered (`worker/index.js:371-386`), that per-job conditionals therefore belong in `plan_library`'s rendered fields, and that a branch whose rule is invariant is expressed as an LLM conditional in the child prompt while the plan supplies only data.
- **`docs/design/plan-orchestration.md`** — record the division: `plan_library` `instruction`/`pass`/`fail` carry the job's DATA and are Handlebars-rendered at `compose.js:465`; `prompt_library` carries the standing craft and is joined raw.

## Testing Requirements

Existing tests are classified **Untouched**, **Deprecated**, or **New**. No existing test's assertions are edited.

- **Untouched — `functions/entry/ai/compose.test.js`** — covers rendering and helper behavior, not prompt wording. It is the regression oracle for the instruction edits: if `{{proteinLines}}`, the guards, and the Pass/Fail concatenation still render, it passes unedited.
- **New unit — assembled-prompt contradiction guard** — against live `prompt_library` + `plan_library` for `protein_dietary_categorization`, assert the composed text contains no row-count assertion, no cut-naming prohibition, and exactly one statement of the branch. This is the test that would have caught the current defect without an LLM call.
- **New unit — instruction renders the supplied-proteins section in BOTH states** — with a non-empty `proteinWeights` the rendered instruction contains the protein lines; with an empty array it contains the explicit "none supplied" literal and no dangling heading. Covers Use Case 1 step 3 and Use Case 2 step 1.
- **New integration (real model, `llama3_1_8b_v1` on the baremetal subscription)** — one build per branch:
  - supplied branch: every supplied protein appears; no row's Diets value falls outside the plan's diets; no row is copied from the example; output parses as four pipe-delimited columns.
  - propose branch: every plan diet appears in at least one row; the output spans at least four of the six source categories.
  Both assert the status block is present and that a `FAIL` is returned when a criterion is unmet — run `66838d82` self-graded PASS against four unmet criteria, so a passing self-grade on a bad answer is itself a failure.
- **Untouched — `worker/log-severity.test.js`, `worker/cannedResponses.test.js`** — unrelated; they must stay green (suite baseline 368/368/0/0).

## Parallel / Dependent Breakdown

- **Step 1 (no dependencies):** back up `prompt_library` and `plan_library` to `scripts/backups/`.
- **Step 2 (parallel with 3):** rewrite `Protein Dietary Categorization system` (key `a`) — deliverable-first opening, the single LLM conditional, DIET verbatim, COVERAGE valid in both branches.
- **Step 3 (parallel with 2):** rewrite the step's `instruction` (verb and count out, supplied-proteins section always emitted) and `pass`/`fail` (row count and cut prohibition out, criteria restated against the four-column contract, example-copy criterion added).
- **Step 4 (dependent on 2, 3):** write the two new unit tests.
- **Step 5 (dependent on 4):** run both integration builds against baremetal; capture the composed prompt and the output for each branch.
- **Step 6 (dependent on 5):** design docs — `prompt-library.md`, `plan-orchestration.md`.

## Success Criteria

- The composed prompt for `protein_dietary_categorization` states the task exactly once; a grep of the assembled text finds no row-count assertion and no cut-naming prohibition.
- `Protein Dietary Categorization system` and the step `instruction` no longer disagree on the verb: neither contains an unconditional "propose" or an unconditional "classify".
- The rendered instruction contains a supplied-proteins section in both states — the protein lines when `proteinWeights` is non-empty, an explicit "none supplied" literal when it is empty.
- A real build with `proteinWeights` set returns every supplied protein, adds a protein only where a diet would otherwise have none, and emits no Diets value outside the plan's diets.
- A real build with no `proteinWeights` covers every plan diet and spans at least four source categories.
- No row in either build's output matches a row of the example in `Protein table format`.
- Both builds' output parses into four pipe-delimited columns and round-trips through `CreatePlanPage.tsx:880-892` into `{ type, cut, diets, weight }` rows.
- `npm test` in `yeschef-llm` reports 0 fail and 0 skipped.
