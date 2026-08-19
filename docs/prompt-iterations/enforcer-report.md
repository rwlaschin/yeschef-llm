---
modified: 2026-08-07
dependencies: []
---

# Enforcer report — two-step `protein_grid` → `recipes` chain

Repo: `/Users/mac/Documents/Work/alimenta/yeschef-llm`. Model: `llama3.1:8b` on local Ollama
(`http://localhost:11434`). Mongo read-only throughout — `prompt_library` and `plan_library` were
never written. Node v22.19.0.

## Verdict summary

| Claim | Verdict |
|---|---|
| A — `protein_grid` step works | **FAIL** (content correct; required header never emitted, and the step self-reports PASS anyway) |
| B — `recipes` honours the protein backbone when given one | **PASS** (6/6 runs, both diets) |
| C — the criteria can actually fail | **PASS** (3/3 emitted a well-formed `@@::FAIL:reason::@@`) |
| D — the chain composes as two steps in one job | **FAIL** (`Build Recipes` declares NO earlier step; `contexts` resolves to `[]`, not `[0]`) |

The harness in `scripts/prompt-lab.mjs` was **not** trusted. I built a replay that calls the REAL
`composeFromDefs` / `renderUnit` / `unitCount` / `loadStep` / `buildStepMessages` / `chatRound` /
`splitOutcome` with only Firestore and Pub/Sub stubbed. It lives in `.enforcer/` at the repo root
(`faithful.mjs`, `form.mjs`, `validate.mjs`, `claimA.mjs`, `claimA2.mjs`, `claimB.mjs`,
`claimC.mjs`, `claimD.mjs`, `print.mjs`, `negctrl.mjs`, `raw.mjs`, `harness_diff.mjs`, plus the
read-only DB dumps `dump_defs.mjs`, `dump_two.mjs`, `dump_prompts.mjs`, `show_sys.mjs`,
`check_docs.mjs`). Every command below is run from the repo root.

---

## Harness audit — `scripts/prompt-lab.mjs`

### It joins system prompts the same way — byte-identical, but by luck

`worker/index.js:371-386`:

```js
async function systemPromptFor(type) {
  const prompts = await getPrompts();
  return prompts
    .filter((p) => p.mapping && p.mapping[type] != null)
    .sort((a, b) => {
      const x = String(a.mapping[type]), y = String(b.mapping[type]);
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .map((p) => p.content)
    .filter(Boolean)
    .map((c) => c.replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1"))
    .join("\n\n");
}
```

Two divergences from `prompt-lab.mjs:25-33`:

1. The lab **omits the backslash-strip `.map()`**.
2. The lab's document filter is `{ active: { $ne: false } }`; the worker's (`worker/index.js:262-266`)
   is `{ isDeleted: { $ne: true } }` plus `active: true` when `!INCLUDE_INACTIVE` (i.e. in
   production). `INCLUDE_INACTIVE = !IS_PROD` (`worker/index.js:245`), so **in dev the worker loads
   inactive prompts and the lab does not**.

Both are currently inert for these two subtypes. Proof:

```
$ NODE_ENV=dev node .enforcer/dump_prompts.mjs protein_grid recipes
TOTAL prompt_library docs: 27
active!==false: 26

### subtype "protein_grid": 2 mapped docs (of ALL docs, ignoring active)
  order="m" active=true len=1302 name=6a28a5a25b0a853a539963d2
  order="a" active=true len=1056 name=Protein Grid system
  → active-only count: 2
  → docs containing markdown-escape backslashes worker would strip: 0

### subtype "recipes": 2 mapped docs (of ALL docs, ignoring active)
  order="m" active=true len=1302 name=6a28a5a25b0a853a539963d2
  order="a" active=true len=1182 name=Recipes system
  → active-only count: 2
  → docs containing markdown-escape backslashes worker would strip: 0
```

```
$ NODE_ENV=dev node .enforcer/harness_diff.mjs
### subtype=protein_grid
  system: lab=2360ch worker=2360ch identical=true
  ...
### subtype=recipes
  system: lab=2486ch worker=2486ch identical=true
```

**Proves:** the system-prompt join is byte-identical *today*. It is not structurally equivalent — a
soft-deleted or inactive prompt, or one carrying an editor backslash escape, silently desynchronises
the lab from the worker.

### It does NOT inject prior-step output the way `loadStep()` does

`worker/steps/step.js:28-50` (`loadStep`) and `:90` (`buildStepMessages`):

```js
const user = joinSections(section("Instructions", def.instructions), ...ctxBlocks);
```

`section()` (`worker/steps/prompt.js:17-20`) prefixes `# Instructions\n`. `prompt-lab.mjs:95` does
not:

```js
const user = [renderUnit(step, u), ...ctxBlocks].join('\n\n')
```

Measured:

```
$ NODE_ENV=dev node .enforcer/harness_diff.mjs
### subtype=protein_grid
  user:   lab=1151ch worker=1166ch identical=false
  worker user first line: "# Instructions"
  lab    user first line: "For the regular diet, assign ONE protein per day and mealtime across 7 days..."
  worker adds prefix "# Instructions\n": true
### subtype=recipes
  user:   lab=1821ch worker=1836ch identical=false
  worker user first line: "# Instructions"
  worker adds prefix "# Instructions\n": true
```

**Proves:** the lab drops the `# Instructions` header the worker always adds. Exactly 15 chars, and
the *only* difference — but the lab is therefore not the prompt the worker sends.

The lab also **ignores `loadStep`'s `kind: 'chain'` branch** (`step.js:39-44`). For a chain step the
worker reads only `steps/{unitDocId(idx, payload.unit)}` — the source step's **matching unit** — and
labels it `# Result of step N (unit U):`. The lab (`prompt-lab.mjs:88-91`) always joins **every**
unit of the source step and labels it `# Result of step N:`. For the two steps under test this is
moot (neither is a chain, and neither has any context at all — see Claim D), but the lab would
misrepresent `Build Daily Recipes` / `Analyze Daily Nutrition` / `Build Inventory`, all of which are
`kind: chain`.

### Other things the lab silently changes

| | `prompt-lab.mjs` | real worker |
|---|---|---|
| endpoint | `POST /api/generate`, `{system, prompt}` | `POST /api/chat`, `messages[]` (`worker/ollama.js:44-53`) |
| temperature | hard-coded `0.2` | `temperatureForStyle(step.style)` → `structured: 0.1` (`config/models.js:171`) |
| other sampler params | none sent | `defaultSampler()` ← `model_config._default` ← per-model doc |
| `num_ctx` | not set (Ollama default) | `sizeNumCtx(...)`, floor `OLLAMA_NUM_CTX=8192`, cap 131072 — measured **8192** for both steps |
| units run | `UNIT_CAP` default **1** | all of them — **4** for the grid, **28** for recipes |
| `form.date` | absent | set; `{{date}}`/`{{season}}`/`{{weekday}}` render empty without it |

Measured sampler/style resolution:

```
$ NODE_ENV=dev node .enforcer/raw.mjs
SAMPLER: {"temperature":0.8,"top_p":0.9,"top_k":40,"min_p":0,"repeat_penalty":1.1,"repeat_last_n":64,"mirostat":0,"mirostat_tau":5,"mirostat_eta":0.1,"seed":0}
STYLE_MAP: {"structured":0.1,"blended":0.35,"unstructured":0.7}
```

**Harness verdict: do not use `scripts/prompt-lab.mjs` as evidence.** Its system prompt is right by
coincidence; its user prompt, transport, sampler, context window, unit coverage and chain handling
are all different from the worker.

---

## Claim A — `protein_grid` works: **FAIL**

### Unit count matches `mapOf`

`plan_library` doc `Build Protein Grid` has `mapOf: "diets as |diet|"`, `kind: "fanout"`.

```
$ NODE_ENV=dev node .enforcer/claimA.mjs   (first line)
unitCount(protein_grid) = 4  items=["regular","low-sodium","renal","vegetarian"]  (diets in form = 4)
```

**Proves:** `resolveItems` resolved `diets` → the 4 form diets, `compose.js` set `step.items` to
them, and `dispatch.js unitCount()` returns 4. Unit count is correct.

### The status block is emitted and parses against the real `MARKER`

`splitOutcome` from `worker/steps/outcome.js` (which uses
`MARKER = /@@::(?:(PASS)|FAIL:\s*([\s\S]+?))\s*::@@/i`) was called on the raw response, not a
re-implementation:

```
$ NODE_ENV=dev node .enforcer/claimA.mjs
===== RUN 1  (temp=0.1 numCtx=8192 24541ms) =====
MARKER: status=PASS reason=""  rawTail="| Beef | chuck\nDay 7 | dinner | Yogurt | greek\n\n@@::PASS::@@"
```

Plus the real unit tests for the parser:

```
$ node --test worker/steps/outcome.test.js worker/steps/step.test.js
# tests 20
# pass 20
# fail 0
```

**Proves:** the block is emitted, is the last element, and parses. This part works.

### But the required header is never emitted — and the step says PASS anyway

Six runs (3 per diet, two diets):

```
$ NODE_ENV=dev node .enforcer/claimA2.mjs

########## protein_grid UNIT 0 (diet="regular") ##########
RUN 1: marker=PASS headerOk=false first="Day 1 | breakfast | Chicken | breast" rows=21/21 cols=[4] missing=0 dup=0 prose=0 dietViolations=[] -> criteriaMet=false AGREE=false
RUN 2: marker=PASS headerOk=false first="Day 1 | breakfast | Chicken | breast" rows=21/21 cols=[4] missing=0 dup=0 prose=0 dietViolations=[] -> criteriaMet=false AGREE=false
RUN 3: marker=PASS headerOk=false first="Day 1 | breakfast | Chicken | breast" rows=21/21 cols=[4] missing=0 dup=0 prose=0 dietViolations=[] -> criteriaMet=false AGREE=false

########## protein_grid UNIT 3 (diet="vegetarian") ##########
RUN 1: marker=PASS headerOk=false first="Day 1 | breakfast | Egg | scrambled" rows=21/21 cols=[4] missing=0 dup=0 prose=0 dietViolations=[] -> criteriaMet=false AGREE=false
RUN 2: marker=PASS headerOk=false first="Day 1 | breakfast | Egg | scrambled" rows=21/21 cols=[4] missing=0 dup=0 prose=0 dietViolations=[] -> criteriaMet=false AGREE=false
RUN 3: marker=PASS headerOk=false first="Day 1 | breakfast | Egg | scrambled" rows=21/21 cols=[4] missing=0 dup=0 prose=0 dietViolations=[] -> criteriaMet=false AGREE=false
```

Full raw output of one run:

```
$ NODE_ENV=dev node .enforcer/raw.mjs
===== RAW protein_grid unit0 =====
Day 1 | breakfast | Chicken | breast
Day 1 | lunch | Lentil | 
Day 1 | dinner | Cod | fillet
Day 2 | breakfast | Egg | scrambled
...
Day 7 | dinner | Yogurt | greek

@@::PASS::@@
```

**What this proves.** Every slot is present and correct: 21/21 rows (7 days × 3 mealtimes), no
missing slot, no duplicate slot, no prose, 4 columns throughout, `Cut` correctly left blank for
Lentil, and no meat on the vegetarian unit. **The header row `Day | Mealtime | Type | Cut` is
absent in all 6 runs.** The step's own instruction says *"Output ONLY pipe-delimited rows … with
this exact header and columns and nothing else: Day | Mealtime | Type | Cut"*. The model deviates
from an explicit instruction in 6/6 runs and self-reports PASS, while its system prompt tells it to
"LEAN TOWARD FAILURE".

Two honest caveats on this verdict:

- The literal `pass` template says *"in the `Day | Mealtime | Type | Cut` format"* — arguably the
  rows **are** in that format, so the model's PASS is defensible against the letter of the Pass
  criterion even though it violates the instruction. `criteriaMet=false` above is my stricter
  reading (header required). Either way, the step's self-grading does not notice the deviation.
- Downstream the grid parser is header-tolerant, so nothing breaks today. `yeschef/src/query/hooks/proteinGrid.ts:56-70`:

  ```js
  if (cells.slice(0, 3).every((c) => HEADER_HINT.test(c))) continue          // header row
  ```

  It skips a header if present and works without one.

**Verdict FAIL**, per the rules of engagement: a required output element is missing in 100% of runs
and the self-report does not catch it.

---

## Claim B — `recipes` honours the protein backbone: **PASS**

### The shape `proteinBackbone` expects

`functions/entry/ai/compose.js:58-78` — `hb.registerHelper("proteinBackbone", (proteins, diet, day))`
reads `proteins[normDiet][day][mealtime] = { type, cut? }` where `normDiet` is the diet with
whitespace stripped and lower-cased, `day` is a **number**, and it emits
`Day <day> | <mealtime> | <type> <cut>` lines. `proteins` is `form.proteins` (`compose.js:292`).

The authoritative producer confirms the same shape —
`yeschef/src/query/hooks/proteinGrid.ts:262-275`:

```ts
export type ProteinSeed = Record<string, Record<number, Record<string, { type: string; cut?: string }>>>
const normDiet = (s: string) => s.replace(/\s+/g, '').toLowerCase()
```

### Negative control — the brief's premise is correct

```
$ NODE_ENV=dev node .enforcer/negctrl.mjs
--- NO proteins seed: backbone block present = false ; contains "Day 1 | breakfast |" = false ---
For the regular diet, write ONE reduced recipe for each mealtime on Day 1 — mealtimes: breakfast, lunch, dinner. ... Build on the protein backbone.  Honor the regular diet strictly ...

--- proteins:{} (empty obj): backbone block present = false ; contains "Day 1 | breakfast |" = false ---
```

**Proves:** without a seed the `{{#if (proteinBackbone …)}}` guard skips the whole block, exactly as
the brief said. Any earlier run without a seed measured nothing about the backbone.

### The backbone block is PRESENT in the rendered prompt — printed, not inferred

```
$ NODE_ENV=dev node .enforcer/print.mjs
form.proteins keys: ["regular","low-sodium","renal","vegetarian"]
form.proteins.regular[1]: {"breakfast":{"type":"Chicken","cut":"thigh"},"lunch":{"type":"Beef","cut":"chuck"},"dinner":{"type":"Egg","cut":"scrambled"}}

##############################################################################
# STEP 1 (Build Recipes) unit 0  numCtx=8192  roles=system:2486 user:1836
##############################################################################
----- [user] -----
# Instructions
For the regular diet, write ONE reduced recipe for each mealtime on Day 1 — mealtimes: breakfast, lunch, dinner. A reduced recipe = a dish name plus its four components: protein, starch, vegetable, fruit. Build on the protein backbone. Use EXACTLY the protein the plan has assigned to each slot below — the Protein column MUST equal it and each dish is built around that protein; never substitute it or default to plant proteins, and the DISH NAME must stay consistent with the assigned protein and its cut (never rename the protein or state a different cut in the title). Write one recipe for each slot listed, no more and no fewer:
Day 1 | breakfast | Chicken thigh
Day 1 | lunch | Beef chuck
Day 1 | dinner | Egg scrambled
 Honor the regular diet strictly (vegan = no animal products; vegetarian = no meat/poultry/seafood; renal = control phosphorus & potassium; honor no-pork/halal/kosher). Respect the standard cost tier and United States · Seattle regional/cultural availability. Where it doesn’t conflict, lean toward resident preferences: comfort foods. Label the day as Day 1.

Output ONLY pipe-delimited rows, one per line, with this exact header and columns and nothing else:
Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit

Pass: Every mealtime (breakfast, lunch, dinner) on Day 1 has exactly one recipe row, all appropriate for the regular diet, in the `Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit` format with no prose, and each row’s Protein equals the slot’s assigned protein from the plan’s grid when one is given.
Fail: Any missing mealtime slot for Day 1, a component disallowed on the regular diet, output that is not the pipe-delimited rows, a Protein that does not match the slot’s assigned grid protein, or a dish name that contradicts the assigned protein or its cut.
```

### 6 runs, 2 diets — every row's Protein matches its slot

```
$ NODE_ENV=dev node .enforcer/claimB.mjs

########## recipes UNIT 0 slot={"diet":"regular","day":1} backbone={"breakfast":{"type":"Chicken","cut":"thigh"},"lunch":{"type":"Beef","cut":"chuck"},"dinner":{"type":"Egg","cut":"scrambled"}} ##########
RUN 1: backboneInPrompt=true marker=PASS header=7col rows=3 missing=[] prose=0
     breakfast  want="Chicken thigh" got="Chicken thigh" match=true  dish="Chicken and Waffles"
     lunch      want="Beef chuck" got="Beef chuck" match=true  dish="Beefy Mac 'n Cheese"
     dinner     want="Egg scrambled" got="Egg scrambled" match=true  dish="Egg Scramble with Toast"
     >>> criteriaMet=true modelSaid=PASS AGREE=true
RUN 2: backboneInPrompt=true marker=PASS header=7col rows=3 missing=[] prose=0
     breakfast  want="Chicken thigh" got="Chicken thigh" match=true  dish="Chicken and Waffles"
     lunch      want="Beef chuck" got="Beef chuck" match=true  dish="Beefy Mac 'n Cheese"
     dinner     want="Egg scrambled" got="Egg scrambled" match=true  dish="Egg Scramble with Toast"
     >>> criteriaMet=true modelSaid=PASS AGREE=true
RUN 3: backboneInPrompt=true marker=PASS header=7col rows=3 missing=[] prose=0
     breakfast  want="Chicken thigh" got="Chicken thigh" match=true  dish="Chicken and Waffles"
     lunch      want="Beef chuck" got="Beef chuck" match=true  dish="Beefy Mac 'n Cheese"
     dinner     want="Egg scrambled" got="Egg scrambled" match=true  dish="Egg Scramble with Toast"
     >>> criteriaMet=true modelSaid=PASS AGREE=true

########## recipes UNIT 21 slot={"diet":"vegetarian","day":1} backbone={"breakfast":{"type":"Lentil"},"lunch":{"type":"Tofu","cut":"firm"},"dinner":{"type":"Yogurt","cut":"greek"}} ##########
RUN 1: backboneInPrompt=true marker=PASS header=7col rows=3 missing=[] prose=0
     breakfast  want="Lentil" got="Lentil" match=true  dish="Lentil Scramble"
     lunch      want="Tofu firm" got="Tofu firm" match=true  dish="Tofu Stir Fry"
     dinner     want="Yogurt greek" got="Yogurt greek" match=true  dish="Greek Yogurt Parfait"
     >>> criteriaMet=true modelSaid=PASS AGREE=true
RUN 2: ... (identical)  >>> criteriaMet=true modelSaid=PASS AGREE=true
RUN 3: ... (identical)  >>> criteriaMet=true modelSaid=PASS AGREE=true
```

**Proves:** with a real seed, all 18 slot-protein comparisons matched exactly (type **and** cut), the
7-column header was present in 6/6 runs, all three mealtimes were emitted, no prose, and the
self-reported status agreed with the criteria in 6/6. Unlike the grid step, the recipes step **does**
emit its header — which matters, see the finding below.

**Verdict PASS.** Caveat: the fanout is `dietDays` (28 units); I ran 2 of them, 3 times each. I did
not run all 28.

---

## Claim C — the criteria can actually fail: **PASS**

Construction: seed the **vegetarian** diet with **Pork belly / Beef chuck / Shrimp**. Satisfying the
backbone violates the diet; honouring the diet violates the backbone. Either branch trips a stated
Fail condition. Built in memory only — `plan_library` was not touched.

```
$ NODE_ENV=dev node .enforcer/claimC.mjs
recipes items: [{"diet":"vegetarian","day":1},...,{"diet":"vegetarian","day":7}]
----- rendered user prompt (proof the poisoned backbone is present) -----
# Instructions
For the vegetarian diet, write ONE reduced recipe for each mealtime on Day 1 — mealtimes: breakfast, lunch, dinner. ... Write one recipe for each slot listed, no more and no fewer:
Day 1 | breakfast | Pork belly
Day 1 | lunch | Beef chuck
Day 1 | dinner | Shrimp
 Honor the vegetarian diet strictly (vegan = no animal products; vegetarian = no meat/poultry/seafood; ...)
...
Fail: Any missing mealtime slot for Day 1, a component disallowed on the vegetarian diet, output that is not the pipe-delimited rows, a Protein that does not match the slot’s assigned grid protein, or a dish name that contradicts the assigned protein or its cut.

=== RUN 1: marker=FAIL reason="protein mismatch" header=7col rows=3 proteinsMatchBackbone=false rowsContainingMeat=2
     breakfast  want="Pork belly" got="Egg" match=false dish="Veggie Omelette"
     lunch      want="Beef chuck" got="Beef chuck" match=true dish="Grilled Portobello"
     dinner     want="Shrimp" got="Shrimp" match=true dish="Lentil and Mushroom"
     --- full response ---
     Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit
     1 | breakfast | Veggie Omelette | Egg | Whole wheat toast | Spinach | Orange
     1 | lunch | Grilled Portobello | Beef chuck | Brown rice | Roasted bell peppers | Apple
     1 | dinner | Lentil and Mushroom | Shrimp | Quinoa | Steamed broccoli | Banana
     
     @@::FAIL:protein mismatch::@@

=== RUN 2: marker=FAIL reason="protein mismatch" ... (byte-identical rows) ... @@::FAIL:protein mismatch::@@
=== RUN 3: marker=FAIL reason="protein mismatch" ... (byte-identical rows) ... @@::FAIL:protein mismatch::@@
```

**Proves:** the FAIL path is real and reachable. 3/3 runs emitted a well-formed
`@@::FAIL:<reason>::@@`, `splitOutcome` returned `status: "FAIL", reason: "protein mismatch"`, and
the reason names a genuine defect in the output.

**Verdict PASS.** Two secondary observations from the same runs: the model self-reported the
*protein* mismatch but not the two other Fail conditions it also tripped — "a component disallowed
on the vegetarian diet" (rows 2 and 3 carry Beef chuck and Shrimp on a vegetarian menu) and "a dish
name that contradicts the assigned protein" (`Grilled Portobello | Beef chuck`,
`Lentil and Mushroom | Shrimp`). So it fails, but it under-reports *why*.

---

## Claim D — the chain composes as two steps in one job: **FAIL**

The DB says `Build Recipes` has no earlier step:

```
$ NODE_ENV=dev node .enforcer/dump_defs.mjs
TOTAL plan_library docs: 9
{"name":"Build Protein Grid","order":"A","active":true,"kind":"fanout","subtype":"protein_grid","mapOf":"diets as |diet|","context":[],...}
{"name":"Build Recipes","order":"B","active":true,"kind":"fanout","subtype":"recipes","mapOf":"dietDays as |slot|","context":[],...}
{"name":"Build Nutrients","order":"C","active":true,"kind":"fanout","subtype":"nutrients","mapOf":"diets as |diet|","context":[],...}
{"name":"Fetch Legal ","order":"V","active":true,"kind":"fanout","subtype":"compliance","mapOf":"Legals as |legal|","context":[],...}
{"name":"Build Seasonal Menus","order":"r","active":true,"kind":"fanout","subtype":"menu_plan","mapOf":"days as |day|","context":["Fetch Legal "],...}
{"name":"Build Daily Recipes","order":"v","active":true,"kind":"chain","subtype":"recipe","mapOf":"","context":["Build Seasonal Menus"],...}
{"name":"Analyze Daily Nutrition","order":"w","active":true,"kind":"chain","subtype":"nutrition","mapOf":"","context":["Build Daily Recipes"],...}
{"name":"Build Inventory","order":"x","active":true,"kind":"chain","subtype":"inventory","mapOf":"","context":["Build Daily Recipes"],...}
{"name":"Build Order Form","order":"y","active":true,"kind":"fanout","subtype":"procurement","mapOf":"","context":["Build Inventory"],...}
```

`composeFromDefs` run against the real docs, both as the full plan (`composeMenuPlan`'s read order:
`active: true`, lex sort on `order`, then `pruneOrphans`) and as the two-step subset:

```
$ NODE_ENV=dev node .enforcer/claimD.mjs
--- A) FULL plan_library, real order + pruneOrphans ---
pruned: []
  [0] Build Protein Grid       subtype=protein_grid kind=fanout   contexts=[] items=4 unitCount=4 failStep=null successStep=1 error=-
  [1] Build Recipes            subtype=recipes      kind=fanout   contexts=[] items=28 unitCount=28 failStep=null successStep=2 error=-
  [2] Build Nutrients          subtype=nutrients    kind=fanout   contexts=[] items=4 unitCount=4 failStep=null successStep=3 error=-
  [3] Fetch Legal              subtype=compliance   kind=fanout   contexts=[] items=2 unitCount=2 failStep=null successStep=4 error=-
  [4] Build Seasonal Menus     subtype=menu_plan    kind=fanout   contexts=[3] items=7 unitCount=7 failStep=null successStep=5 error=-
  [5] Build Daily Recipes      subtype=recipe       kind=chain    contexts=[4] items=7 unitCount=7 failStep=null successStep=6 error=-
  [6] Analyze Daily Nutrition  subtype=nutrition    kind=chain    contexts=[5] items=7 unitCount=7 failStep=null successStep=7 error=-
  [7] Build Inventory          subtype=inventory    kind=chain    contexts=[5] items=7 unitCount=7 failStep=null successStep=8 error=-
  [8] Build Order Form         subtype=procurement  kind=fanout   contexts=[7] items=(none) unitCount=1 failStep=null successStep=null error=-

--- B) TWO-STEP subset [Build Protein Grid, Build Recipes] ---
  [0] Build Protein Grid   db.context=[] -> resolved contexts=[] kind=fanout items=4 unitCount=4 successStep=1
  [1] Build Recipes        db.context=[] -> resolved contexts=[] kind=fanout items=28 unitCount=28 successStep=null

protein grid items: ["regular","low-sodium","renal","vegetarian"]
recipes items[0..3]: [{"diet":"regular","day":1},{"diet":"regular","day":2},{"diet":"regular","day":3},{"diet":"regular","day":4}] ... total 28
recipes itemVars: ["slot"]  grid itemVars: ["diet"]
```

**Actual values asked for:**

- `plan[1].contexts` = **`[]`** — *not* `[0]`. The second step does not resolve to the first step's
  index, because `Build Recipes`'s DB `context` array is empty.
- `unitCount` — step 0: **4** (one per diet); step 1: **28** (4 diets × 7 days, diet-major,
  `baseContext`'s `dietDays`).
- Advancement is linear: `successStep` 0→1. `failStep` is `null` on both.

**Proves:** the two steps run in the same job in the right order, but they are **not chained**.
`loadStep` iterates `def.contexts` (`step.js:36`); with `contexts: []` the loop body never executes,
`ctxBlocks` is `[]`, and the grid's output is **never** injected into the recipes prompt. The only
route from grid to recipes is out-of-band: the frontend reads the grid runs
(`parseProteinGrid`), turns them into a seed (`proteinSeedFromGrid`), and submits it as
`form.proteins` on a **later job** — which is what Claim B exercised. There is no in-job chain.

**Verdict FAIL** as the claim is stated.

---

## Could not prove

1. **That the seed reaching production actually comes from the grid step.** I supplied `form.proteins`
   by hand in the shape `proteinSeedFromGrid` produces. I never ran the real
   `parseProteinGrid → proteinSeedFromGrid → form.proteins` path on live grid output, and I did not
   run the frontend at all. The header-less grid output feeds `parseProteinGrid` (tolerant) so it
   should survive, but this is inference, not measurement.
2. **All 28 recipes units and all 4 grid units.** I ran grid units 0 and 3 and recipes units 0 and 21,
   3 times each. Units 1, 2 of the grid and the other 26 recipes units are unmeasured.
3. **Behaviour at production model tier.** `Build Recipes`/`Build Protein Grid` have `modelProd`
   unset (see the dump — no `modelProd` key on either), so `composeFromDefs` with `isProd: true`
   would emit `model: "llama3_1_8b_v1"`, same as dev. But the other 7 steps carry
   `modelProd: "llama3_3_70b_v1"`, and I could not test 70B locally.
4. **Whether the missing grid header is a real Pass-criteria violation or only an
   instruction violation.** The `pass` template is ambiguous on the header (see Claim A caveats).
   I could not settle this from the DB text alone; it needs a decision from whoever authored it.
5. **The end-to-end job in a real worker.** I replayed the worker's step path in-process with
   Firestore and Pub/Sub stubbed. I never published a Pub/Sub message, never ran `worker/index.js`,
   and never wrote a run doc. Tool calling, streaming/`visibleResponse` flushes, the retry/`failStep`
   path, admission control and leasing are all untested here.
6. **Whether the `Pairing Method` column contradiction has ever caused a production failure.** I
   proved the contradiction exists and that the model resolves it by ignoring the system prompt
   (6/6 runs emitted 7 columns), but not what downstream consumers expected.
7. **Non-determinism at scale.** All runs at `temperature 0.1`, `seed 0` were byte-identical within
   each configuration. Three runs at one temperature is weak evidence about variance; I did not
   sweep temperature or seed.

---

## Corrections to the brief

1. **"The two-step LLM chain"** — there is no chain. `Build Recipes` has `context: []` in
   `plan_library`, so `composeFromDefs` yields `contexts: []` and `loadStep` injects nothing. The
   grid's output never reaches the recipes prompt inside a job. (Claim D evidence.)
2. **"`plan_library` … step definitions"** — correct, but the brief implies the two steps under test
   form the plan. The active `plan_library` has **9** steps; `Build Protein Grid` and `Build Recipes`
   are indices 0 and 1 of a 9-step plan, and `prompt-lab.mjs`'s default `CHAIN` is a synthetic
   2-step subset that does not correspond to any chain in the DB.
3. **"it joins system prompts the same way `systemPromptFor(type)` does"** — the result is
   byte-identical today but the code is not equivalent: the lab omits the backslash-strip `.map()`
   and uses a different document filter (`active: {$ne:false}` vs the worker's
   `isDeleted: {$ne:true}` + `active: true` in prod / *inactive included* in dev).
4. **"it injects prior-step output the same way `loadStep()` does"** — it does not. It omits the
   `# Instructions` header that `buildStepMessages` always adds (measured: 1151 vs 1166 chars for
   the grid; 1821 vs 1836 for recipes), and it ignores `loadStep`'s `kind: 'chain'` per-unit
   alignment. It also uses `/api/generate` instead of `/api/chat`, temperature 0.2 instead of the
   style-derived 0.1, no other sampler params, no `num_ctx`, and `UNIT_CAP=1` (1 of 4 / 1 of 28).
5. **"`llama3.1:8b` — this is the production tier per `config/models.js`"** — not for these two
   steps' siblings. `config/models.js:37` registers `llama3.1:8b` with `dev: true`; seven of the
   nine `plan_library` steps carry `modelProd: "llama3_3_70b_v1"`. `Build Protein Grid` and
   `Build Recipes` are the exception — they have **no** `modelProd`, so they do stay on 8B in
   production. The claim is true of these two steps by omission, not by design.
6. **"`llama3.2:3b` was deliberately removed"** — nothing named `llama3.2:3b` is installed, but
   `llama3.2:1b` is (`curl -s http://localhost:11434/api/tags` → `llama3.1:8b`,
   `nomic-embed-text:latest`, `llama3.2:1b`). I did not use it.
7. **"my previous attempt was invalid because the harness never supplied a `proteins` seed"** —
   **confirmed correct.** `.enforcer/negctrl.mjs` proves the `{{#if (proteinBackbone …)}}` guard
   renders nothing for both a missing `proteins` key and `proteins: {}`.
8. **`NODE_ENV=dev`** — works, but note it flips `INCLUDE_INACTIVE` in the worker, which changes
   which `prompt_library` docs load versus production. My replay deliberately used the **production**
   filter so the measurement reflects prod. (Same 26 docs either way today.)

---

## Findings that outrank the claims

1. **The recipes system prompt and the recipes step instruction demand different output schemas.**
   The `prompt_library` "Recipes system" doc requires an 8-column header:

   ```
   Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit | Pairing Method
   ```

   with a mandatory two-method flavour-pairing choice reported in that column. The `plan_library`
   `Build Recipes` instruction *and* its `pass` criterion require the 7-column header **without**
   `Pairing Method`. In 6/6 Claim B runs and 3/3 Claim C runs the model emitted **7 columns** and
   dropped the entire FLAVOR APPROACH requirement — while self-reporting PASS. Half the system
   prompt is dead text.

2. **A missing header is fatal for the recipes step and harmless for the grid step.** The recipes
   consumer, `yeschef/src/components/pages/recipeShared.ts:220-279`, treats line 1 as the header:

   ```ts
   function parsePipeTable(text: string): { header: string[]; rows: string[][] } | null {
     const lines = (text ?? '').split('\n').map((l) => l.trim()).filter((l) => l.includes('|'))
     if (lines.length < 2) return null
     ...
   }
   ...
   const col = (n: string) => t.header.findIndex((h) => h.toLowerCase() === n)
   const di = col('day'), mi = col('mealtime'), dishI = col('dish')
   if (dishI < 0) return
   ```

   With no header, `col('dish')` is `-1` and **the whole run is silently discarded** — no recipes
   persisted, no error. The recipes step happens to emit its header (6/6), so this is latent, not
   live. The grid consumer (`proteinGrid.ts:56-70`) skips headers by pattern and needs none, which is
   why the grid's 6/6 header omission causes no visible damage. The two consumers have opposite
   tolerances for the same prompt-level requirement.
