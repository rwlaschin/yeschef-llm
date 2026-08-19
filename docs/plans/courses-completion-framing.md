# The runaway — one line, one change

Nothing written to Mongo. Ready to test when the box frees.

## What happened

Run 1 on the shared box: **130,954 characters, 1,241 rows, 7 distinct lines.** It cycled four
dishes — `Roasted carrots` → `Braised beef with barley` → `Sauteed spinach` → `Grilled asparagus` —
about 310 times, and stopped only at the token cap. The last line is cut mid-word (`| As`), which is
why no status marker appeared: it never reached the end.

## The line

`plan_library` / Build Courses `.fail`, last line, verbatim:

> THEN check every other Fail criterion above, and output the status block — @@::PASS::@@ or
> @@::FAIL:reason::@@ — ALONE on the final line. **YOUR RESPONSE IS NOT FINISHED UNTIL THAT LINE IS
> WRITTEN.**

It asserts *you are not finished*, in the position where a stop signal belongs. The model obeyed it.

## The change

```
- THEN check every other Fail criterion above, and output the status block — @@::PASS::@@ or
- @@::FAIL:reason::@@ — ALONE on the final line. YOUR RESPONSE IS NOT FINISHED UNTIL THAT LINE IS
- WRITTEN.
+ Then check every other Fail criterion above and write the status block — @@::PASS::@@ or
+ @@::FAIL:reason::@@ — ALONE on the final line. That line ends your response.
```

Completion, not deferral. One line, one source, nothing else touched.

## Scope

The sweep found five continuation-framed lines across the seven assembled sources. Four are fine —
they are "having written the table, read it back", which is a legitimate ordering instruction, not a
statement that the response is unfinished:

- `Courses status contract` L5 — `STOP. You are NOT finished. Read the table you just wrote…`
- `Courses status contract` L14 — `A response that ends WITHOUT one is INCOMPLETE…`
- `Courses status contract` L20 — `LEAN TOWARD FAILURE… incomplete or unusable` (describes the RESULT)
- `Build Courses.fail` L3 — `BEFORE YOU STOP: reread the rows you just wrote…`

Only L4 is the defect. Leave the rest alone.

## What to measure

Same harness, N=8, unit {standard, day 1}, merged prompt, one variable changed:

- rows ≤ 12 in 8/8 — a runaway is >100
- distinct rows == total rows in 8/8 — run 1 had 7 distinct of 1,241
- marker present in 8/8 — run 1 emitted none because it never finished

Prior run, same conditions, L4 unchanged: 1 runaway of 8, marker present 7/8.
