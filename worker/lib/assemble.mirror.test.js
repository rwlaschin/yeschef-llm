// What compose EMITS must be what assembly SUBSTITUTES. Those are the two halves that have to agree
// for a prompt to leave the system intact, and they live in different processes — compose.js runs in
// the Firebase function, assembleFor runs in the worker.
//
// This file used to compare a worker copy of the assembler against a dashboard copy. That test is
// gone because the duplication is gone: config/promptSections.js holds the ONE implementation and
// both sides import it, so "they agree" is now true by construction rather than by assertion.
//
// DAMP ON PURPOSE. Every section name and the whole layout are written out LONGHAND. Importing
// SECTIONS and building fixtures from it made the old version self-referential: the constant and the
// assertion moved together, so a rename stayed green while every stored `relatesTo` in Mongo
// silently became unrecognised. If one of these fails, a value that lives in the DATABASE is
// changing and the fragments carrying the old name need migrating.
import test from "node:test";
import assert from "node:assert/strict";
import { assembleFor, withMarkers } from "./assemble.js";
import { composeFromDefs, renderUnit } from "../../functions/entry/ai/compose.js";

const p = (order, content, relatesTo) => ({
  mapping: { recipes: order }, content, active: true, ...(relatesTo ? { relatesTo } : {}),
});

const LAYOUT = "{leading}\nI\n{trailing}\n{conditions}\n\nPass: P\n{pass}\nFail: F\n{fail}";

test("withMarkers builds the one true layout", () => {
  assert.equal(withMarkers("I", "P", "F"), LAYOUT);
});

test("renderUnit emits exactly that layout, from a real composed FANNED step", () => {
  const step = composeFromDefs(
    [{ name: "S", subtype: "recipes", kind: "fanout", mapOf: "diets as |d|",
       instruction: "I", pass: "P", fail: "F" }],
    { values: { diets: "standard, diabetic" } },
    { isProd: false },
  )[0];
  assert.equal(renderUnit(step, 0), LAYOUT);
});

// The non-fanned branch builds its instruction on a DIFFERENT code path (compose.js, the `else` of
// the fanned check). It shipped without markers, which made placement silently do nothing on every
// single-diet plan — same records, same step, structurally different prompt, no signal anywhere.
test("a NON-fanned step emits the same layout — placement is not a fan-out-only feature", () => {
  const step = composeFromDefs(
    [{ name: "S", subtype: "recipes", kind: "task", instruction: "I", pass: "P", fail: "F" }],
    { values: {} },
    { isProd: false },
  )[0];
  assert.equal(step.instructions, LAYOUT);
});

test("a single-ITEM fan-out is also non-fanned, and still emits the layout", () => {
  const step = composeFromDefs(
    [{ name: "S", subtype: "recipes", kind: "fanout", mapOf: "diets as |d|",
       instruction: "I", pass: "P", fail: "F" }],
    { values: { diets: "standard" } },   // one diet → items.length === 1 → the else branch
    { isProd: false },
  )[0];
  assert.equal(step.instructions, LAYOUT);
});

// Every marker compose emits must be one assembly knows how to substitute. If the two lists drift,
// the orphan marker is emitted and never replaced — it reaches the model verbatim.
test("every marker compose emits is substituted away by assembly", () => {
  const step = composeFromDefs(
    [{ name: "S", subtype: "recipes", kind: "task", instruction: "BODY", pass: "P", fail: "F" }],
    { values: {} },
    { isProd: false },
  )[0];
  const out = assembleFor([p("a", "SYS")], "recipes", step.instructions);
  assert.equal(out.instructions.match(/\{[a-z]+\}/g), null, "a marker survived assembly");
  assert.ok(out.instructions.includes("BODY"));
});
