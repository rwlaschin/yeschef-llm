// events.js routes the `orchestrate` topic push by action through the HANDLERS lookup. This covers
// the NEW `outcome` route (worker job DONE → capacity controller). We drive the real post() with a
// Pub/Sub-shaped envelope and assert it reaches the handler (not the unknown-action drop path).
//
// Off-prod is pinned so handleOutcomeEvent → onOutcome short-circuits BEFORE any Mongo access (see
// controller.onOutcome's isProdLike gate) — the route wiring is what's under test here, not the store.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { post } from "./events.js";

// A Pub/Sub push req: message.data is the base64 JSON payload.
function req(payload) {
  return { body: { message: { data: Buffer.from(JSON.stringify(payload)).toString("base64") } } };
}
// A minimal Fastify reply: records the status code; send() resolves the chain.
function reply() {
  const r = { statusCode: null, code(c) { this.statusCode = c; return this; }, send() { return this; } };
  return r;
}

let envPrev;
beforeEach(() => {
  envPrev = { N: process.env.NODE_ENV, K: process.env.K_SERVICE };
  process.env.NODE_ENV = "test"; // not prod → onOutcome no-ops without Mongo
  delete process.env.K_SERVICE;
});
afterEach(() => {
  if (envPrev.N === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = envPrev.N;
  if (envPrev.K === undefined) delete process.env.K_SERVICE; else process.env.K_SERVICE = envPrev.K;
});

test("post routes action=outcome to the capacity handler (acks 204, no throw)", async () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const rep = reply();
    await post(req({ action: "outcome", jobId: "j1", region: "us-west1", status: "success" }), rep);
    assert.equal(rep.statusCode, 204, "acked the push");
    // The success log proves the handler ran to completion — i.e. the route matched, not the
    // unknown-action drop path (which logs "no handler for action=outcome" instead).
    assert.ok(logs.some((l) => l.includes("✓ handled action=outcome")), "reached the outcome handler");
    assert.ok(!logs.some((l) => l.includes("no handler for action=outcome")), "did not drop as unknown");
  } finally {
    console.log = orig;
  }
});

test("post acks an unknown action without a handler (204, dropped)", async () => {
  const rep = reply();
  await post(req({ action: "nope", jobId: "j2" }), rep);
  assert.equal(rep.statusCode, 204);
});
