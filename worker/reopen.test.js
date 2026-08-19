// The reopen path, driven by a fake subscription. This is the behaviour that was previously only
// observable in prod: the Pub/Sub emulator cannot force a stream closed, so "the box is up and
// permanently deaf" had no offline test. Injecting `open` gives us one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { makeSubscriberLoop, reopenPlan } from "./reopen.js";

// Collects the subscriptions handed out, so a test can close the current one on demand.
function fakePubSub() {
  const made = [];
  return {
    made,
    open(name) {
      const s = new EventEmitter();
      s.name = name;
      made.push(s);
      return s;
    },
    current: () => made[made.length - 1],
  };
}

// Runs scheduled callbacks on demand instead of waiting real seconds.
function fakeTimers() {
  const queued = [];
  return {
    timers: { setTimeout: (fn, ms) => { queued.push({ fn, ms }); return { unref() {} }; } },
    queued,
    async runAll() { while (queued.length) await queued.shift().fn(); },
  };
}

test("reopenPlan: exponential backoff, capped, then gives up", () => {
  assert.deepEqual(reopenPlan(0), { action: "reopen", attempt: 1, delayMs: 1000 });
  assert.deepEqual(reopenPlan(1), { action: "reopen", attempt: 2, delayMs: 2000 });
  assert.deepEqual(reopenPlan(4), { action: "reopen", attempt: 5, delayMs: 16000 });
  assert.equal(reopenPlan(9).delayMs, 30000, "capped, never an hour-long wait");
  assert.deepEqual(reopenPlan(10), { action: "give-up", attempt: 10 });
});

test("a closed subscriber is REOPENED, not left dead", async () => {
  const ps = fakePubSub(); const t = fakeTimers();
  const loop = makeSubscriberLoop({ open: ps.open, onMessage: () => {}, timers: t.timers });
  loop.listen("sub_x");
  assert.equal(ps.made.length, 1);

  ps.current().emit("close");
  assert.equal(t.queued[0].ms, 1000, "first reopen waits 1s");
  await t.runAll();
  assert.equal(ps.made.length, 2, "a NEW subscription was opened — this is the fix");
});

test("the reopened subscriber still delivers messages", async () => {
  const ps = fakePubSub(); const t = fakeTimers();
  const got = [];
  const loop = makeSubscriberLoop({ open: ps.open, onMessage: (m) => got.push(m), timers: t.timers });
  loop.listen("sub_x");
  ps.current().emit("close");
  await t.runAll();
  ps.current().emit("message", { id: "after-reopen" });
  assert.deepEqual(got.map((m) => m.id), ["after-reopen"], "work flows again after a reopen");
});

test("a dead subscription cannot stack timers by emitting close twice", async () => {
  const ps = fakePubSub(); const t = fakeTimers();
  const loop = makeSubscriberLoop({ open: ps.open, onMessage: () => {}, timers: t.timers });
  loop.listen("sub_x");
  const dead = ps.current();
  dead.emit("close");
  dead.emit("close");            // listeners were removed — must be ignored
  assert.equal(t.queued.length, 1, "exactly one reopen scheduled, no timer leak");
});

test("receiving a message RESETS the failure streak — closes hours apart are not cumulative", async () => {
  const ps = fakePubSub(); const t = fakeTimers();
  const loop = makeSubscriberLoop({ open: ps.open, onMessage: () => {}, timers: t.timers });
  loop.listen("sub_x");

  for (let i = 0; i < 3; i++) { ps.current().emit("close"); await t.runAll(); }
  assert.equal(loop._attempts().get("sub_x"), 3, "three consecutive failures counted");

  ps.current().emit("message", { id: "healthy" });
  assert.equal(loop._attempts().get("sub_x"), 0, "a delivered message proves health — streak cleared");

  ps.current().emit("close");
  assert.equal(t.queued[0].ms, 1000, "backoff restarts from 1s, not from where it left off");
});

test("gives up only after the streak is exhausted, and hands the decision to the caller", async () => {
  const ps = fakePubSub(); const t = fakeTimers();
  const gaveUp = [];
  const loop = makeSubscriberLoop({
    open: ps.open, onMessage: () => {}, timers: t.timers,
    onGiveUp: (name, attempt) => gaveUp.push({ name, attempt }),
    giveUp: 3,
  });
  loop.listen("sub_x");
  for (let i = 0; i < 3; i++) { ps.current().emit("close"); await t.runAll(); }
  assert.equal(gaveUp.length, 0, "still trying while under the limit");
  ps.current().emit("close");
  assert.deepEqual(gaveUp, [{ name: "sub_x", attempt: 3 }], "the loop never exits the process itself");
  assert.equal(t.queued.length, 0, "and schedules no further reopen");
});

test("every transition is logged, so a quiet box is explainable", async () => {
  const ps = fakePubSub(); const t = fakeTimers();
  const events = [];
  const loop = makeSubscriberLoop({
    open: ps.open, onMessage: () => {}, timers: t.timers,
    log: (event) => events.push(event),
  });
  loop.listen("sub_x");
  ps.current().emit("close");
  await t.runAll();
  ps.current().emit("message", { id: "m" });
  ps.current().emit("error", new Error("stream blew up"));
  assert.deepEqual(events, ["listening", "close-reopening", "reopened", "reopen-recovered", "error"]);
});
