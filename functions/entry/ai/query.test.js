// resolveTopic picks the copilot's dispatch topic: the cheapest gpu:1 tier in EVERY env (the
// cost model's g2-standard-8 Q&A/Remy line — never the 2×L4 70B by default) unless the caller
// passes a topic, which must exist and be provisioned for the env (prod-only gpu:2 tiers have
// no dev topic → rejected off-prod).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveTopic } from "./query.js";
import { MODELS } from "../../config/models.js";

const DEV_TOPIC  = MODELS.find((m) => m.dev).topic;
const PROD_TOPIC = MODELS.find((m) => !m.dev).topic;

let envPrev;
beforeEach(() => {
  envPrev = { N: process.env.NODE_ENV, K: process.env.K_SERVICE };
  process.env.NODE_ENV = "test";
  delete process.env.K_SERVICE;
});
afterEach(() => {
  if (envPrev.N === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = envPrev.N;
  if (envPrev.K === undefined) delete process.env.K_SERVICE; else process.env.K_SERVICE = envPrev.K;
});

test("default = the cheapest gpu:1 tier in every env (the g2-8 Q&A/Remy line)", () => {
  assert.equal(resolveTopic(undefined), DEV_TOPIC);
  process.env.NODE_ENV = "production";
  assert.equal(resolveTopic(undefined), DEV_TOPIC);
});

test("K_SERVICE is NOT a prod signal — the emulator sets it too, so it must NOT unlock a prod-only topic", () => {
  process.env.K_SERVICE = "ai"; // NODE_ENV still non-prod (beforeEach sets "test")
  assert.equal(resolveTopic(PROD_TOPIC), null);
});

test("a requested dev-capable topic is honored in any env", () => {
  assert.equal(resolveTopic(DEV_TOPIC), DEV_TOPIC);
  process.env.NODE_ENV = "production";
  assert.equal(resolveTopic(DEV_TOPIC), DEV_TOPIC);
});

test("a prod-only topic is rejected off-prod, honored in prod", () => {
  assert.equal(resolveTopic(PROD_TOPIC), null);
  process.env.NODE_ENV = "production";
  assert.equal(resolveTopic(PROD_TOPIC), PROD_TOPIC);
});

test("an unknown topic is rejected in any env", () => {
  assert.equal(resolveTopic("nope_v1"), null);
  process.env.NODE_ENV = "production";
  assert.equal(resolveTopic("nope_v1"), null);
});
