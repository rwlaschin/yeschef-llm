// The seeded analytics_widget fragments and the step's markers have to FIT each other. They are
// authored in two files, so this is the one check that fails if either side moves: a fragment placed
// at a marker the step does not emit is dropped silently, and a marker no fragment claims collapses —
// both look like "the model just ignored the instruction".
import test from "node:test";
import assert from "node:assert/strict";
import { SVG_CHART_PROMPTS } from "./seed-svg-chart-prompts.mjs";
import { assembleFor, inScope } from "../config/promptSections.js";
import { svgChartInstructions, MAX_SVG_BYTES } from "../config/svgChart.js";

const assembled = () =>
  assembleFor(SVG_CHART_PROMPTS, "analytics_widget", svgChartInstructions("draw a sine wave"), { scope: "task_list" });

test("every fragment is placed at a marker the step actually emits", () => {
  const instructions = svgChartInstructions("q");
  for (const p of SVG_CHART_PROMPTS) {
    if (p.relatesTo === "system") continue;
    assert.ok(instructions.includes(`{${p.relatesTo}}`), `"${p.name}" is placed at {${p.relatesTo}}, which the step does not emit`);
  }
});

test("the assembled prompt carries the whole authored contract, and no markers", () => {
  const { system, instructions } = assembled();
  assert.match(system, /# ROLE/);
  assert.match(system, /ONE chart as ONE SVG document/);
  assert.match(instructions, /data-v/);
  assert.match(instructions, /layout\(/);
  assert.match(instructions, /touch-action:none/);
  assert.match(instructions, /setPointerCapture/);
  assert.match(instructions, /CANNOT ANSWER/);
  assert.equal(/\{(leading|trailing|conditions|pass|fail)\}/.test(instructions), false);
});

// The hard limits are a PROMPT, in the database, per docs/design/prompt-library.md rule 1 — so
// nothing in code can hold them in sync with the gate. This is the check that they stay in sync: the
// fragment must name every constant validateSvgChart() enforces. Edit the validator, this fails.
test("the hard-limits fragment names every constant the validator enforces", () => {
  const limits = SVG_CHART_PROMPTS.find((p) => p.relatesTo === "conditions").content;
  assert.match(limits, new RegExp(`${MAX_SVG_BYTES / 1024}KB`));
  assert.match(limits, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  for (const forbidden of ["fetch", "XMLHttpRequest", "WebSocket", "eval", "new Function",
    "document.cookie", "localStorage", "sessionStorage", "window.parent", "window.top",
    "<iframe>", "<object>", "<embed>", "<foreignObject>", "<image>", "<use>"]) {
    assert.ok(limits.includes(forbidden), `hard limits never mention ${forbidden}`);
  }
});

test("the fragments are task_list only — an unscoped prompt would leak into meal-plan builds", () => {
  for (const p of SVG_CHART_PROMPTS) {
    assert.ok(inScope(p, "task_list"), `"${p.name}" is not in task_list scope`);
    assert.equal(inScope(p, "menu_plan"), false, `"${p.name}" leaks into menu_plan`);
  }
  assert.equal(assembleFor(SVG_CHART_PROMPTS, "analytics_widget", "no markers", { scope: "menu_plan" }).system, "");
});

// The answer does NOT stop at ">". Every step in this pipeline ends on the shared status block, and
// the role fragment used to forbid anything after the SVG outright — so a model obeying it could not
// emit one, and worker/index.js logged "NO STATUS BLOCK → treated as success" on every chart.
test("the role fragment makes room for the status block after </svg>", () => {
  const role = SVG_CHART_PROMPTS.find((p) => p.relatesTo === "system").content;
  assert.match(role, /status block/i);
  assert.match(role, /<\/svg>/);
  assert.equal(/LAST CHARACTER: ">"/.test(role), false, "the role fragment still forbids the status block");
});

// Invented figures are indistinguishable from measurements once drawn. A request with no numbers is
// a shortfall, never a licence to fill them in.
test("nothing in the contract tells the model to invent data", () => {
  for (const p of SVG_CHART_PROMPTS) {
    assert.equal(/invent plausible|choose plausible ones/i.test(p.content), false,
      `"${p.name}" tells the model to make up numbers`);
  }
  const all = SVG_CHART_PROMPTS.map((p) => p.content).join("\n");
  assert.match(all, /NO NUMBERS AND NO FORMULA → YOU DO NOT DRAW/);
});
