// The SEAM, not the unit. assemble.js was fully tested and still shipped broken twice: assembleFor
// was never imported into step.js, and `deps.getPrompts` did not exist, so the fallback ran every
// time and the section markers went to the model verbatim. Unit tests could not see either, because
// neither is reachable without building a real message through buildStepMessages.
//
// The invariant this file exists to hold: NO MARKER EVER REACHES THE MODEL.
import test from "node:test";
import assert from "node:assert/strict";
import { buildStepMessages } from "./step.js";

// DAMP ON PURPOSE. This file used to import SECTIONS and loop over it, so a renamed section was
// still checked consistently and the test stayed green while every stored `relatesTo` in Mongo went
// unrecognised. The markers and the layout are written out LONGHAND here — if one fails, a value
// that lives in the database is changing.
const MARKERS = ["{leading}", "{trailing}", "{conditions}", "{pass}", "{fail}"];
const withMarkers = (instruction, pass, fail) =>
  `{leading}\n${instruction}\n{trailing}\n{conditions}\n\nPass: ${pass}\n{pass}\nFail: ${fail}\n{fail}`;

const PROMPTS = [
  { mapping: { recipes: "a" }, content: "SYSTEM FRAGMENT", active: true },
  { mapping: { recipes: "m" }, content: "STATUS CONTRACT", relatesTo: "pass", active: true },
  { mapping: { recipes: "b" }, content: "OPENING LINE", relatesTo: "leading", active: true },
];

// loadStep reads the plan off the JOB DOC in Firestore (step.js:38-43), so the fake has to serve it
// there — a payload.plan is ignored, which is what made the first version of this test look broken.
const fakeDb = (instructions) => ({
  collection: () => ({
    doc: () => ({
      get: async () => ({ exists: true, data: () => ({ plan: [{ subtype: "recipes", instructions }] }) }),
      collection: () => ({
        doc: () => ({ get: async () => ({ exists: false }) }),
        where: () => ({ get: async () => ({ docs: [] }) }),
      }),
    }),
  }),
});

const build = async (instructions, extra = {}) =>
  buildStepMessages({ jobId: "j1", step: 0, unit: 0, subtype: "recipes" }, "", {
    getPrompts: async () => PROMPTS,
    systemPromptFor: async () => PROMPTS.map((p) => p.content).join("\n\n"),
    getFirestoreClient: () => fakeDb(instructions),
    ...extra,
  });

const textOf = (msgs) => (Array.isArray(msgs) ? msgs : msgs?.messages || []).map((m) => m?.content ?? "").join("\n");

test("no section marker survives into the built messages", async () => {
  const msgs = await build(withMarkers("DO THE THING", "PASSED", "FAILED"));
  const all = textOf(msgs);
  for (const m of MARKERS) assert.ok(!all.includes(m), `${m} reached the model`);
});

test("an anchored fragment lands in the instruction, not the system message", async () => {
  const msgs = await build(withMarkers("DO THE THING", "PASSED", "FAILED"));
  const all = textOf(msgs);
  assert.ok(all.includes("STATUS CONTRACT"), "the pass-anchored fragment is present somewhere");
  assert.ok(all.includes("OPENING LINE"), "the leading-anchored fragment is present somewhere");
  assert.ok(all.indexOf("OPENING LINE") < all.indexOf("DO THE THING"), "leading precedes the instruction");
  assert.ok(all.indexOf("PASSED") < all.indexOf("STATUS CONTRACT"), "the contract follows Pass");
});

// The bug that shipped: `deps` had no getPrompts, so the placement path never ran and the markers
// went to the model whole. Wiring is not something a unit test can guarantee, so the FALLBACK is
// made safe instead — no fragments placed, but never a marker in the prompt.
test("markers never survive even when getPrompts is not injected at all", async () => {
  const msgs = await build(withMarkers("DO THE THING", "PASSED", "FAILED"), { getPrompts: undefined });
  const all = textOf(msgs);
  for (const m of MARKERS) assert.ok(!all.includes(m), `${m} reached the model`);
  assert.ok(all.includes("DO THE THING"), "the instruction itself survives");
  assert.ok(all.includes("SYSTEM FRAGMENT"), "fragments still come from systemPromptFor");
});

test("an instruction with no markers is unchanged — every frozen plan", async () => {
  const msgs = await build("# Instructions\nplain old text");
  const all = textOf(msgs);
  assert.ok(all.includes("plain old text"));
  assert.ok(all.includes("SYSTEM FRAGMENT"), "all fragments fall back to the system message");
  assert.ok(all.includes("STATUS CONTRACT"), "including anchored ones");
});

// ---- Prompt SCOPE, at the seam ----------------------------------------------------------------
// The unit tests in config/promptSections.test.js prove inScope/fragmentsFor. This proves the wiring
// that makes them matter: the worker learns the pipeline from the JOB DOC's `type` (no new Pub/Sub
// field), and narrows the prompt library with it. If this is not wired, every scope test still
// passes and the worker still sends every prompt to every job — the exact failure mode this file
// was created for.
const SCOPED_PROMPTS = [
  { mapping: { recipes: "a" }, content: "LEGACY UNSCOPED PROMPT", active: true },
  { mapping: { recipes: "b" }, content: "TASK LIST ONLY PROMPT", scopes: ["task_list"], active: true },
  { mapping: { recipes: "c" }, content: "MENU PLAN ONLY PROMPT", scopes: ["menu_plan"], active: true },
];

const scopedDb = (jobType) => ({
  collection: () => ({
    doc: () => ({
      get: async () => ({ exists: true, data: () => ({ type: jobType, plan: [{ subtype: "recipes", instructions: "DO IT" }] }) }),
      collection: () => ({
        doc: () => ({ get: async () => ({ exists: false }) }),
        where: () => ({ get: async () => ({ docs: [] }) }),
      }),
    }),
  }),
});

const buildScoped = async (jobType, deps = {}) =>
  textOf(await buildStepMessages({ jobId: "j1", step: 0, unit: 0, subtype: "recipes" }, "", {
    getPrompts: async () => SCOPED_PROMPTS,
    systemPromptFor: async () => { throw new Error("unused when getPrompts is injected"); },
    getFirestoreClient: () => scopedDb(jobType),
    ...deps,
  }));

test("BACKWARD COMPAT at the seam: a meal-plan job still gets the unscoped prompts", async () => {
  for (const jobType of ["plan", "meal_plan", undefined]) {
    const all = await buildScoped(jobType);
    assert.ok(all.includes("LEGACY UNSCOPED PROMPT"), `job type ${jobType} lost the unscoped prompt`);
    assert.ok(all.includes("MENU PLAN ONLY PROMPT"), `job type ${jobType} lost its menu_plan prompt`);
    assert.ok(!all.includes("TASK LIST ONLY PROMPT"), `job type ${jobType} picked up a task-list prompt`);
  }
});

test("a tquery job gets ONLY the task_list prompts — same subtype, different prompt text", async () => {
  const all = await buildScoped("tquery");
  assert.ok(all.includes("TASK LIST ONLY PROMPT"), "the task-list prompt was not applied");
  assert.ok(!all.includes("MENU PLAN ONLY PROMPT"), "a menu_plan prompt leaked into a task list");
  assert.ok(!all.includes("LEGACY UNSCOPED PROMPT"), "an unscoped (legacy meal-plan) prompt leaked into a task list");
});

test("the no-getPrompts fallback path is scoped too — systemPromptFor receives the scope", async () => {
  const seen = [];
  await buildStepMessages({ jobId: "j1", step: 0, unit: 0, subtype: "recipes" }, "", {
    systemPromptFor: async (type, scope) => { seen.push([type, scope]); return ""; },
    getFirestoreClient: () => scopedDb("tquery"),
  });
  assert.deepEqual(seen, [["recipes", "task_list"]]);
});

test("a subtype builder is handed the scope, so compliance resolves per pipeline", async () => {
  const seen = [];
  await buildStepMessages({ jobId: "j1", step: 0, unit: 0, subtype: "recipes" }, "", {
    getPrompts: async () => SCOPED_PROMPTS,
    getFirestoreClient: () => scopedDb("tquery"),
    subtypeBuilders: { recipes: async ({ scope }) => { seen.push(scope); return []; } },
  });
  assert.deepEqual(seen, ["task_list"]);
});
