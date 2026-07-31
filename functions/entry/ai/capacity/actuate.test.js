// Tests for the capacity actuator (docs/plans/capacity-steering/phase2-control-loop.md). A FAKE GCE
// client so nothing ever touches GCP — asserts the resize/deleteInstances math, the model→MIG mapping
// (derived like deploy.js), and the dev-gate: off-prod → would-log + ZERO client calls; prod → real
// calls. NODE_ENV is flipped per-case to exercise both sides of isProdLike() (K_SERVICE is NOT a prod
// signal — the emulator sets it too).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startBox, shrinkBox, releaseBox, migOf, topicOfInstance } from "./actuate.js";

const MODEL = "llama3_1_8b_v1";           // a real MODELS topic
const MIG = "ollama-llama3-1-8b-v1-mig";  // imageOf(byTopic(MODEL)) + "-mig" — same derivation deploy.js uses
const REGION = "us-central1";
const INSTANCE = "https://www.googleapis.com/compute/v1/projects/38637528569/zones/us-central1-b/instances/ollama-llama3-1-8b-v1-mig-tc0k";

function fakeGce(size = 3) {
  const calls = { getSize: [], resize: [], deleteInstances: [] };
  const gce = {
    async getSize(a) { calls.getSize.push(a); return size; },
    async resize(a) { calls.resize.push(a); },
    async deleteInstances(a) { calls.deleteInstances.push(a); },
  };
  return { gce, calls };
}

// Run fn with a forced prod / non-prod env, restoring both vars afterwards.
async function withEnv({ prod }, fn) {
  const prev = { N: process.env.NODE_ENV, K: process.env.K_SERVICE };
  if (prod) { process.env.NODE_ENV = "production"; }
  else { delete process.env.K_SERVICE; delete process.env.NODE_ENV; }
  try { return await fn(); }
  finally {
    if (prev.N === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev.N;
    if (prev.K === undefined) delete process.env.K_SERVICE; else process.env.K_SERVICE = prev.K;
  }
}

test("migOf: topic → `<image>-mig` (same derivation deploy.js uses); unknown → null", () => {
  assert.equal(migOf(MODEL), MIG);
  assert.equal(migOf("fake_canned_v1"), null); // not a region-steered MODELS entry
  assert.equal(migOf("nope"), null);
});

test("topicOfInstance: MIG instance name or bare MIG name → topic; unknown → null", () => {
  assert.equal(topicOfInstance("ollama-llama3-1-8b-v1-mig-tc0k"), MODEL);
  assert.equal(topicOfInstance("ollama-llama3-1-8b-v1-mig"), MODEL);
  assert.equal(topicOfInstance("something-else"), null);
  assert.equal(topicOfInstance(""), null);
  assert.equal(topicOfInstance(null), null);
});

test("startBox (prod): reads size, resizes +1", async () => {
  await withEnv({ prod: true }, async () => {
    const { gce, calls } = fakeGce(3);
    const out = await startBox(MODEL, REGION, gce);
    assert.deepEqual(calls.getSize, [{ region: REGION, mig: MIG }]);
    assert.deepEqual(calls.resize, [{ region: REGION, mig: MIG, size: 4 }]);
    assert.deepEqual(out, { action: "resize +1", mig: MIG, region: REGION, from: 3, to: 4 });
  });
});

test("shrinkBox (prod): resizes −1, floors at 0", async () => {
  await withEnv({ prod: true }, async () => {
    const a = fakeGce(3);
    await shrinkBox(MODEL, REGION, a.gce);
    assert.deepEqual(a.calls.resize, [{ region: REGION, mig: MIG, size: 2 }]);

    const b = fakeGce(0); // already empty → never resize below 0
    const out = await shrinkBox(MODEL, REGION, b.gce);
    assert.deepEqual(b.calls.resize, [{ region: REGION, mig: MIG, size: 0 }]);
    assert.equal(out.to, 0);
  });
});

test("releaseBox (prod, instance known): deleteInstances the exact box, NO resize", async () => {
  await withEnv({ prod: true }, async () => {
    const { gce, calls } = fakeGce(3);
    const out = await releaseBox(MODEL, REGION, INSTANCE, gce);
    assert.deepEqual(calls.deleteInstances, [{ region: REGION, mig: MIG, instances: [INSTANCE] }]);
    assert.equal(calls.resize.length, 0);
    assert.equal(calls.getSize.length, 0);
    assert.equal(out.action, "delete-instance");
    assert.equal(out.instance, INSTANCE);
  });
});

test("releaseBox (prod, no instance): falls back to a size−1 resize, flagged untargeted", async () => {
  await withEnv({ prod: true }, async () => {
    const { gce, calls } = fakeGce(3);
    const out = await releaseBox(MODEL, REGION, null, gce);
    assert.equal(calls.deleteInstances.length, 0);
    assert.deepEqual(calls.resize, [{ region: REGION, mig: MIG, size: 2 }]);
    assert.equal(out.untargeted, true);
  });
});

test("dev-gate: off-prod → would:true and ZERO client calls, for start/shrink/release", async () => {
  await withEnv({ prod: false }, async () => {
    const { gce, calls } = fakeGce(3);
    const s = await startBox(MODEL, REGION, gce);
    const k = await shrinkBox(MODEL, REGION, gce);
    const r = await releaseBox(MODEL, REGION, INSTANCE, gce);
    assert.equal(s.would, true);
    assert.equal(k.would, true);
    assert.equal(r.would, true);
    assert.equal(calls.getSize.length + calls.resize.length + calls.deleteInstances.length, 0);
  });
});

test("unknown model → skipped (no MIG), ZERO client calls, both prod and dev", async () => {
  for (const prod of [true, false]) {
    await withEnv({ prod }, async () => {
      const { gce, calls } = fakeGce(3);
      assert.deepEqual(await startBox("nope", REGION, gce), { skipped: "no-mig" });
      assert.deepEqual(await shrinkBox("nope", REGION, gce), { skipped: "no-mig" });
      assert.deepEqual(await releaseBox("nope", REGION, INSTANCE, gce), { skipped: "no-mig" });
      assert.equal(calls.getSize.length + calls.resize.length + calls.deleteInstances.length, 0);
    });
  }
});

test("no region → skipped, never actuates", async () => {
  await withEnv({ prod: true }, async () => {
    const { gce, calls } = fakeGce(3);
    assert.deepEqual(await startBox(MODEL, null, gce), { skipped: "no-region" });
    assert.equal(calls.resize.length, 0);
  });
});

test("never throws: a GCE client error is swallowed → { error }, for all three actuators", async () => {
  await withEnv({ prod: true }, async () => {
    const boom = { async getSize() { throw new Error("compute down"); }, async resize() { throw new Error("compute down"); }, async deleteInstances() { throw new Error("compute down"); } };
    assert.ok((await startBox(MODEL, REGION, boom)).error, "startBox swallows");
    assert.ok((await shrinkBox(MODEL, REGION, boom)).error, "shrinkBox swallows");
    assert.ok((await releaseBox(MODEL, REGION, INSTANCE, boom)).error, "releaseBox swallows");
  });
});
