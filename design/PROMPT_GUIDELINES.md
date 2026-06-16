# Prompt-Writing Guidelines (from developit-ai)

How developit-ai writes its prompts, distilled as a guideline for YesChef-LLM's worker/planner
prompts (authored in Mongo `prompt_library` + the dashboard).

**Why follow it:** developit's planner auto-picks the cheapest/fastest model per step from a models
list — most steps ran on `gemini-2.5-flash` / `2.0-flash-lite`, not a frontier model — and still hit
~99% format compliance. The discipline is in the prompt, not the model. A small/fast model (our
`llama3.1:8b`) can hold the same format **if the prompt is written this way.**

Source: `developit-ai/llm/modules/llm/prompts.py` (`LLM_CONTEXT_PROMPT`, `CONTEXT_SYSTEM_INSTRUCTIONS`)
and `__init__.py`.

---

## 1. Every step is self-contained
The executing agent sees ONLY its step's `instructions` (+ listed `contexts`) — never the user's
request. So each step must carry everything it needs, copied **verbatim**: exact counts/numbers, full
URLs and named sources, banned/required items, all constraints, and the exact output format. Anything
omitted is lost and the step runs blind. When in doubt, include it.

## 2. Every step ends with explicit `PASS:` / `FAIL:` criteria
These are the rubric the agent judges itself against and reports as its verdict. A step with no
Pass/Fail rubric is invalid. Make them concrete and checkable — "executes without runtime errors and
output exactly matches X", not "works correctly." This is what lets failure actually fire.

## 3. Create, then validate — as separate steps
A creation step is immediately followed by a distinct validation step. A validation step targets a
**single** artifact so its `failStep` is a discrete, unambiguous target. Never let one step both
produce a deliverable and rubber-stamp its own success — separate the producer from the judge.

## 4. Show a concrete worked example
Don't only describe the format — include a full, literal example and say "follow the exact structure."
Models match patterns far more reliably from a worked example than from prose rules.

## 5. Markers: one consolidated definition, both forms shown literally
Define a status/output marker ONCE, in one place, in this order: placement → delimiters → the literal
PASS form + when to use it → the literal FAIL form + when to use it → "must be the very last element,
nothing after." Show both literal forms side by side. Never scatter the definition or restate it
per-subtype (it drifts).

## 6. Lean toward failure
State it: "Critically review the response and lean toward failure for any error that produces an
incorrect, incomplete, or unusable result, or leaves any requirement unmet." An optimistic judge
("PASS if you produced something") rubber-stamps; a skeptical one is what makes the verdict mean
something.

## 7. Boundary: deliverable first, marker after — never wrapped
Say explicitly that the deliverable comes first and in full, THEN the marker as a separate final line,
and that the marker is NOT part of the deliverable and never wraps it. Without this, a weak model
fuses its output into the marker (we saw `<@@::meal_plan:: …yaml… ::@@>`). Between the delimiters goes
ONLY the token — never a YAML key, never any other content.

## 8. Distinctive, named markers
developit uses `<?!PLAN_STATUS::PASS::PLAN_STATUS!?>` and `<?!ID::{id}, {name}::ID!?>` — each marker
carries its own NAME inside the delimiters and "no other characters are permitted." A named, distinctive
bookend can't false-trigger from prose and signals "this slot is a status, not content." (We use the
shorter `<@@::…::@@>`; the named form is a robustness lever if a model keeps fumbling the marker.)

## 9. "EXACT AND LITERAL", repeated, in caps for non-negotiables
For the rules that must not bend, developit repeats "EXACT AND LITERAL", "No other characters are
permitted", "nothing else", "MUST", and CAPS the imperative. Weak models need the non-negotiables
hammered; reserve the emphasis for the few things that truly can't vary.

## 10. Output hygiene, stated as negatives
"Output ONLY the deliverable (raw text/YAML). No preamble, no commentary, no metadata, no markdown
fences." Plus fence-nesting rules and "output/print from code must NOT be wrapped in fences." Say what
NOT to emit, explicitly — don't assume the model infers it.

## 11. Let the planner pick the model per step
Hand the planner a models list with a one-line `purpose` for each, and instruct it to pick the most
cost-effective/fastest model that fits each step. Run the planner itself at low temperature (developit
uses 0.1) for deterministic plans.

## 12. Personas embodied, not announced
"Embody this persona through tone and vocabulary. Do not introduce yourself or describe your identity."

## 13. Scope discipline baked into the prompt
e.g. "When bug fixing, do NOT refactor unless asked — no renames, no style changes; if a fix needs a
change, it must address only the bug." Constraints the model should always honor belong in the prompt,
not left to chance.

---

### The through-line
Self-contained steps · explicit per-step Pass/Fail · producer ≠ judge · one literal marker definition ·
lean to failure · deliverable-before-marker · emphasis only where it must not bend. That combination —
not model size — is what got developit to ~99%.
