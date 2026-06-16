// Unit tests for the PURE step helpers — no mocks needed (nothing external to mock).
// Run: node --test worker/steps
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessages, estimateTokens, sizeNumCtx, TerminalError } from "./step.js";

test("buildMessages: system + context become one system message; query is the user message", () => {
  const m = buildMessages("SYS", "hello", "CTX");
  assert.equal(m.length, 2);
  assert.equal(m[0].role, "system");
  assert.match(m[0].content, /SYS/);
  assert.match(m[0].content, /# Context\nCTX/);
  assert.equal(m[1].role, "user");
  assert.equal(m[1].content, "hello");
});

test("buildMessages: no system prompt and no context → user message only", () => {
  const m = buildMessages("", "hi", "");
  assert.equal(m.length, 1);
  assert.equal(m[0].role, "user");
  assert.equal(m[0].content, "hi");
});

test("estimateTokens: conservative char-based estimate (ceil)", () => {
  assert.equal(estimateTokens("x".repeat(3500), 3.5), 1000);
  assert.equal(estimateTokens("", 3.5), 0);
  assert.equal(estimateTokens(undefined, 3.5), 0);
});

test("sizeNumCtx: prompt tokens + output reserve + 15% buffer, when above the floor", () => {
  const messages = [{ content: "x".repeat(3500) }]; // ~1000 tokens @ 3.5 cpt
  const n = sizeNumCtx({ messages, modelMaxCtx: 131072, outputReserve: 4096, charsPerToken: 3.5, floor: 2048 });
  // need = 1000 + 4096 = 5096; buffer = clamp(ceil(5096*0.15)=765, [256,1024]) = 765 → 5861
  assert.equal(n, 5096 + 765);
});

test("sizeNumCtx: never returns below the floor", () => {
  const n = sizeNumCtx({ messages: [{ content: "hi" }], modelMaxCtx: 131072, outputReserve: 100, floor: 8192 });
  assert.equal(n, 8192);
});

test("sizeNumCtx: throws TerminalError when need exceeds the model cap", () => {
  const messages = [{ content: "x".repeat(3500) }]; // ~1000 tokens
  assert.throws(
    () => sizeNumCtx({ messages, modelMaxCtx: 4096, outputReserve: 4096, charsPerToken: 3.5 }),
    (e) => e instanceof TerminalError && e.terminal === true && /context too large/.test(e.message)
  );
});

test("sizeNumCtx: no cap (modelMaxCtx falsy) → never throws, returns need + buffer (above floor)", () => {
  const messages = [{ content: "x".repeat(7000) }]; // ~2000 tokens @ 3.5 cpt
  const n = sizeNumCtx({ messages, modelMaxCtx: null, outputReserve: 4096, charsPerToken: 3.5, floor: 2048 });
  // need = 2000 + 4096 = 6096 > floor; buffer = clamp(ceil(6096*0.15)=915, [256,1024]) = 915 → 7011, no cap
  assert.equal(n, 6096 + 915);
});
