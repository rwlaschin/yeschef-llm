import { test } from "node:test";
import assert from "node:assert/strict";
import { createSemaphore } from "./semaphore.js";

// A microtask flush — lets queued grants resolve so we can observe state deterministically.
const tick = () => new Promise((r) => setImmediate(r));

test("grants up to the limit immediately", async () => {
  const s = createSemaphore(2);
  assert.equal(s.max, 2);
  const r1 = await s.acquire();
  const r2 = await s.acquire();
  assert.equal(s.active, 2);
  assert.equal(s.waiting, 0);
  r1(); r2();
});

test("queues past the limit and grants FIFO on release", async () => {
  const s = createSemaphore(1);
  const r1 = await s.acquire(); // takes the only slot
  assert.equal(s.active, 1);

  const order = [];
  const p2 = s.acquire().then((r) => { order.push(2); return r; });
  const p3 = s.acquire().then((r) => { order.push(3); return r; });
  await tick();
  assert.equal(s.waiting, 2, "both excess acquirers are queued");
  assert.equal(s.active, 1, "no extra slot handed out");

  r1();                 // frees the slot → next waiter (2) runs
  const r2 = await p2;
  assert.deepEqual(order, [2], "FIFO: first waiter granted first");
  assert.equal(s.active, 1);

  r2();                 // → waiter 3 runs
  const r3 = await p3;
  assert.deepEqual(order, [2, 3]);
  r3();
  assert.equal(s.active, 0);
});

test("release is idempotent — double-call does not over-free a slot", async () => {
  const s = createSemaphore(1);
  const r1 = await s.acquire();
  const p2 = s.acquire();
  await tick();
  assert.equal(s.waiting, 1);

  r1();
  r1();                 // second call must be a no-op (would otherwise grant a phantom slot)
  const r2 = await p2;
  await tick();
  assert.equal(s.active, 1, "exactly one slot active, not two");
  r2();
  assert.equal(s.active, 0);
});

test("limit floors to 1 for 0 / negative / NaN", () => {
  assert.equal(createSemaphore(0).max, 1);
  assert.equal(createSemaphore(-3).max, 1);
  assert.equal(createSemaphore(undefined).max, 1);
  assert.equal(createSemaphore("nope").max, 1);
  assert.equal(createSemaphore(4).max, 4);
});

test("never exceeds the limit under a burst, and drains every waiter", async () => {
  const s = createSemaphore(3);
  let peak = 0;
  const run = () =>
    s.acquire().then(async (release) => {
      peak = Math.max(peak, s.active);
      await tick();           // hold the slot across a turn
      release();
    });
  await Promise.all(Array.from({ length: 20 }, run));
  assert.ok(peak <= 3, `peak concurrency ${peak} must not exceed 3`);
  assert.equal(s.active, 0);
  assert.equal(s.waiting, 0);
});
