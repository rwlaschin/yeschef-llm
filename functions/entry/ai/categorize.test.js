// checkResult — the deterministic guard that keeps a mangled parse from being returned as
// `success`. The n8n scraper files any non-success recipe for human review, which is the correct
// outcome when a pass silently dropped or invented an ingredient.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkResult, checkPasses, body } from "./categorize.js";

const INPUT = [
  "4 (4-ounce) salmon fillets",
  "1 cup uncooked quinoa, rinsed",
  "2 cups low-sodium chicken broth",
];

// `src` is the index of the INPUT line a row came from — stamped by postProcess and the only
// reliable line count (see checkResult). Fixtures carry it because real rows always do.
test("checkResult: one parsed line per input line passes", () => {
  const r = checkResult(INPUT, {
    components: [
      { ingredient: "salmon fillet", quantity: "4", unit: "ounce", src: 0 },
      { ingredient: "quinoa", quantity: "1", unit: "cup", src: 1 },
    ],
    seasonings: [{ ingredient: "chicken broth", quantity: "2", unit: "cups", src: 2 }],
  });
  assert.deepEqual(r, { ok: true, reason: null });
});

test("checkResult: a dropped line fails with the counts named", () => {
  const r = checkResult(INPUT, {
    components: [{ ingredient: "quinoa", quantity: "1", unit: "cup", src: 1 }],
    seasonings: [{ ingredient: "chicken broth", quantity: "2", unit: "cups", src: 2 }],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /parsed 2 ingredient lines but the recipe has 3/);
});

test("checkResult: dual-role expansion (two rows, one source line) still counts as one line", () => {
  const r = checkResult(["1/2 cup shredded cheddar cheese"], {
    components: [
      { ingredient: "cheddar cheese", quantity: "0.5", unit: "cup", category: "dairy", src: 0 },
      { ingredient: "cheddar cheese", quantity: "0.5", unit: "cup", category: "protein", src: 0 },
    ],
    seasonings: [],
  });
  assert.deepEqual(r, { ok: true, reason: null });
});

// The regression this whole guard got wrong: a real AHA recipe (Vanilla Fruit Dip) lists two
// cream cheeses that normalize to the SAME ingredient|quantity|unit. Counting unique content
// mistook the second line for a lost one and rejected a perfectly correct parse.
test("checkResult: two input lines with identical ingredient/quantity/unit both count", () => {
  const dip = [
    "1 lemon (zested)",
    "4 ounces fat-free cream cheese (softened)",
    "4 ounces low-fat cream cheese (softened)",
  ];
  const r = checkResult(dip, {
    components: [
      { ingredient: "lemon", quantity: "1", unit: null, src: 0 },
      { ingredient: "cream cheese", quantity: "4", unit: "ounces", category: "dairy", src: 1 },
      { ingredient: "cream cheese", quantity: "4", unit: "ounces", category: "protein", src: 1 },
      { ingredient: "cream cheese", quantity: "4", unit: "ounces", category: "dairy", src: 2 },
      { ingredient: "cream cheese", quantity: "4", unit: "ounces", category: "protein", src: 2 },
    ],
    seasonings: [],
  });
  assert.deepEqual(r, { ok: true, reason: null });
});

// Coverage is by DISTINCT src, so duplicating one line's rows can never fake a missing line.
test("checkResult: repeating one source line's rows does not cover a missing line", () => {
  const r = checkResult(INPUT, {
    components: [
      { ingredient: "quinoa", quantity: "1", unit: "cup", src: 1 },
      { ingredient: "quinoa", quantity: "1", unit: "cup", src: 1 },
      { ingredient: "quinoa", quantity: "1", unit: "cup", src: 1 },
    ],
    seasonings: [],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /parsed 1 ingredient lines but the recipe has 3/);
});

test("checkResult: an ingredient from a prompt's worked example is untraceable → fail", () => {
  const r = checkResult(INPUT, {
    components: [
      { ingredient: "light tub margarine", quantity: "4", unit: "teaspoons", src: 0 },
      { ingredient: "quinoa", quantity: "1", unit: "cup", src: 1 },
    ],
    seasonings: [{ ingredient: "chicken broth", quantity: "2", unit: "cups", src: 2 }],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not present in the recipe input: light tub margarine/);
});

test("checkResult: nothing parsed at all fails rather than returning an empty success", () => {
  const r = checkResult(INPUT, { components: [], seasonings: [] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no ingredients parsed from 3 input lines/);
});

// checkPasses — the between-pass line-count guard the pre-async implementation had. It can no
// longer CORRECT a pass (they chain inside the worker), but it still detects and attributes the loss.
test("checkPasses: every cleanup pass returning N lines passes", () => {
  const runs = [
    { step: 0, response: "1. a\n2. b\n3. c" },
    { step: 1, response: "1. a\n2. b\n3. c" },
    { step: 2, response: "```yaml\ncomponents: []\n```" },
  ];
  assert.deepEqual(checkPasses(INPUT, runs, 3), { ok: true, reason: null });
});

test("checkPasses: the pass that dropped a line is named", () => {
  const runs = [
    { step: 0, response: "1. a\n2. b\n3. c" },
    { step: 1, response: "1. a\n2. b" },
    { step: 2, response: "```yaml\ncomponents: []\n```" },
  ];
  const r = checkPasses(INPUT, runs, 3);
  assert.equal(r.ok, false);
  assert.match(r.reason, /cleanup pass 1 returned 2 ingredient lines but was given 3/);
});

test("checkPasses: chain-of-thought prose instead of a list is caught as a count mismatch", () => {
  // The original regression: pass 0 answered the prompt's worked example in prose and lost lines.
  const runs = [
    { step: 0, response: '1. 1 tablespoon plus 1 teaspoon olive oil\nStep 1 — identify units.\nResult: "4 teaspoons olive oil"' },
    { step: 1, response: "1. a\n2. b\n3. c" },
  ];
  const r = checkPasses(INPUT, runs, 3);
  assert.equal(r.ok, false);
  assert.match(r.reason, /cleanup pass 0 returned 1 ingredient lines but was given 3/);
});

test("checkPasses: the final YAML pass is not line-counted", () => {
  const runs = [{ step: 0, response: "1. a\n2. b\n3. c" }, { step: 1, response: "1. a\n2. b\n3. c" }];
  assert.equal(checkPasses(INPUT, runs, 3).ok, true);
});

test("checkPasses: a missing run doc is skipped rather than reported as zero lines", () => {
  assert.equal(checkPasses(INPUT, [{ step: 1, response: "1. a\n2. b\n3. c" }], 3).ok, true);
});

// --- the NUMBERS invariant: both failures observed on real runs, neither changes the line count ---

test("checkPasses: a converted unit on a non-combined line is caught (observed: 1 tbsp -> 3 tbsp)", () => {
  const input = ["1 cup quinoa", "1 tablespoon olive oil"];
  const runs = [{ step: 0, response: "1. 1 cup quinoa\n2. 3 tablespoons olive oil" }];
  const r = checkPasses(input, runs, 2);
  assert.equal(r.ok, false);
  assert.match(r.reason, /cleanup pass 0 invented the quantity 3 on line 2/);
});

test("checkPasses: a re-invented combination is caught (observed: 3 tbsp -> 1 tbsp plus 1 tsp)", () => {
  // Pass 1's input is pass 0's output, so the chain is checked pass-by-pass, not against the recipe.
  const input = ["1 cup quinoa", "1 tablespoon olive oil"];
  const runs = [
    { step: 0, response: "1. 1 cup quinoa\n2. 1 tablespoon olive oil" },
    { step: 1, response: "1. 1 cup quinoa\n2. 2 tablespoons plus 1 teaspoon olive oil" },
  ];
  const r = checkPasses(input, runs, 3);
  assert.equal(r.ok, false);
  assert.match(r.reason, /cleanup pass 1 invented a combined quantity on line 2/);
});

test("checkPasses: an invented combination is caught even when it adds no new number value", () => {
  // Observed on a real run: the prompt's worked-example phrase pasted onto the real line. Both
  // amounts are "1", so the NUMBERS invariant sees nothing new — only COMBINING catches it.
  const input = ["1 tablespoon olive oil"];
  const runs = [{ step: 0, response: "1. 1 tablespoon plus 1 teaspoon olive oil" }];
  const r = checkPasses(input, runs, 2);
  assert.equal(r.ok, false);
  assert.match(r.reason, /cleanup pass 0 invented a combined quantity on line 1/);
});

test("checkPasses: a non-additive 'and' with no second amount is not a combination", () => {
  const input = ["6 large ears of corn, husks and silk discarded"];
  const runs = [{ step: 0, response: "1. 6 large ears of corn, husks and silk discarded" }];
  assert.equal(checkPasses(input, runs, 2).ok, true);
});

test("checkPasses: resolving a combination away is fine; only creating one is flagged", () => {
  const input = ["1 tablespoon plus 1 teaspoon margarine"];
  const runs = [
    { step: 0, response: "1. 4 teaspoons margarine" },
    { step: 1, response: "1. 4 teaspoons margarine" },
  ];
  assert.equal(checkPasses(input, runs, 3).ok, true);
});

test("checkPasses: summing a genuinely additive line is licensed, not flagged", () => {
  const input = ["1 tablespoon plus 1 teaspoon light tub margarine"];
  const runs = [{ step: 0, response: "1. 4 teaspoons light tub margarine" }];
  assert.equal(checkPasses(input, runs, 2).ok, true);
});

test("checkPasses: dropping numbers (annotation strip, 'or' pick) is not inventing", () => {
  const input = ["2 medium tomatoes, chopped (about 2 cups)", "1 1/2 cups or 17.75 ounces broth"];
  const runs = [{ step: 0, response: "1. 2 medium tomatoes, chopped\n2. 17.75 ounces broth" }];
  assert.equal(checkPasses(input, runs, 2).ok, true);
});

test("checkPasses: fractions compare by value, so 1/2 passing through is unchanged", () => {
  const input = ["1/2 cup chopped walnuts", "1 1/2 pounds chicken thighs"];
  const runs = [{ step: 0, response: "1. 1/2 cup chopped walnuts\n2. 1 1/2 pounds chicken thighs" }];
  assert.equal(checkPasses(input, runs, 2).ok, true);
});

test("checkPasses: a line with no numbers at all is not flagged for staying numberless", () => {
  const input = ["cooking spray", "salt to taste"];
  const runs = [{ step: 0, response: "1. cooking spray\n2. salt to taste" }];
  assert.equal(checkPasses(input, runs, 2).ok, true);
});

test("body: a rejection carries its reason as `outcome`, the field the n8n scraper reads", () => {
  const r = checkPasses(["1 tablespoon olive oil"], [{ step: 0, response: "1. 3 tablespoons olive oil" }], 2);
  const res = body("fail", null, r.reason);
  assert.equal(res.status, "fail");
  assert.match(res.outcome, /invented the quantity 3 on line 1/);
  assert.equal(res.reason, res.outcome);
});

test("body: a success carries no outcome/reason field", () => {
  const res = body("success", { components: [], seasonings: [], allergens: [] }, null);
  assert.equal("outcome" in res, false);
  assert.equal("reason" in res, false);
});

test("checkResult: short words alone don't make an ingredient traceable", () => {
  // "ice" is 3 chars, so it yields no >=4-char token; the name must still match something real.
  const r = checkResult(["1 cup rice"], { components: [{ ingredient: "rice", quantity: "1", unit: "cup" }], seasonings: [] });
  assert.equal(r.ok, true);
});
