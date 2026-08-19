# Courses prompt — rewrite for review

Not applied. Nothing in Mongo has been changed. This is the proposed replacement text plus the
decisions it forces, which are yours.

Current: 2,432 words · 13,599 bytes · 80 negations · 3 hedges · 4 competing formats.
Proposed: ~430 words · ~3,100 bytes · 0 hedges · one format.

---

## The defects this fixes (your words, each traced to a line in the current prompt)

| your objection | current text | line |
|---|---|---|
| "where is the given diet defined?" | "only foods allowed on the given diet" — diet not named until L74, list not until L87 | L6 |
| "way too wordy" | 2,432 words | — |
| "not good with never don't" | 80 negations | — |
| "entree — never write this" | a prohibition living inside the definition list | L20 |
| "side contradicts soup/salad/starch/veg/drink" | side = "a small accompaniment served WITH the main plate"; the other five = "as named" | L21, L23 |
| "beverage???" | Components category `beverage`, Kind value `drink` | L14 vs L17 |
| "appetizer is not a kind" | appetizer sits in the Kind list | L17, L86 |
| "it either IS or ISN'T not USUALLY" | "usually Kind `side`, not `dessert`" | L24 |
| "voice is 100% inconsistent" | 4 `##` headers, 11 `*` bullets, 4 `-` bullets, 10 numbered items, running prose | — |

---

## Three decisions I had to make. Overrule any of them.

**1. Kind is the call's course positions. The 8-word vocabulary is deleted.**
You said appetizer is not a Kind. It is a *position* — it comes from `courseCounts`. So Kind takes
its values from the positions this call was given, and nothing else. This deletes the whole
`{side, dessert, drink, appetizer, soup, salad, starch, vegetable}` list, which is what the model
was sampling from when it wrote `salad`, `vegetable` and `starch` against a list asking for
appetizer and side. One list, not two.

**2. `beverage` wins; `drink` is deleted.** `beverage` is a Components category and is referenced by
other steps. `drink` only ever appeared in the Kind list, which is now gone.

**3. Definitions are deleted, not rewritten.** Once Kind is a closed copy-from-the-list operation,
`side`/`soup`/`salad` need no definitions — and the definitions were the contradiction. If you want
the model to *choose between* positions on aesthetic grounds, say so and I will write mutually
exclusive definitions instead.

---

## The prompt is assembled from 7 sources, and they repeat each other

The model never sees one document. It sees these, concatenated in this order:

| # | source | size |
|---|---|---|
| 1 | `prompt_library` / Courses system `[a]` | 4,195c |
| 2 | `prompt_library` / Reason column mechanism `[f]` | 665c |
| 3 | `prompt_library` / Courses reason content `[f1]` | 1,175c |
| 4 | `prompt_library` / Courses status contract `[m]` | 2,493c |
| 5 | `plan_library` / Build Courses `.instruction` | 4,082c |
| 6 | `plan_library` / Build Courses `.pass` | 284c |
| 7 | `plan_library` / Build Courses `.fail` | 973c |

Measured duplication — the same rule stated in more than one source:

| rule | stated in |
|---|---|
| the header line `Day \| Mealtime \| Dish \| …` | **4 sources** — 1, 2, 4, 5 |
| sauce / gravy / dressing rule | **3 sources** — 4, 5, 7 |
| "Output ONLY pipe-delimited rows" | 2 — 1, 5 |
| Kind vocabulary | 2 — 1, 5 |
| diet-claim safety rule | 2 — 1, 5 |
| `Ingredient:category` form | 2 — 1, 7 |
| status block `@@::PASS::@@` | 2 — 4, 7 |
| ``Never `entree` `` | 2 — 1, 5 |

Two of those repeats **contradict**: the header is written once WITH a `Reason` column (source 2)
and once WITHOUT it (sources 1 and 5). The model is told two different table shapes.

Ownership for the rewrite — each fact appears in exactly one source:

| source | owns |
|---|---|
| 1 Courses system | role, dish quality, diet semantics |
| 2 Reason mechanism | the `Reason` column only |
| 3 Reason content | what a good Reason says |
| 4 Status contract | the status block only |
| 5 `.instruction` | this call's INPUTS, ROWS, COLUMNS |
| 6 `.pass` / 7 `.fail` | the checks, and nothing else |

The header line is owned by source 5 alone, stated once, with `Reason` included.

---

## Proposed prompt

After testing, convert "inputs" into handlebar variables.

```
# INPUTS
Day:                1
Mealtime:           lunch
Diet:               standard
Diets on this plan: standard, diabetic
Course positions:   3 appetizers, 3 sides
Cost tier:          standard
Region:             United States · Los Angeles
Entrées for this day are printed below. They are already written.

# TASK
* Write the dishes that accompany the listed entrées.

# ROWS
* Write at least one row for each course position listed above.
* Write rows only for those positions.

# COLUMNS
Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit | Kind | Diets | Components | Reason

Day          Copy the Day above.
Mealtime     Copy the Mealtime above.
Dish         The name a kitchen would print on a menu. `Roasted Carrots` and `Caesar Salad` are
             both correct. A bare ingredient (`Carrots`) is not a dish.
Protein      One bare ingredient name, or empty.
Starch       One bare ingredient name, or empty.
Vegetable    One bare ingredient name, or empty.
Fruit        One bare ingredient name, or empty.
Kind         Copy one course position from the list above, singular.
Diets        Copy from `Diets on this plan`, comma separated. Claim a diet when every ingredient
             in Components is allowed on it.
Components   `Ingredient:category; Ingredient:category` over: protein, starch, vegetable, fruit,
             beverage, dairy, fat, seasoning. Only what is cooked into this dish.
Reason       What decided this dish for this row. Short phrases, semicolon separated. No `|`.

# RULES
* Each dish is chosen for the entrée it accompanies.
* A sauce, gravy, dressing, dip, relish or condiment belongs in Components as `<name>:seasoning`, included with the dish it comes with: `Mashed Potatoes and Gravy` is one row.
* Where one dish feeds several diets, write it once and name them all in Diets.
* Diet rules: vegan excludes animal products; vegetarian excludes meat, poultry and seafood; renal
* controls phosphorus and potassium; halal and kosher and no-pork are honoured as written.

# CHECK
Per row, in order:
  C1  Column count is 11, separated by `|`.
  C2  Day equals Day above.
  C3  Mealtime equals Mealtime above.
  C4  Kind appears in `Course positions`.
  C5  Components holds at least one `Ingredient:category` pair.
  C6  Every category in Components is one of the eight listed.
  C7  Every value in Diets appears in `Diets on this plan`.
  C8  Dish is not a bare ingredient.
  C9  Dish is not a sauce, gravy, dressing, dip, relish, or condiment.
Per course position, in order:
  C10 At least one row carries it.
Whole table:
  C11 Every row is unique.

# STATUS
Write one line, last, alone.
Every check C1–C11 passed:  @@::PASS::@@
Any check failed:           @@::FAIL:reason::@@
`reason` names EVERY failed check by its number and the row it failed on, semicolon separated:
`C4 row 3 kind=salad; C10 appetizer`

--- EXAMPLE START — NEVER include or reproduce any part of this in your response ---
Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit | Kind | Diets | Components | Reason
1 | lunch | Herbed Barley Pilaf |  | Barley |  |  | <position> | standard | Barley:starch; Parsley:seasoning | warm grain against a cold entrée; barley over rice, the entrée already has rice
@@::PASS::@@
--- EXAMPLE END — NEVER include or reproduce any part of this in your response ---
```

---

## What this changes about behaviour

Every off-list Kind measured in the last run — `salad`, `vegetable`, `starch`, `dressing` — came
from a list in the prompt: the first three from the Kind vocabulary, `dressing` from the sauce
prohibition at L79. Both lists are gone. `Kind` now has exactly one source, and it is the same list
the verifier checks against.

## What this does NOT fix

- `Reason` column: the current prompt declares the header twice, once with `Reason` (L33) and once
  without (L92). I kept `Reason`. If it is not wanted, say so and both go.
- The entrées arrive as context from step 2. If step 2 emits the wrong days, this prompt inherits
  them.
- Untested. Measuring it means N runs against local Ollama and a before/after on the same unit.
