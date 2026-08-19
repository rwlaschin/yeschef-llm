# Subtractive plan selection

`[ ]` open · `[J]` Jess · `[K]` Kim · `[x]` done. Numbers are permanent ids — never renumber.

## Problem

A caller of `/ai/menu` today declares which steps to RUN, as a bag of booleans. Adding a step to
`plan_library` therefore requires editing every caller, or the step silently never runs — and a
step with no toggle key runs always, whatever the caller sends.

The plan should be callable by anyone. Steps a caller does not need are REMOVED by that caller.
Steps a caller does need are never listed. A new intermediate step ("tweener") then does its work
without anyone remembering to name it and without a code change.

## Current state (verified 2026-08-15, do not re-derive)

- `functions/entry/ai/menu.js:129-131` — `toggleKeyForSubtype` is built from `MENU_ENTRIES` rows
  with `group === "body"`. This is a second vocabulary that must track `plan_library.subtype`.
- `functions/entry/ai/menu.js:145` — `if (toggleKey && enabled[toggleKey] === false)`. Strict
  `=== false`, so **absent means ON**, and a subtype with no toggle key is never gated at all.
- `functions/entry/ai/menu.js:148` — same `=== false` test for `def.inputs`.
- `recipe_detail` (Build Recipe Details) has **no toggle key** and always runs. `course_check` was
  the same before `Verify Course Positions` was deactivated.
- Every other active subtype does have a key: `protein_dietary_categorization`, `protein_grid`,
  `recipes`, `courses`, `nutrients`, `compliance`, `menu`, `recipe`, `nutrition`, `inventory`,
  `order_form`.
- `yeschef/src/components/pages/CreatePlanPage.tsx:842` and `:1019` are the two callers. Both send
  a full 11-key map, nine or ten of them `false`, to express a two-step plan.
- `composeFromDefs` (`functions/entry/ai/compose.js:374`) is pure and does NOT filter on `enabled`
  — the caller filters. Any new caller that forgets to filter runs the entire library.

## Work

1. `[ ]` Decide the partition: which active `plan_library` rows are THE PLAN, and which are the
   "non" plan types to be removed from it. Current active set is the 12 subtypes listed above.
   Robert's call, not the implementer's — record the answer here before writing code.

2. `[ ]` Decide where the removed types go, since they still have to run somehow. They are
   callable work, just not part of the menu plan chain. Record the mechanism here.

3. `[ ]` Replace the `enabled` boolean bag with a subtractive selector on `/ai/menu`. A caller
   names only what to remove; everything else in the plan runs. Absent must mean RUN, and that must
   be the only reading — no key can be un-removable by omission.

4. `[ ]` Delete `toggleKeyForSubtype` and the `MENU_ENTRIES` `group === "body"` dependency, so
   `plan_library.subtype` is the single vocabulary. Confirm nothing else reads that group.

5. `[ ]` Update both `CreatePlanPage.tsx` call sites to the subtractive shape.

6. `[ ]` Keep `pruneOrphans` on top of the selection — a step whose upstream context was removed
   must still drop. Confirm the drop is logged, not silent.

7. `[ ]` Regression test: add a new `plan_library` row with a subtype no caller mentions, compose,
   and assert it RUNS with zero code changes in any caller. This is the property the whole task
   exists for — if it does not hold, the task is not done.

8. `[ ]` Regression test: a caller that removes a step asserts it is absent from the composed plan,
   and that removing a mid-chain step drops its dependents via `pruneOrphans` rather than
   composing a broken chain.

## Out of scope

Prompt content. Model selection. The `dispatch.js` fail-loud guards (already shipped).
