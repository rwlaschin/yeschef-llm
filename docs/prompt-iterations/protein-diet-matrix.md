---
modified: 2026-08-07
dependencies: []
---

# Prompt iterations — protein→diet matrix and entrées

Each version is scored by machine-checkable criteria, not by reading the prose, so a change can be
judged better or worse instead of argued about. Run with the lab harness: it renders the step defs
through the real `functions/entry/ai/compose.js` and calls Ollama directly.

**Model under test:** `llama3.1:8b` — the production tier (`llama3_1_8b_v1` in `config/models.js`).

Versions v1-v6 were originally measured on a 3B model, which has since been removed from the dev
machine as too weak to be representative. **Those numbers are discarded and are not reproduced here**:
every conclusion drawn from them about prompt *wording* turned out to be an artifact of model size, not
a property of the prompt. The false-safe that dominated that investigation — a meat protein tagged
`vegetarian` — does not occur on 8B at all. The scores below are 8B only.

| Version | 8B score | Change |
|---|---|---|
| v3 | 11/16 | header demanded as the first line |
| v7 | **16/18** | marker contract added per `prompt-library.md`'s checklist |

**v7 protein_diets: 9/9.** No false-safe, `vegetarian` on exactly the two plant proteins, `renal`
discriminating at 1/6, header present, marker emitted, and the self-verdict agreed with ground truth.

**Two failures remain, both on 8B and both in entrées, unchanged between v3 and v7** (so they are
independent of the marker work): a protein was used that was not on the supplied list, and the
highest-weighted protein was skipped. That is the next thing to fix.

### What the marker work established

v3 carries no marker instruction and emits no marker. v7 adds one worded to
`docs/design/prompt-library.md`'s checklist — deliverable first then the marker as its own final line
(item 7), "lean toward failure" (item 6), hygiene as negatives (item 10) — and the marker appears on
both steps with a correct self-verdict.

An earlier attempt placed "Output ONLY … nothing else" *before* requesting the marker. That is a direct
contradiction and the model resolved it by dropping the marker, which is the exact failure item 7 warns
about. Worth noting that `prompt_library` documents are joined per subtype by `systemPromptFor`
(filtered on `mapping`, ordered by its value), so the live database may already supply a marker
contract — that must be checked against the real collection before any prompt edit ships.

| Version | Score | Change from previous |
|---|---|---|
| v1 | 4/13 | starting point: suitability framing on the matrix, under-tagging Fail on entrées |
| v2 | 10/13 | context wiring only — prompt text identical to v1 |
| v3 | **12/13** | one line: the header is demanded as the FIRST line, absence is an explicit Fail |
| v3 re-scored | 12/14 ×3, fatal ×3 | scorer only: the false-safe is now its own fatal check |
| v4 | 12/14 ×3, fatal ×3 | one sentence: a diet excluding a category excludes every protein in it |
| v5 | 12/14 ×3, fatal ×3 | the Fail line now leads with the false-safe instead of structural errors |

v4 and v5 are both **rejected** — no reliable difference. v3 remains the prompt. See "What the nine
runs actually show" below.

## v1 — 4/13. Not a prompt problem at all.

`{{proteinLines}}` rendered **empty**, so the model was handed `Proteins:` followed by nothing and
invented its own list — fish, pork, lamb, shrimp, tuna, salmon, eggs — then tagged shrimp, tuna and
salmon `vegetarian`.

**Exact cause:** `baseContext` in `compose.js` is a closed allow-list. It returns a fixed object
literal, so any field not named in it is silently dropped at render. No error, no warning — the
`{{token}}` just renders as empty string.

**Lesson worth keeping:** a prompt cannot be judged until its variables are proven to render. Every
downstream failure in v1 was a cascade from one empty interpolation, and reading the response alone
would have sent the investigation into the wording.

**Fix (code, not prompt):** added `proteinChoices` and `counts` to `baseContext`, plus a
`{{proteinLines proteinChoices}}` helper that formats `Label (weight)` lines — the same job
`proteinBackbone` does for the grid. Kept separate from the existing `proteins` field because that one
is the per-slot grid map, a different shape under the same name.

## v2 — 10/13. Wiring fixed, prompt text untouched.

Deliberately changed nothing but the context wiring, so the delta is attributable. Real proteins now,
none invented.

Two failures remained, and one was in the harness:

1. **The model omits the header row.** It went straight to data. The scorer took line 0 as the header,
   so every column lookup returned -1 and cascaded into six false failures. **This is a real pipeline
   break, not only a harness bug** — `buildRecipeInputsFromRuns` is name-keyed and bails without a
   `dish` column. Scorer changed to detect a missing header and score it as its own single failure.
2. **`vegetarian` on a meat protein.** Genuine content error, see v3.

## v3 — 12/13. One minimal change.

Changed `Output ONLY pipe-delimited rows with this exact header` to `Your FIRST line must be this
header, then one row per protein` and added a missing header to the `fail` criteria. Nothing else.

The header appeared on both steps, and **entrées went 7/7**: exactly 6 rows, `Kind` correct, proteins
only from the list, all four diets covered, six multi-diet dishes (no partition), and the
highest-weighted protein used.

### The one remaining failure — and it is the important one

```
Protein | Diets
Chicken | regular, low-sodium, vegetarian     ← chicken is not vegetarian
Beef | regular, renal
Turkey | regular, low-sodium
Cod | regular, low-sodium
Tofu | vegetarian, low-sodium
Lentils | vegetarian
```

`Chicken → vegetarian` is a **false-safe** claim: the error direction that puts a resident in front of
food their diet forbids. The whole reason this step exists is to make that judgment once, in isolation,
so it can be checked — and it got it wrong on the most obvious case in the list.

Secondary, all under-inclusive and therefore safe: Tofu lost `regular`, Lentils lost `regular` and
`low-sodium`, Beef gained `renal` (arguable at a small portion, and exactly the hedging the v0
Constraints column was removed to prevent).

**Not yet attempted:** a fix for the false-safe. It needs to be minimal, and a scoring criterion that
catches direction — a false-safe must weigh more than an under-inclusion, because the two have very
different consequences.

## Scorer change — the false-safe is now its own fatal check

Added to `scoreMatrix` (nothing removed or loosened; the existing biconditional
`vegetarian only on plant proteins` check still runs unchanged):

```
no false-safe: meat tagged vegetarian (<offending proteins>)   → severity 'fatal'
```

It fires only on the dangerous direction — a meat/fish protein carrying a diet that forbids that
category. Under-inclusion no longer counts against it. Totals go from 13 to 14 checks, and a failed
fatal is printed separately in the summary line so it cannot be traded away against six passing
structural checks.

The first thing this bought was a correction to the v3 record: **the false-safe is not a one-off on
Chicken.** Re-running v3 three times under the new scorer gives 12/14 with a fatal every time, and the
offenders move around: `Turkey` / `Chicken, Turkey, Cod` / `Turkey, Cod`. The single recorded v3
response understated the problem.

## v4 — 12/14, fatal in 3/3. No reliable difference.

One sentence added to the matrix instruction, immediately before the "judge as a kitchen would serve
it" paragraph:

> A diet that EXCLUDES a food category excludes every protein in that category, so leave a diet out of
> the row whenever what the diet forbids covers the protein itself.

Runs: `12/14, 1 FATAL (Beef)` · `12/14, 1 FATAL (Beef, Cod)` · `12/14, 1 FATAL (Beef, Cod)`.
Entrées stayed 7/7 in all three, so the sentence cost nothing — it just did not work.

## v5 — 12/14, fatal in 3/3. No reliable difference.

Alternative minimal change, applied to v3 (not stacked on v4) so the delta is attributable. The `fail`
criterion — which `compose.js` renders into the prompt as a `Fail:` line — now leads with the content
error instead of listing only structural ones:

> A protein listed under a diet that forbids that kind of food, a missing header line, a protein
> missing or invented, …

Runs: `12/14, 1 FATAL (Cod)` · `12/14, 1 FATAL (Turkey, Cod)` · `12/14, 1 FATAL (Chicken, Cod)`.
Chosen because v3's only real win came from strengthening the `fail` line, so that was the lever with
evidence behind it. It did not transfer to a content judgment.

### What the nine runs actually show

| | run 1 | run 2 | run 3 | offending proteins, total |
|---|---|---|---|---|
| v3 | 12/14 fatal | 12/14 fatal | 12/14 fatal | 6 |
| v4 | 12/14 fatal | 12/14 fatal | 12/14 fatal | 5 |
| v5 | 12/14 fatal | 12/14 fatal | 12/14 fatal | 5 |

6 vs 5 vs 5 across three samples is noise, not an improvement. Two things are worth keeping:

- **`Cod` is tagged `vegetarian` in 7 of the 9 runs**, more often than any meat. The failure is not
  "the model forgets vegetarian excludes animals", it is that at 3B `vegetarian` collapses into
  something pescatarian-shaped. An instruction phrased in terms of *categories* cannot fix that,
  because the model's category boundary is where the error lives — which is why both v4 and v5 land in
  the same place.
- The rest of the matrix is stable and correct under all three versions, and entrées is 7/7 in 9/9
  runs. The step is one column away from usable.

**Verdict: keep v3 as the prompt.** v4 and v5 are not worse, but neither earns a change, and shipping a
sentence that does nothing makes the next iteration harder to read. The remaining problem is not
wording:

1. Production runs `llama3_1_8b_v1`. This has not been measured on 8B — the 3B result says the wording
   is not the fix, not that the pipeline is broken. Measure there before writing another sentence.
2. If 8B still false-safes, the fix belongs in code, not the prompt: `vegetarian` (and any
   category-exclusion diet) is mechanically decidable from the protein's own category, so the matrix
   row can be filtered on the way into Firestore. A deterministic check does not need to be asked
   politely three different ways.

## Harness notes

- Scoring mirrors the frontend parser: keep only lines containing a pipe, first such line is the
  header, drop separator rows. What the scorer accepts is what `recipeShared.ts` accepts.
- `temperature: 0.2`, matching what `style: "structured"` maps to on the worker.
- The anti-partition check exists because an earlier hand-test satisfied "every diet appears once" by
  assigning each diet to exactly one dish — technically covered, useless as a menu.
