// Tests for the capacity recorder (docs/plans/capacity-steering/plan.md). Pure — injected incOk/
// incFail, no Mongo/GCP. Fixtures mirror the REAL compute.instances.insert operation shape verified
// against prod logs 2026-07-16 (zone in protoPayload.resourceName; status.message set = failure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { regionFromInsertOp, isWorkerInsertCompletion, recordCreateOutcome, handleLogPubSub } from "./recorder.js";

const b64 = (obj) => ({ data: Buffer.from(JSON.stringify(obj)).toString("base64") });

const OK_ENTRY = {
  timestamp: "2026-07-16T02:10:00Z",
  operation: { last: true },
  protoPayload: { methodName: "v1.compute.instances.insert", resourceName: "projects/38637528569/zones/us-west4-c/instances/ollama-llama3-1-8b-v1-mig-tc0k" },
};
const FAIL_ENTRY = {
  timestamp: "2026-07-16T02:05:00Z",
  operation: { last: true },
  protoPayload: { methodName: "v1.compute.instances.insert", resourceName: "projects/38637528569/zones/us-east1-b/instances/ollama-llama3-1-8b-v1-mig-5z0h", status: { message: "ZONE_RESOURCE_POOL_EXHAUSTED" } },
};

function spy() {
  const calls = { incOk: [], incFail: [] };
  return { deps: { async incOk(r, t) { calls.incOk.push([r, t]); }, async incFail(r, t) { calls.incFail.push([r, t]); } }, calls };
}

test("regionFromInsertOp: zone in resourceName → region (drops -letter)", () => {
  assert.equal(regionFromInsertOp(OK_ENTRY), "us-west4");
  assert.equal(regionFromInsertOp(FAIL_ENTRY), "us-east1");
});

test("regionFromInsertOp: falls back to resource.labels.zone when resourceName has none", () => {
  const entry = { protoPayload: { resourceName: "projects/x/instances/foo-mig-1" }, resource: { labels: { zone: "us-central1-a" } } };
  assert.equal(regionFromInsertOp(entry), "us-central1");
});

test("regionFromInsertOp: no zone anywhere → null", () => {
  assert.equal(regionFromInsertOp({}), null);
  assert.equal(regionFromInsertOp({ protoPayload: {} }), null);
});

test("isWorkerInsertCompletion: completion of any worker MIG insert", () => {
  assert.equal(isWorkerInsertCompletion(OK_ENTRY), true);
  assert.equal(isWorkerInsertCompletion({ ...OK_ENTRY, operation: { last: false } }), false);
  const fakeWorker = {
    operation: { last: true },
    protoPayload: { methodName: "v1.compute.instances.insert", resourceName: "projects/x/zones/us-west4-c/instances/worker-fake-canned-v1-mig-tc0k" }
  };
  assert.equal(isWorkerInsertCompletion(fakeWorker), true);
  assert.equal(isWorkerInsertCompletion({ operation: { last: true }, protoPayload: { methodName: "v1.compute.instances.insert", resourceName: "projects/x/zones/us-west4-c/instances/some-other-vm" } }), false);
});

test("recordCreateOutcome: successful create → recorded but NOT counted (ok = job success only)", async () => {
  const { deps, calls } = spy();
  assert.deepEqual(await recordCreateOutcome(OK_ENTRY, Date.now(), deps), { region: "us-west4", outcome: "created" });
  assert.equal(calls.incOk.length, 0); // a booted instance is not a value signal — no ok increment
  assert.equal(calls.incFail.length, 0);
});

test("recordCreateOutcome: real stockout → incFail(region)", async () => {
  const { deps, calls } = spy();
  assert.deepEqual(await recordCreateOutcome(FAIL_ENTRY, Date.now(), deps), { region: "us-east1", outcome: "fail" });
  assert.equal(calls.incFail.length, 1);
  assert.equal(calls.incFail[0][0], "us-east1");
  assert.equal(calls.incOk.length, 0);
});

test("recordCreateOutcome: non-worker insert → null, no write", async () => {
  const { deps, calls } = spy();
  const other = { operation: { last: true }, protoPayload: { methodName: "v1.compute.instances.insert", resourceName: "projects/x/zones/us-west4-c/instances/ycl-captest-ok" } };
  assert.equal(await recordCreateOutcome(other, Date.now(), deps), null);
  assert.equal(calls.incOk.length + calls.incFail.length, 0);
});

test("recordCreateOutcome: non-completion (operation.last false) → null", async () => {
  const { deps } = spy();
  assert.equal(await recordCreateOutcome({ ...OK_ENTRY, operation: { last: false } }, Date.now(), deps), null);
});

test("recordCreateOutcome: worker-insert completion with no resolvable zone → null, no write", async () => {
  const { deps, calls } = spy();
  const noZone = { operation: { last: true }, protoPayload: { methodName: "v1.compute.instances.insert", resourceName: "projects/x/instances/ycl-worker-mig-abcd" } };
  assert.equal(await recordCreateOutcome(noZone, Date.now(), deps), null);
  assert.equal(calls.incOk.length + calls.incFail.length, 0);
});

test("recordCreateOutcome: swallows a thrown store error (never rethrows)", async () => {
  const deps = { async incFail() { throw new Error("mongo down"); } };
  assert.equal(await recordCreateOutcome(FAIL_ENTRY, Date.now(), deps), null);
});

test("recordCreateOutcome: missing/unparseable timestamp → falls back to nowMs", async () => {
  const { deps, calls } = spy();
  const now = 1_700_000_000_000;
  const { timestamp, ...noTs } = FAIL_ENTRY;
  await recordCreateOutcome(noTs, now, deps);
  assert.equal(calls.incFail[0][1], now); // no entry timestamp → uses nowMs
  const bad = await recordCreateOutcome({ ...FAIL_ENTRY, timestamp: "not-a-date" }, now, deps);
  assert.equal(bad.outcome, "fail");
  assert.equal(calls.incFail[1][1], now); // Date.parse → NaN → nowMs
});

// ---- handleLogPubSub: the Cloud Logging sink → Pub/Sub adapter -------------------------------
test("handleLogPubSub: decodes a base64 LogEntry → records via recordCreateOutcome", async () => {
  const { deps, calls } = spy();
  const r = await handleLogPubSub(b64(FAIL_ENTRY), Date.now(), deps);
  assert.deepEqual(r, { region: "us-east1", outcome: "fail" });
  assert.equal(calls.incFail.length, 1);
});

test("handleLogPubSub: message with no data → null (nothing to decode)", async () => {
  const { deps } = spy();
  assert.equal(await handleLogPubSub({}, Date.now(), deps), null);
  assert.equal(await handleLogPubSub(null, Date.now(), deps), null);
});

test("handleLogPubSub: non-worker entry → null, no write, no throw", async () => {
  const { deps, calls } = spy();
  const other = { operation: { last: true }, protoPayload: { methodName: "v1.compute.instances.insert", resourceName: "projects/x/zones/us-west4-c/instances/not-a-worker" } };
  assert.equal(await handleLogPubSub(b64(other), Date.now(), deps), null);
  assert.equal(calls.incOk.length + calls.incFail.length, 0);
});

test("handleLogPubSub: undecodable / empty message → null (swallowed)", async () => {
  assert.equal(await handleLogPubSub(undefined), null);
  assert.equal(await handleLogPubSub({ data: "!!!not-base64-json!!!" }), null);
});

// ---- handleDetectMessage: shim detect-message with durable messageId dedup -------------------
import { handleDetectMessage } from "./recorder.js";
function detectSpy(seen = new Set()) {
  const calls = { detected: [] };
  const deps = {
    async markMessageSeen(id) { if (seen.has(id)) return false; seen.add(id); return true; },
    async onMessageDetected(topic) { calls.detected.push(topic); return { wouldOpen: "us-west1" }; },
  };
  return { deps, calls };
}
const jobMsg = (id, model) => ({ messageId: id, data: Buffer.from(JSON.stringify({ jobId: "j", model })).toString("base64") });

test("handleDetectMessage: first sighting → detects the model topic", async () => {
  const { deps, calls } = detectSpy();
  const r = await handleDetectMessage(jobMsg("m1", "llama3_1_8b_v1"), Date.now(), deps);
  assert.equal(r.detected, "llama3_1_8b_v1");
  assert.deepEqual(calls.detected, ["llama3_1_8b_v1"]);
});

test("handleDetectMessage: redelivery/replay of same messageId → dup, no re-detect", async () => {
  const { deps, calls } = detectSpy();
  await handleDetectMessage(jobMsg("m1", "llama3_1_8b_v1"), Date.now(), deps);
  const r = await handleDetectMessage(jobMsg("m1", "llama3_1_8b_v1"), Date.now(), deps);
  assert.deepEqual(r, { dup: true });
  assert.equal(calls.detected.length, 1); // still once
});

test("handleDetectMessage: fake tier is a real model → still detected (not excluded)", async () => {
  const { deps, calls } = detectSpy();
  const r = await handleDetectMessage(jobMsg("m2", "fake_canned_v1"), Date.now(), deps);
  assert.equal(r.detected, "fake_canned_v1");
  assert.deepEqual(calls.detected, ["fake_canned_v1"]);
});

test("handleDetectMessage: no messageId or no topic → null, no throw", async () => {
  const { deps } = detectSpy();
  assert.equal(await handleDetectMessage({ data: Buffer.from('{"model":"x"}').toString("base64") }, Date.now(), deps), null);
  assert.equal(await handleDetectMessage({ messageId: "m3" }, Date.now(), deps), null);
});

test("handleDetectMessage: dedup store unreachable → dedupError, no detect (distinct from no-traffic)", async () => {
  const { deps, calls } = detectSpy();
  deps.markMessageSeen = async () => { throw new Error("mongo down"); };
  const r = await handleDetectMessage(jobMsg("m4", "llama3_1_8b_v1"), Date.now(), deps);
  assert.deepEqual(r, { dedupError: true });
  assert.equal(calls.detected.length, 0); // never reached decision/log
});

test("handleDetectMessage: a throw past dedup is swallowed → null, never rethrows", async () => {
  const { deps } = detectSpy();
  deps.onMessageDetected = async () => { throw new Error("controller blew up"); };
  assert.equal(await handleDetectMessage(jobMsg("m5", "llama3_1_8b_v1"), Date.now(), deps), null);
});

test("handleDetectMessage: empty decision from controller → detected with wouldOpen null", async () => {
  const { deps } = detectSpy();
  deps.onMessageDetected = async () => undefined; // controller returned nothing (e.g. no regions)
  const r = await handleDetectMessage(jobMsg("m6", "llama3_1_8b_v1"), Date.now(), deps);
  assert.equal(r.detected, "llama3_1_8b_v1");
});
