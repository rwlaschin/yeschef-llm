import { test } from "node:test";
import assert from "node:assert/strict";
import { STYLE_TEMPS, DEFAULT_STYLE, temperatureForStyle } from "./models.js";

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
