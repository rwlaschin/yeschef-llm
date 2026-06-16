// Regression: a composed menu plan must serialize to YAML that ROUND-TRIPS (stringify → parse).
// The bug: planAsYaml stripped the block-scalar "|-" indicator for display, so a multi-line
// `instructions` value (which carries "Pass:/Fail:" text full of ": ") re-parsed as nested
// mappings and /ai/rebuild blew up with "Nested mappings are not allowed in compact mappings".
// Run: node --test functions/entry/ai/menu.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { planAsYaml } from "./menu.js";

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
