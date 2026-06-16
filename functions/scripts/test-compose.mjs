// Self-test for the PURE composeFromDefs — no Firestore, no emulator. Run:
//   node functions/scripts/test-compose.mjs
//
// Feeds 3-4 sample step defs (a legals query, a menu menu_plan with mapOf:"days" + a pureed-gated
// fragment via requiredFlags, an aggregation order_form, and a menu_validation compliance step)
// through composeFromDefs and prints the resulting plan[]. The defs here are ALREADY sorted +
// filtered, exactly as composeMenuPlan would hand them over.

import { composeFromDefs } from "../entry/ai/compose.js";

const sampleForm = {
  model: "qwen2.5:32b",
  values: {
    institution: "Senior Care",
    legals: "FDA Food Code, CMS",
    diets: "regular, diabetic, low-sodium",
    restrictions: "no nuts, seasonal",
  },
  duration: { weeks: 1, businessDaysOnly: false, days: 7 },
  residents: 300,
  flags: { pureed: true },
  costTier: "standard",
  enabled: {},
};

// Sorted + filtered defs (pureed is active in flags, so the pureed-gated menu def survives).
const sampleDefs = [
  {
    name: "legals",
    order: 10,
    active: true,
    subtype: "query",
    requiredFlags: [],
    inputs: ["legals"],
    instruction: "Capture the binding legal/regulatory requirements: {{join legals \", \"}}. For each, state its obligation as YAML.",
    pass: "Every named regulation ({{join legals \", \"}}) has a concrete obligation.",
    fail: "Any regulation is missing or has a vague obligation.",
    kind: "fanout",
    mapOf: "",
    context: [],
    includeInOutput: true,
  },
  {
    name: "menu",
    order: 20,
    active: true,
    subtype: "menu_plan",
    requiredFlags: ["pureed"],
    inputs: ["institution", "legals", "diets", "restrictions"],
    instruction:
      "Produce ONE day's menu (breakfast/lunch/dinner) for {{residents}} residents at a {{institutionRaw}} facility. " +
      "Provide a compliant variation per diet ({{join diets \", \"}}), honoring legals ({{join legals \", \"}}) and restrictions ({{join restrictions \", \"}}). " +
      "Cost tier: {{costTier}} (reference basket: {{join costBasket \", \"}}). " +
      "{{#if flags.pureed}}PUREED-SAFE: every dish must blend safely — no bones, shells, or hard-to-blend items.{{/if}}",
    pass: "Each diet has a complete, compliant day; pureed-safe constraint honored.",
    fail: "A diet is missing, non-compliant, or includes un-pureeable items.",
    kind: "fanout",
    mapOf: "days",
    context: ["legals"],
    includeInOutput: true,
  },
  {
    name: "menu_validation",
    order: 25,
    active: true,
    subtype: "compliance",
    requiredFlags: [],
    inputs: [],
    instruction: "Verify the day's menu against legals ({{join legals \", \"}}), diets ({{join diets \", \"}}), and restrictions ({{join restrictions \", \"}}). Give a terse verdict.",
    pass: "Menu satisfies all legals, diets, and restrictions.",
    fail: "Any violation is present.",
    kind: "fanout",
    mapOf: "",
    context: ["menu"],
    includeInOutput: false,
  },
  {
    name: "order_form",
    order: 40,
    active: true,
    subtype: "procurement",
    requiredFlags: [],
    inputs: [],
    instruction: "Consolidate all recipe ingredients into a master order form, grouped by purchasing section, in bulk units, scaled to {{residents}} residents.",
    pass: "All ingredients grouped, in bulk units, scaled correctly.",
    fail: "Missing groupings, wrong units, or incomplete coverage.",
    kind: "aggregation",
    mapOf: "",
    context: ["menu"],
    includeInOutput: true,
  },
];

const plan = composeFromDefs(sampleDefs, sampleForm);
console.log(JSON.stringify(plan, null, 2));
