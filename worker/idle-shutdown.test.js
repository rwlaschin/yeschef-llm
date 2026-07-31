import { test } from "node:test";
import assert from "node:assert/strict";
import { makeIdleShutdown, workerRegion, workerInstance, _resetMetaCache } from "./idle-shutdown.js";

// Deterministic clock: we drive setTimeout by hand so tests don't wait real time.
function fakeClock() {
  let now = 0;
  const timers = [];
  const g = globalThis;
  const realSet = g.setTimeout, realClear = g.clearTimeout;
  g.setTimeout = (fn, ms) => { const t = { fn, at: now + ms, dead: false, unref() { return t; } }; timers.push(t); return t; };
  g.clearTimeout = (t) => { if (t) t.dead = true; };
  return {
    async advance(ms) {
      now += ms;
      for (const t of [...timers]) if (!t.dead && t.at <= now) { t.dead = true; await t.fn(); }
    },
    restore() { g.setTimeout = realSet; g.clearTimeout = realClear; },
  };
}
const silent = { log() {}, error() {} };

test("fires onIdle after idleMs when it boots and never gets a job", async () => {
  const clock = fakeClock();
  try {
    let fired = 0;
    const idle = makeIdleShutdown({ idleMs: 1000, onIdle: async () => { fired++; }, log: silent });
    idle.armInitial();
    await clock.advance(999);
    assert.equal(fired, 0, "must not fire before idleMs");
    await clock.advance(1);
    assert.equal(fired, 1, "fires exactly at idleMs");
  } finally { clock.restore(); }
});

test("a message resets the timer; only fires idleMs AFTER the last job finishes", async () => {
  const clock = fakeClock();
  try {
    let fired = 0;
    const idle = makeIdleShutdown({ idleMs: 1000, onIdle: async () => { fired++; }, log: silent });
    idle.armInitial();
    await clock.advance(900);
    const t = idle.onStart("job-1");        // work arrives → timer cleared
    await clock.advance(5000);              // long job; must NOT fire while in flight
    assert.equal(fired, 0, "never fires mid-job");
    idle.onFinish("job-1", t);              // idle again → timer re-armed
    await clock.advance(999);
    assert.equal(fired, 0);
    await clock.advance(1);
    assert.equal(fired, 1, "fires idleMs after the job finished, not after it started");
  } finally { clock.restore(); }
});

test("does not fire while any of several concurrent jobs is still in flight", async () => {
  const clock = fakeClock();
  try {
    let fired = 0;
    const idle = makeIdleShutdown({ idleMs: 1000, onIdle: async () => { fired++; }, log: silent });
    const a = idle.onStart("a");
    const b = idle.onStart("b");
    idle.onFinish("a", a);
    await clock.advance(2000);
    assert.equal(fired, 0, "b still in flight → no shutdown");
    idle.onFinish("b", b);
    await clock.advance(1000);
    assert.equal(fired, 1);
  } finally { clock.restore(); }
});

test("onFinish resets the timer even when the handler errored (finally path)", async () => {
  const clock = fakeClock();
  try {
    let fired = 0;
    const idle = makeIdleShutdown({ idleMs: 1000, onIdle: async () => { fired++; }, log: silent });
    // Simulate index.js wrapper: onStart, handler throws, finally → onFinish.
    const t = idle.onStart("boom");
    try { throw new Error("handler blew up"); } catch { /* swallowed like the wrapper's .catch */ }
    idle.onFinish("boom", t);
    await clock.advance(1000);
    assert.equal(fired, 1, "a failed job must still leave the worker able to shut down");
  } finally { clock.restore(); }
});

test("a failed shutdown re-arms and retries next window", async () => {
  const clock = fakeClock();
  try {
    let calls = 0;
    const idle = makeIdleShutdown({
      idleMs: 1000,
      onIdle: async () => { calls++; if (calls === 1) throw new Error("compute API blip"); },
      log: silent,
    });
    idle.armInitial();
    await clock.advance(1000);   // first fire → throws
    assert.equal(calls, 1);
    await clock.advance(1000);   // re-armed → retries
    assert.equal(calls, 2, "retries after a transient shutdown failure");
  } finally { clock.restore(); }
});

// ---- workerRegion: instance zone → region, cached, null off-GCE -----------------------------
// Base module instance + _resetMetaCache between cases (not a query-string re-import) so the on- and
// off-GCE branches share the ONE instrumented module copy instead of each minting a fresh, mostly-
// uncovered one.
test("workerRegion: parses region from the instance zone metadata (cached)", async () => {
  const realFetch = globalThis.fetch;
  try {
    _resetMetaCache();
    globalThis.fetch = async () => ({ ok: true, text: async () => "projects/38637528569/zones/us-central1-b\n" });
    assert.equal(await workerRegion(), "us-central1");
    assert.equal(await workerRegion(), "us-central1"); // cached, no second fetch needed
  } finally { globalThis.fetch = realFetch; _resetMetaCache(); }
});

test("workerRegion: metadata unreachable (off-GCE) → null, never throws", async () => {
  const realFetch = globalThis.fetch;
  try {
    _resetMetaCache();
    globalThis.fetch = async () => { throw new Error("ENOTFOUND metadata.google.internal"); };
    assert.equal(await workerRegion(), null);
  } finally { globalThis.fetch = realFetch; _resetMetaCache(); }
});

// ---- workerInstance: instance self-link (…/zones/<zone>/instances/<name>), cached, null off-GCE ----
// Reuses the base module instance (not a query-string re-import) + _resetMetaCache between cases, so
// both branches run without spinning up a fresh, mostly-uncovered module copy per case.
test("workerInstance: builds the full self-link, caches it, and is null off-GCE", async () => {
  const realFetch = globalThis.fetch;
  const url = "https://www.googleapis.com/compute/v1/projects/38637528569/zones/us-central1-b/instances/ollama-llama3-1-8b-v1-mig-tc0k";
  try {
    _resetMetaCache();
    globalThis.fetch = async (u) => ({
      ok: true,
      text: async () => String(u).endsWith("instance/name")
        ? "ollama-llama3-1-8b-v1-mig-tc0k\n"
        : "projects/38637528569/zones/us-central1-b\n",
    });
    assert.equal(await workerInstance(), url);
    assert.equal(await workerInstance(), url); // cached — no second fetch needed

    _resetMetaCache();
    globalThis.fetch = async () => { throw new Error("ENOTFOUND metadata.google.internal"); };
    assert.equal(await workerInstance(), null); // off-GCE → null, never throws
  } finally { globalThis.fetch = realFetch; _resetMetaCache(); }
});
