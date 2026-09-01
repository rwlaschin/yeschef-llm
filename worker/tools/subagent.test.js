import test from "node:test";
import assert from "node:assert/strict";
import { SubAgent, runSubAgent, SUB_AGENT_TOOL_NAME } from "./subagent.js";
import { DEFAULT_TOOLS } from "../../config/tools.js";

// A stub `chat` that records exactly what the child call was handed. No Ollama, no socket.
function stubChat(reply = "looks fine\n@@::PASS::@@") {
  const seen = [];
  const chat = async (messages, tools, onChunk, numCtx, opts) => {
    seen.push({ messages, tools, onChunk, numCtx, opts });
    if (reply instanceof Error) throw reply;
    return { content: reply };
  };
  return { chat, seen };
}

const sub = (over = {}) => new SubAgent({ numCtx: 8192, sampler: { temperature: 0.2 }, ...over });
// A caller-written prompt. This is a test fixture, not a product prompt — the product's wording is
// whatever the calling model writes at call time.
const PROMPT = "Check this table for repeated dishes.\n\n| Day | Dish |\n| Mon | Stew |";

test("a call at depth greater than zero is refused without a child call", async () => {
  const { chat, seen } = stubChat();
  const out = await runSubAgent(sub({ depth: 1 }), { chat, args: { prompt: PROMPT } });
  assert.match(out.error, /not available inside a sub_agent call/);
  assert.equal(seen.length, 0);
});

// No default prompt exists in the code: with none supplied the tool refuses rather than invents one.
for (const [label, args] of [
  ["no args at all", undefined],
  ["an empty args object", {}],
  ["a blank prompt", { prompt: "   \n  " }],
  ["a null prompt", { prompt: null }],
]) {
  test(`${label} is refused rather than answered from an invented prompt`, async () => {
    const { chat, seen } = stubChat();
    const s = sub();
    const out = await runSubAgent(s, { chat, args });
    assert.match(out.error, /needs a `prompt`/);
    assert.equal(seen.length, 0);
    assert.equal(s.calls.length, 0);
  });
}

// The prompt is found by ROLE, never by position — a system message may or may not precede it.
// "0" is falsy: the guard must still treat it as a real prompt.
test("the caller's prompt is sent verbatim as the only user message, even when falsy", async () => {
  const { chat, seen } = stubChat();
  await runSubAgent(sub(), { chat, args: { prompt: "0" } });
  assert.deepEqual(seen[0].messages.filter((m) => m.role === "user"), [{ role: "user", content: "0" }]);
});

// The tool adds NOTHING to the prompt — no system message, no label, no configured preamble. The
// caller's string is the child's entire input, so any wording the child needs is the caller's to
// write and the caller's to change. This is the assertion that keeps it a general tool.
test("the caller's prompt is the child's entire input — nothing is added to it", async () => {
  const { chat, seen } = stubChat();
  await runSubAgent(sub(), { chat, args: { prompt: PROMPT } });
  assert.deepEqual(seen[0].messages, [{ role: "user", content: PROMPT }]);
});

test("the child is handed the tools slot it was constructed with", async () => {
  const { chat, seen } = stubChat();
  const toolDefs = [{ type: "function", function: { name: "web_fetch" } }];
  await runSubAgent(new SubAgent({ numCtx: 8192, sampler: {}, toolDefs }), { chat, args: { prompt: PROMPT } });
  assert.deepEqual(seen[0].tools, toolDefs);
  const bare = stubChat();
  await runSubAgent(sub(), { chat: bare.chat, args: { prompt: PROMPT } });
  assert.equal(bare.seen[0].tools, undefined);
});

test("the child's output never reaches the parent's stream", async () => {
  const { chat, seen } = stubChat();
  const parentBuffer = [];
  const parentOnChunk = (piece) => parentBuffer.push(piece);
  await runSubAgent(sub(), { chat, args: { prompt: PROMPT } });
  assert.notEqual(seen[0].onChunk, parentOnChunk);
  await seen[0].onChunk("child text", "child text");
  assert.equal(parentBuffer.length, 0);
});

test("every call is recorded in order with what was sent and what came back", async () => {
  const s = sub();
  await runSubAgent(s, { chat: stubChat("first\n@@::PASS::@@").chat, args: { prompt: "prompt one" } });
  await runSubAgent(s, { chat: stubChat("second\n@@::FAIL:row 1 repeats::@@").chat, args: { prompt: "prompt two" } });
  assert.deepEqual(s.calls.map((c) => c.n), [1, 2]);
  assert.deepEqual(s.calls.map((c) => c.sent.prompt), ["prompt one", "prompt two"]);
  assert.deepEqual(s.calls.map((c) => c.got), [
    { response: "first\n@@::PASS::@@" },
    { response: "second\n@@::FAIL:row 1 repeats::@@" },
  ]);
  assert.deepEqual(s.snapshot(), { calls: s.calls });
});

test("the record carries the trigger and a measured duration", async () => {
  const s = sub();
  await runSubAgent(s, { chat: stubChat().chat, args: { prompt: PROMPT }, trigger: "model" });
  assert.equal(s.calls[0].trigger, "model");
  assert.equal(typeof s.calls[0].ms, "number");
  assert.ok(s.calls[0].ms >= 0);
  assert.match(s.calls[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test("a child call that throws is recorded with an error, not silently dropped", async () => {
  const { chat } = stubChat(new Error("ollama stalled"));
  const s = sub();
  const out = await runSubAgent(s, { chat, args: { prompt: PROMPT } });
  assert.equal(out.error, "ollama stalled");
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].error, "ollama stalled");
  assert.equal(s.calls[0].got, null);
});

// The tool decides nothing about the child's output format. A status marker in the reply is the
// caller's to parse; this tool must return the text either way and add no verdict field.
test("the reply comes back as text, with no verdict field added either way", async () => {
  for (const reply of ["No marker here at all.", "done\n@@::PASS::@@"]) {
    const s = sub();
    const out = await runSubAgent(s, { chat: stubChat(reply).chat, args: { prompt: PROMPT } });
    assert.deepEqual(out, { response: reply });
    assert.deepEqual(s.calls[0].got, { response: reply });
  }
});

// The schema is NOT locked to one property — a general tool must be free to gain an optional
// argument. What must hold is that `prompt` is the required one and it is a string.
test("sub_agent requires the prompt and nothing else", () => {
  const def = DEFAULT_TOOLS.find((t) => t.name === SUB_AGENT_TOOL_NAME);
  assert.ok(def, "sub_agent missing from DEFAULT_TOOLS");
  assert.deepEqual(def.parameters.required, ["prompt"]);
  assert.equal(def.parameters.properties.prompt.type, "string");
  assert.match(def.name, /^[a-z]+(_[a-z]+)*$/);
});
