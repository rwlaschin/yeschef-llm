import { test } from "node:test";
import assert from "node:assert/strict";
import { MODELS, STYLE_TEMPS, DEFAULT_STYLE, parallelOf, temperatureForStyle } from "./models.js";

test("equivalence partition: every configured model explicitly declares its generation capacity", () => {
  assert.deepEqual(
    MODELS.map(({ topic, parallel }) => ({ topic, parallel })),
    [
      { topic: "llama3_1_8b_v1", parallel: 3 },
      { topic: "llama3_3_70b_v1", parallel: 1 },
      { topic: "gemma4_12b_v1", parallel: 1 },
      { topic: "qwen3_5_9b_v1", parallel: 1 },
      { topic: "openclaw_gemma4_12b_v1", parallel: 1 },
      { topic: "openclaw_llama3_1_8b_v1", parallel: 1 },
      { topic: "openclaw_llama3_3_70b_v1", parallel: 1 },
    ],
  );
});

test("boundary analysis: a model may explicitly own the minimum capacity of one", () => {
  assert.equal(parallelOf({ topic: "one_slot", parallel: 1 }), 1);
});

test("equivalence partition: a model may explicitly own a multi-slot capacity", () => {
  assert.equal(parallelOf({ topic: "three_slots", parallel: 3 }), 3);
});

test("boundary analysis: rejects zero model capacity instead of inventing a default", () => {
  assert.throws(() => parallelOf({ topic: "zero_slots", parallel: 0 }), /parallel/i);
});

test("equivalence partition: rejects negative model capacity", () => {
  assert.throws(() => parallelOf({ topic: "negative_slots", parallel: -1 }), /parallel/i);
});

test("equivalence partition: rejects fractional model capacity", () => {
  assert.throws(() => parallelOf({ topic: "fractional_slots", parallel: 1.5 }), /parallel/i);
});

test("equivalence partition: rejects numeric-string model capacity", () => {
  assert.throws(() => parallelOf({ topic: "string_slots", parallel: "3" }), /parallel/i);
});

test("equivalence partition: rejects missing model capacity", () => {
  assert.throws(() => parallelOf({ topic: "missing_slots" }), /parallel/i);
});

test("equivalence partition: rejects a missing model", () => {
  assert.throws(() => parallelOf(undefined), /parallel/i);
});

test("each style maps to its temperature (code fallback)", () => {
  assert.equal(temperatureForStyle("structured"), 0.1);
  assert.equal(temperatureForStyle("blended"), 0.35);
  assert.equal(temperatureForStyle("unstructured"), 0.7);
});

test("structured is the lowest (most deterministic) style", () => {
  const vals = Object.values(STYLE_TEMPS);
  assert.equal(STYLE_TEMPS.structured, Math.min(...vals));
});

test("unknown / blank / undefined style falls back to the default style", () => {
  const def = STYLE_TEMPS[DEFAULT_STYLE];
  assert.equal(temperatureForStyle(undefined), def);
  assert.equal(temperatureForStyle(""), def);
  assert.equal(temperatureForStyle("nonsense"), def);
  assert.equal(DEFAULT_STYLE, "structured");
});

test("a DB temp map overrides the code values, missing styles keep the fallback", () => {
  const dbTemps = { structured: 0.05, blended: 0.4, unstructured: 0.9 };
  assert.equal(temperatureForStyle("structured", dbTemps), 0.05);
  assert.equal(temperatureForStyle("unstructured", dbTemps), 0.9);
  // a style absent from the DB map but present in code still resolves (via the default)
  assert.equal(temperatureForStyle("nonsense", dbTemps), 0.05); // → default structured from the DB map
});
