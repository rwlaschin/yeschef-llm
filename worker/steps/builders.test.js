// Contract tests for the step builders. Per our testing rule, the only things faked here are
// the MONGO/FIRESTORE-backed helpers (systemPromptFor, getTools, getSubtypes, retrieveContext,
// getFirestoreClient) — i.e. the third-party boundary. The builder logic itself is real.
// Run: node --test worker/steps/step.test.js worker/steps/builders.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlannerMessages } from "./planner.js";
import { buildComplianceMessages } from "./compliance.js";
import { buildStepMessages } from "./step.js";
import { unitDocId } from "../../config/models.js";

// A minimal fake Firestore for the step path: the job doc carries plan[];
// jobDoc.collection("steps").where(...).get() returns ALL prior-step runs (whole-step context), and
// .doc(id).get() returns one unit's run keyed by its doc id (per-unit context, used by `chain`).
const docOf = (obj) => ({ data: () => obj });
function fakeDb({ plan = [], runs = [], unitDocs = {} } = {}) {
  const steps = {
    where: () => ({ get: async () => ({ docs: runs }) }),
    doc: (id) => ({ get: async () => {
      const d = unitDocs[id];
      return d ? { exists: true, data: () => d } : { exists: false, data: () => null };
    } }),
  };
  return {
    collection: () => ({                       // .collection("llmResults")
      doc: () => ({                            // .doc(jobId)
        get: async () => ({ exists: true, data: () => ({ plan }) }),
        collection: () => steps,               // jobDoc.collection("steps")
      }),
    }),
  };
}

test("planner: system is the planner prompt; user carries model, tools, subtypes, and the prompt", async () => {
  const deps = {
    systemPromptFor: async (t) => `PROMPT:${t}`,
    getTools: async () => "  - web_search: search the web",
    getSubtypes: async () => "  - menu_plan: build a meal plan",
  };
  const msgs = await buildPlannerMessages({ model: "llama3_1_8b_v1", query: "plan a menu" }, "", deps);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[0].content, "PROMPT:planner");
  assert.equal(msgs[1].role, "user");
  assert.match(msgs[1].content, /# Model\nllama3_1_8b_v1/);
  assert.match(msgs[1].content, /web_search/);
  assert.match(msgs[1].content, /menu_plan/);
  assert.match(msgs[1].content, /# User Prompt\nplan a menu/);
});

test("compliance: forces RAG on the step instructions and injects it as context", async () => {
  let ragQuery = null;
  const msgs = await buildComplianceMessages({
    payload: {},
    def: { subtype: "compliance", instructions: "check allergen labelling", contexts: [] },
    ctxBlocks: [],
    context: "", // handler attached none → compliance must fetch it
    deps: {
      systemPromptFor: async (t) => `SYS:${t}`,
      retrieveContext: async (q) => { ragQuery = q; return "REGULATION TEXT"; },
    },
  });
  assert.equal(ragQuery, "check allergen labelling");      // RAG ran, on the instructions
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[0].content, /SYS:compliance/);
  assert.match(msgs[0].content, /REGULATION TEXT/);         // regulations folded into the system msg
  assert.match(msgs[1].content, /check allergen labelling/);
});

test("compliance: if the handler already attached context, RAG is NOT re-fetched", async () => {
  let ragCalled = false;
  const msgs = await buildComplianceMessages({
    payload: {},
    def: { subtype: "compliance", instructions: "verify sodium limits", contexts: [] },
    ctxBlocks: [],
    context: "PRELOADED",
    deps: {
      systemPromptFor: async (t) => `SYS:${t}`,
      retrieveContext: async () => { ragCalled = true; return "X"; },
    },
  });
  assert.equal(ragCalled, false);
  assert.match(msgs[0].content, /PRELOADED/);
});

test("step dispatch: a compliance-subtype step routes to the compliance builder (forced RAG)", async () => {
  let ragRan = false;
  const deps = {
    getFirestoreClient: () => fakeDb({ plan: [{ subtype: "compliance", instructions: "check X", contexts: [] }] }),
    systemPromptFor: async (t) => `SYS:${t}`,
    retrieveContext: async () => { ragRan = true; return "REG"; },
    subtypeBuilders: { compliance: buildComplianceMessages },
  };
  const msgs = await buildStepMessages({ jobId: "j", step: 0 }, "", deps);
  assert.equal(ragRan, true);                  // proves it took the compliance path
  assert.match(msgs[0].content, /REG/);
  assert.match(msgs[1].content, /check X/);
});

test("step dispatch: an unregistered subtype uses the generic assembly (no RAG)", async () => {
  let ragRan = false;
  const deps = {
    getFirestoreClient: () => fakeDb({ plan: [{ subtype: "nutrition", instructions: "calc calories", contexts: [] }] }),
    systemPromptFor: async (t) => `SYS:${t}`,
    retrieveContext: async () => { ragRan = true; return "REG"; },
    subtypeBuilders: { compliance: buildComplianceMessages },
  };
  const msgs = await buildStepMessages({ jobId: "j", step: 0 }, "", deps);
  assert.equal(ragRan, false);                 // generic path → no forced RAG
  assert.match(msgs[0].content, /SYS:nutrition/);
  assert.match(msgs[1].content, /calc calories/);
});

test("chain step: a unit reads ONLY the source step's matching unit (per-unit context)", async () => {
  const plan = [
    { subtype: "menu_plan", kind: "fanout", instructions: "menu", contexts: [], items: [1, 2, 3] },
    { subtype: "recipe",    kind: "chain",  instructions: "recipe", contexts: [0], items: [1, 2, 3] },
  ];
  const unitDocs = {
    [unitDocId(0, 0)]: { step: 0, response: "MENU-DAY-1" },
    [unitDocId(0, 1)]: { step: 0, response: "MENU-DAY-2" },
    [unitDocId(0, 2)]: { step: 0, response: "MENU-DAY-3" },
  };
  const deps = {
    // runs (whole-step) is deliberately ALL days — proves chain ignores it and fetches just its unit.
    getFirestoreClient: () => fakeDb({ plan, unitDocs, runs: Object.values(unitDocs).map(docOf) }),
    systemPromptFor: async () => "",
    subtypeBuilders: {},
  };
  const user = (await buildStepMessages({ jobId: "j", step: 1, unit: 1 }, "", deps)).at(-1).content;
  assert.match(user, /MENU-DAY-2/);            // its own unit
  assert.doesNotMatch(user, /MENU-DAY-1/);     // not its siblings
  assert.doesNotMatch(user, /MENU-DAY-3/);
});

test("non-chain step with context gets the WHOLE source step (all units joined)", async () => {
  const plan = [
    { subtype: "menu_plan", kind: "fanout",      instructions: "menu", contexts: [] },
    { subtype: "inventory", kind: "aggregation", instructions: "inv",  contexts: [0] },
  ];
  const runs = [docOf({ step: 0, response: "DAY-1" }), docOf({ step: 0, response: "DAY-2" })];
  const deps = {
    getFirestoreClient: () => fakeDb({ plan, runs }),
    systemPromptFor: async () => "",
    subtypeBuilders: {},
  };
  const user = (await buildStepMessages({ jobId: "j", step: 1, unit: 0 }, "", deps)).at(-1).content;
  assert.match(user, /DAY-1/);
  assert.match(user, /DAY-2/);                 // gets every unit, not just one
});
