# Recipes prompt — rewrite for review

Not applied. Nothing in Mongo has been changed. (One edit was made to `Build Recipes.fail` during
this session and reverted; the record is byte-identical to
`scripts/backups/build-recipes-1786725356215.json`, `.fail` 389c, `.instruction` 5511c.)

Current assembly: 6 sources · 11,569 bytes · 2,019 words · 83 negations · 0 worked examples.
Proposed: same 6 sources, `.instruction` cut from 955w to ~380w, 1 worked example, one voice.

---

## Measured baseline (what "doesn't build correctly" actually is)

`llama3.1:8b`, local Ollama, temp 0.2, N=5, unit `{diet: standard, day: 1}`, 1 mealtime,
12-protein pool fed as `proteinWeights`. Live prompt, unmodified:

| run | header line | Day cell | rows | status marker |
|---|---|---|---|---|
| 1 | yes | `1` | 1 | PASS |
| 2 | yes | `1` | 1 | PASS |
| 3 | **no** | **`Day 1`** | 1 | PASS |
| 4 | yes | `1` | 1 | PASS |
| 5 | yes | `1` | 1 | **MISSING** |

**header 4/5 · Day as bare number 4/5 · one row 5/5 · marker 4/5. Three of five runs are fully clean.**
The row-count enumeration is not reproducing — the `{{#if (gt (count meals) 1)}}` wrap is holding.
What remains: the header line is dropped, the Day cell is written as the string `Day 1`, and the
status block is occasionally omitted. A consumer keying on Day will not match `Day 1`.

**The harness that measured this differently is wrong, and that is a real bug.**
`scripts/prompt-lab.mjs:78` feeds `proteinChoices`; `Build Recipes.instruction` reads
`{{proteinLines proteinWeights}}`. `baseContext` is a closed allow-list, so through prompt-lab the
recipes pool renders **empty**, the prompt falls into its own "the protein pool is missing — FAIL"
branch, and every recipes number taken through that harness describes a prompt nobody ships.
Fix is one word in the FORM. Until it is fixed, recipes measurements from prompt-lab are void.

---

## The defects, each traced to a source

| defect | where | evidence |
|---|---|---|
| Day cell written as `Day 1` | nothing states the Day cell's form anywhere in the 6 sources | 1/5 above |
| header line dropped | stated in source 1, contradicted by source 1's own "UNLESS you are specifically instructed to overload it" | 1/5 above |
| status block dropped | source 3 states it; it is 1,302c from the end of the prompt | 1/5 above |
| set-difference protein pick | `.instruction`: "STRIKE OUT every entry not allowed on the {{slot.diet}} diet" | the negated-exclusion form measured 0/4 in `prompt-library.md`; per-item lookup measured 4/4 |
| build step audits itself | `.instruction`: "name the numbered entry you are using … so the count is visible and can be checked" | in-prompt self-audit measured 0/3 (`prompt-library.md`, rule 3 and rule 14's coda) |
| pool renders in two shapes | `{{proteinLines}}` → `Chicken (30) — standard, diabetic`; `{{#each addedProteins}}` → `- Tofu`, no weight, no diets, in a list the prompt says states allowed diets per entry | rendered output |
| missing-pool guard always prints | "If no pool is printed above this line…" is unguarded prose; with no pool the prompt renders two blank lines then that paragraph | rendered output |
| diet meanings hardcoded | sources 1 and 4 both enumerate `vegan = …; vegetarian = …` | `diets` is free text; there is no diet table. A hardcoded list is incomplete by construction and the model has emitted a diet that was never on the plan |
| no worked example | none of the 6 sources contains one | the marker-terminated example is what took the status block 0/n → 8/8 on the checker step |

## Sources 1 and 4 restate each other seven times

| # | source | size |
|---|---|---|
| 1 | `prompt_library` / Recipes system `[a]` | 2,669c |
| 2 | `prompt_library` / Decision rationale clause `[f]` | 1,288c |
| 3 | `prompt_library` / status contract `[m]` | 1,302c |
| 4 | `plan_library` / Build Recipes `.instruction` | 5,511c |
| 5 | `plan_library` / Build Recipes `.pass` | 410c |
| 6 | `plan_library` / Build Recipes `.fail` | 389c |

| rule | stated in |
|---|---|
| `Kind` is `entree` | **3 sources** — 4, 5, 6 |
| `Ingredient:category` form | 2 — 1, 4 |
| bare ingredient in Protein/Starch/Vegetable/Fruit | 2 — 1, 4 |
| a diet claim is a safety claim | 2 — 1, 4 |
| diet meanings (`vegan = no animal products`, …) | 2 — 1, 4 |
| Components excludes the dishes plated beside it | 2 — 1, 4 |
| the cycle decides, not taste | 2 — 1, 4 |
| header line | 2 — 1, 5 |
| output only pipe rows, no prose | 2 — 1, 5 |
| never write the same dish twice | 2 — 4, 6 |

Ownership for the rewrite — each fact in exactly one source:

| source | owns |
|---|---|
| 1 Recipes system | the role, and what a reduced recipe is. Nothing about columns. |
| 2 Why block | the `Why:` block only |
| 3 status contract | the status block only |
| 4 `.instruction` | this call's INPUTS, the protein pick, COLUMNS, RULES, the example |
| 5 `.pass` / 6 `.fail` | the checks, and the tail demands |

---

## Decisions I need from you

**1. The fan-out contradiction — I did not touch it.** `mapOf: dietDays as |slot|` fans one unit per
(diet, day): `{standard,1} {standard,2} {diabetic,1} {diabetic,2}`. Each unit's text says both
"ONE CALL COVERS EVERY DIET: standard, diabetic" and "for the standard diet", and `.pass` demands
every diet appear in some row. The design-dot session raised this and you closed it — "the
duplication is not a problem. DROP IT!!!" — so the proposed text below leaves the fan-out and both
sentences exactly as they are. Say the word if you want it reopened; otherwise it stays.

**2. Precomputing the protein.** `compose.js` already has `{{proteinBackbone proteins slot.diet slot.day}}`,
which hands the model this day's protein directly and deletes the counting entirely. That is a code
change, and your standing framing is "it's a prompt tuning job" — so the proposal below keeps the
arithmetic in the prompt and only changes its *operation* (per-item lookup, not strike-out). Say if
you want the precompute instead; it removes a whole class of defect.

**3. Diet meanings.** The proposal deletes the hardcoded `vegan = …` list from `.instruction` and
keeps only the general form: claim a diet when every ingredient in Components is allowed on it.
Source 1 keeps its own copy or loses it too — your call, but not both.

---

## Proposed `.instruction`

**An input is stated once, in INPUTS, and referred to by its label after that.** The current
`.instruction` interpolates `{{slot.day}}` nine times, `{{join meals}}` three times and
`{{slot.diet}}` three times; a value repeated is a value that can disagree with itself, and it is
most of the word count. Below, every rule points back at a label — `Day`, `Diet`, `Mealtimes` — and
the value appears exactly once.

Handlebars stays where it is load-bearing. **The `{{#if (gt (count meals) 1)}}` wrap stays** — it is
what stopped the 7-row enumeration.

```
# INPUTS
Day:                {{slot.day}} of {{days}}
Mealtimes:          {{join meals ", "}}
Diet:               {{slot.diet}}
Diets on this plan: {{join diets ", "}}
{{#if costTier}}Cost tier:          {{costTier}}
{{/if}}{{#if region}}Region:             {{region}}
{{/if}}{{#if proteinWeights}}Protein pool, in rotation order, most-served first. Each entry names the diets it is allowed on:
{{proteinLines proteinWeights}}
{{/if}}
# TASK
Write the entrée for each mealtime above, on the listed input day.

# PICK THE PROTEIN
An entry is usable when its own line names the Diet.
Count usable entries down the pool from the top. The one whose count equals Day is the protein for
the first mealtime{{#if (gt (count meals) 1)}}; each later mealtime takes the next usable entry below it, one per mealtime, and you stop when every listed mealtime has one{{else}} — there is one mealtime, so you take one entry and stop{{/if}}. Wrap to the top past the end.
Cooking method: count Day down this list, wrapping past the end — roasted, braised, baked, grilled,
stewed, poached, stir-fried.
Name the entry you landed on for each mealtime in the Why block.

# COLUMNS
Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit | Kind | Diets | Components

Day          Day, as a bare number: `7`.
Mealtime     One mealtime, copied from Mealtimes.
Dish         `<method> <protein> with <starch>` — the name a kitchen prints on a menu.
Protein      One bare ingredient name.
Starch, Vegetable, Fruit
             Empty. Those positions are dishes of their own, written by another step.
Kind         entree
Diets        Comma-separated, from `Diets on this plan`. Claim a diet when every ingredient in
             Components is allowed on it. An omitted diet costs a serving; a false one harms a resident.
Components   `Ingredient:category; Ingredient:category` over protein, starch, vegetable, fruit,
             beverage, dairy, fat, seasoning. Only what is cooked into this dish.

# RULES
* Every row is Day.
* One dish exists once, on one row, naming every diet it feeds.
* A protein that comes round twice in the cycle arrives under a different method and a different name.

--- EXAMPLE START — NEVER include or reproduce any part of this in your response ---
Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit | Kind | Diets | Components
4 | dinner | Stewed lamb with couscous | Lamb |  |  |  | entree | standard, diabetic | Lamb:protein; Couscous:starch; Cumin:seasoning
--- EXAMPLE END — NEVER include or reproduce any part of this in your response ---
```

**The example stops at the row. It never shows a status block.** A demonstrated `@@::PASS::@@` is a
demonstrated verdict, and the model copies the verdict instead of running the procedure — measured on
courses: PASS in 8/8 runs while 8/8 had real defects, FAIL never once emitted. The status block is
specified, never demonstrated. (An earlier version of this file ended the example in `@@::PASS::@@`
and showed a `Why:` block; both are gone — the Why block no longer exists in the database.)

The row itself is concrete — a real dish a kitchen would print — and distinct from any other step's
example, so a leak is traceable to this prompt. It shows the Starch, Vegetable and Fruit cells empty
while a starch appears in Components, the Day cell as a bare number, `entree` written literally, two
diets named on one row, and `Ingredient:category` used in Components alone.

The pick is a **per-item lookup** — "does this entry's line name the Diet" — asked once per entry,
never "strike out the ones that are not allowed". It produces no output of its own: the entry landed
on is recorded in the `Why:` block, which source 2 already owns and which is not part of the
deliverable. **An earlier draft of this file had the model write an ALLOWED/NOT ALLOWED line per pool
entry before the table. That was wrong** — twelve lines would precede the header, contradicting both
the header demand below and deliverable-first.

## Proposed `.fail` — tail demands only, appended, nothing removed

The last bytes of the prompt are the strongest position in this engine (`compose.js:547` renders
`instruction` → `Pass:` → `Fail:`), so the three things that get dropped go there:

```
Your first line is this header, copied exactly:
Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit | Kind | Diets | Components
The Day cell holds Day as a bare number, alone.
Your last line is the status block.
```

## Proposed `.pass` — unchanged except deleting the header restatement

The header line belongs to `.instruction` and `.fail` now. `.pass` keeps the checks.

---

## What this does NOT fix

- The fan-out/diet contradiction (decision 1). Untouched by design.
- `prompt-lab.mjs`'s `proteinChoices`/`proteinWeights` mismatch — a code fix, one word, outside a
  prompt-tuning change but it invalidates every recipes measurement taken through that harness.
- The `Recipes system [a]` fragment. Seven of its rules are restated in `.instruction`; this proposal
  assumes `.instruction` wins and source 1 is cut to role-only, but that is a second edit to a second
  record and I have not written it.
- **Untested.** Everything above is a proposal. Validating it means rendering the candidate text out
  of Mongo, running N=5 on the same unit, and comparing against the baseline table at the top —
  before anything is written to the database.
