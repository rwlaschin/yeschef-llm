// Regression: a composed menu plan must serialize to YAML that ROUND-TRIPS (stringify → parse).
// The bug: planAsYaml stripped the block-scalar "|-" indicator for display, so a multi-line
// `instructions` value (which carries "Pass:/Fail:" text full of ": ") re-parsed as nested
// mappings and /ai/rebuild blew up with "Nested mappings are not allowed in compact mappings".
// Run: node --test functions/entry/ai/menu.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { parse } from "yaml";
import { planAsYaml, DEFAULT_COURSE_COUNTS } from "./menu.js";
import { menuSchema } from "./schemas.js";

const unfence = (text) => {
  const m = String(text).match(/```(?:yaml)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : text).trim();
};

test("planAsYaml output round-trips: stringify → parse → same step count", () => {
  const plan = [
    {
      // instructions carries the colon-laden Pass/Fail text that triggered the bug
      instructions:
        "Find EVERY regulation that governs meals.\n\nPass: Output is ONLY headings.\n" +
        "Fail: Any of: a rule with no code; a fabricated code; a bullet that is only a heading.",
      model: "llama3_1_8b_v1", subtype: "compliance", kind: "fanout",
      items: [1], contexts: [], tools: ["web_search", "web_fetch"],
    },
    {
      instructions: "Plan day {{day}}.\nPass: every meal present.\nFail: a missing meal; no beverages.",
      model: "llama3_1_8b_v1", subtype: "menu_plan", kind: "fanout",
      items: [1, 2, 3], contexts: [0], tools: [],
    },
  ];
  const raw = planAsYaml(plan);
  const parsed = parse(unfence(raw));                 // this is exactly what /ai/rebuild does
  assert.ok(Array.isArray(parsed), "parses back to a YAML list");
  assert.equal(parsed.length, 2);
  assert.match(parsed[0].instructions, /Fail: Any of:/); // the colon text survived intact
  assert.equal(parsed[1].count, 3);                      // fanout unit count preserved
  assert.match(unfence(raw), /\n\n- /);                  // readability: blank line between steps (linefeed)
});

// The frontend keeps its own copy of the defaults (it seeds the setup form from them). The bug this
// guards: the two drift and a build that arrives without courseCounts serves a different menu than
// the one the setup page shows.
const PLAN_OPTIONS_TS = fileURLToPath(new URL("../../../../yeschef/src/lib/planOptions.ts", import.meta.url));

test("DEFAULT_COURSE_COUNTS matches the frontend copy in yeschef/src/lib/planOptions.ts", () => {
  const src = readFileSync(PLAN_OPTIONS_TS, "utf8");
  const literal = /DEFAULT_COURSE_COUNTS: Record<string, number> = (\{[^}]*\})/.exec(src)?.[1];
  assert.ok(literal, "found the frontend literal");
  assert.deepEqual(new Function(`return ${literal}`)(), DEFAULT_COURSE_COUNTS);
  assert.deepEqual(DEFAULT_COURSE_COUNTS, { appetizer: 3, entree: 2, side: 3 });
});

const validateMenu = new Ajv({ allErrors: true, coerceTypes: false }).compile(menuSchema);
const body = (extra) => ({ userId: "u1", companyId: "c1", ...extra });

test("menuSchema serves a course 0 or 2–7 dishes, never 1", () => {
  const counts = (n) => validateMenu(body({ courseCounts: { entree: n } }));
  assert.equal(counts(1), false, "1 dish is not a menu");
  assert.equal(counts(2), true);
  assert.equal(counts(7), true);
  assert.equal(counts(0), true, "0 = the service doesn't offer that course at all");
  assert.equal(counts(8), false);
});

// The schema is now the only thing enforcing these: menu.js' hand-check was removed, so a gap here
// means a composed plan attributed to nobody.
test("menuSchema rejects a build with no caller or company", () => {
  assert.equal(validateMenu({}), false, "an empty body is not a build");
  assert.equal(validateMenu({ companyId: "c1" }), false, "no userId");
  assert.equal(validateMenu({ userId: "u1" }), false, "no companyId");
  assert.equal(validateMenu(body()), true, "both present = valid");
});

test("menuSchema takes the proteinWeights rows the setup page actually sends", () => {
  assert.equal(
    validateMenu(body({ proteinWeights: [{ protein: "Pork", cut: "bacon", diets: ["standard"], weight: 14 }] })),
    true,
    "the real app payload",
  );
  assert.equal(
    validateMenu(body({ proteinWeights: [{ protein: "Tofu", diets: ["vegan"], weight: 10 }] })),
    true,
    "a protein with no meaningful cut sends none",
  );
  assert.equal(
    validateMenu(body({ proteinWeights: [{ protein: "Pork", origin: "local" }] })),
    false,
    "an unknown field on a row is junk/injection",
  );
  assert.equal(
    validateMenu(body({ proteinWeights: [{ protein: "Pork", weight: 101 }] })),
    false,
    "weight is a percentage",
  );
});
