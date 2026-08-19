// OFFLINE reproduction of the two P1 queue failures, against the Pub/Sub EMULATOR — no GCP, no GCE,
// no Ollama. These are the checks that must pass before a deploy, because both bugs are invisible to
// unit tests (they are lease/flow-control behaviour, not logic) and expensive to find in prod.
//
//   P1-1  a backlog of >1 leaves a message nothing ever picks up
//   P1-2  a box that is up and idle stops taking work
//
// Both come from the same cause: leasing more messages than the worker can GENERATE. Pub/Sub hands the
// surplus to this box, marks it outstanding (invisible to every other box, deadline auto-extended up to
// 60 min), and it dies with the box — so a queue with 2 messages could end with 1 processed, 1 stranded,
// and no box left to take it.
//
// Skips itself when the emulator is not reachable, so `npm test` stays green on a bare checkout.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PubSub } from "@google-cloud/pubsub";
import { generationSlots, leaseBound } from "./lease.js";
import { createSemaphore } from "./semaphore.js";
import { MODELS, DEFAULT_PARALLEL, parallelOf, maxCtxFor } from "../config/models.js";

const HOST = process.env.PUBSUB_EMULATOR_HOST || "localhost:8185";
const PROJECT = "leasing-test";
// Unique per run: this emulator is shared with the dev stack, and a fixed name would collide with it.
const SUFFIX = `${process.pid}`;

let pubsub, reachable = false;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  process.env.PUBSUB_EMULATOR_HOST = HOST;
  pubsub = new PubSub({ projectId: PROJECT });
  try {
    await pubsub.getTopics();
    reachable = true;
  } catch {
    reachable = false;
  }
});

after(async () => {
  if (!reachable) return;
  for (const t of (await pubsub.getTopics())[0]) {
    if (t.name.includes(SUFFIX)) {
      for (const s of (await t.getSubscriptions())[0]) await s.delete().catch(() => {});
      await t.delete().catch(() => {});
    }
  }
});

// One topic + pull subscription, N messages published, nothing consuming yet.
async function seed(name, count) {
  const [topic] = await pubsub.createTopic(`${name}-${SUFFIX}`);
  const [sub] = await topic.createSubscription(`sub-${name}-${SUFFIX}`, { ackDeadlineSeconds: 10 });
  for (let i = 0; i < count; i++) await topic.publishMessage({ data: Buffer.from(JSON.stringify({ n: i })) });
  return { topic, sub: sub.name.split("/").pop() };
}

// Drive a subscriber exactly the way worker/index.js does — flowControl.maxMessages + a handler that
// holds the message while "generating" — and report how many it took hostage at once.
async function leaseWatch({ sub, maxMessages, holdMs, forMs }) {
  const subscription = pubsub.subscription(sub, { flowControl: { maxMessages, maxExtensionMinutes: 60 } });
  let concurrent = 0, peak = 0, delivered = 0, acked = 0;
  subscription.on("message", async (m) => {
    delivered++; concurrent++; peak = Math.max(peak, concurrent);
    await wait(holdMs);          // stands in for a generation
    m.ack(); acked++; concurrent--;
  });
  subscription.on("error", () => {});
  await wait(forMs);
  await subscription.close();
  return { peak, delivered, acked };
}

// What a 3-message burst CAN prove. The lease bound cannot be tested here (the emulator ignores
// flowControl.maxMessages), but the in-process gate is what actually holds dev — and it is exactly
// what a burst exercises. Publish MORE than the slot count, hold each "generation" long enough that
// they must overlap, and require the gate to pin the peak at the slot count with the rest queued.
// Sized off parallelOf(), so raising a model's slots re-runs this at the new number.
test("a burst larger than the slot count never runs more generations than there are slots", async (t) => {
  if (!reachable) return t.skip("emulator not reachable");
  const BURST = SLOTS + 2;
  const { sub } = await seed(`gate-${SLOTS}`, BURST);
  const gate = createSemaphore(SLOTS);
  const subscription = pubsub.subscription(sub, { flowControl: { maxMessages: SLOTS, maxExtensionMinutes: 60 } });
  let peak = 0, done = 0;
  subscription.on("message", async (m) => {
    const release = await gate.acquire();          // the gate worker/index.js puts around a generation
    try {
      peak = Math.max(peak, gate.active);
      await wait(150);                             // stands in for a generation
    } finally { release(); m.ack(); done++; }
  });
  subscription.on("error", () => {});
  for (let i = 0; i < 60 && done < BURST; i++) await wait(100);
  await subscription.close();

  assert.equal(done, BURST, `every message must finish — ${done}/${BURST} did`);
  assert.equal(peak, SLOTS, `at most ${SLOTS} generations may run at once; peak was ${peak}`);
});

// The lease BOUND itself is asserted as arithmetic, not against the emulator: the emulator ignores
// flowControl.maxMessages and delivers a burst regardless (measured — it handed 4 messages to a
// maxMessages:1 subscriber), so an emulator test here would fail for a reason that does not exist in
// prod. What the emulator CAN prove is below: the backlog drains, and an idle subscriber still gets work.
test("P1-1: the lease bound IS the generation slot count — one knob, cannot drift", () => {
  // The prod configuration that caused the bug: gate 1, lease 2. There is now no way to express it.
  assert.equal(generationSlots({ OLLAMA_NUM_PARALLEL: "1" }), 1);
  assert.equal(leaseBound({ OLLAMA_NUM_PARALLEL: "1" }), 1, "lease must equal the gate, not 2");
  assert.equal(leaseBound({ OLLAMA_NUM_PARALLEL: "2" }), 2, "raising the gate raises the lease together");
  assert.equal(leaseBound({}), 1, "unset defaults to ONE in every environment — a prod-only 2 halves ctx");
  assert.equal(leaseBound({ OLLAMA_NUM_PARALLEL: "0" }), 1, "0 is not a valid slot count");
  assert.equal(leaseBound({ OLLAMA_NUM_PARALLEL: "junk" }), 1, "garbage must not yield NaN");
  assert.equal(leaseBound, generationSlots, "same function — a second definition is how they drifted");
});

test("P1-1: the whole backlog drains — nothing is left behind", async (t) => {
  if (!reachable) return t.skip(`Pub/Sub emulator not reachable at ${HOST}`);
  const N = 5;
  const { sub } = await seed("drain", N);
  const r = await leaseWatch({ sub, maxMessages: 1, holdMs: 120, forMs: 2500 });
  assert.equal(r.acked, N, `all ${N} messages must be acked, got ${r.acked}`);
});

test("P1-2: a subscriber that has been idle still picks up new work", async (t) => {
  if (!reachable) return t.skip(`Pub/Sub emulator not reachable at ${HOST}`);
  const [topic] = await pubsub.createTopic(`idle-${SUFFIX}`);
  const [subObj] = await topic.createSubscription(`sub-idle-${SUFFIX}`, { ackDeadlineSeconds: 10 });

  const subscription = pubsub.subscription(subObj.name.split("/").pop(), {
    flowControl: { maxMessages: 1, maxExtensionMinutes: 60 },
  });
  const got = [];
  subscription.on("message", (m) => { got.push(m.id); m.ack(); });
  subscription.on("error", () => {});

  // Sit idle FIRST — this is the state the box is in when the complaint happens.
  await wait(1500);
  assert.equal(got.length, 0, "nothing published yet");

  await topic.publishMessage({ data: Buffer.from(JSON.stringify({ after: "idle" })) });
  for (let i = 0; i < 40 && !got.length; i++) await wait(100);
  await subscription.close();

  assert.equal(got.length, 1, "an idle subscriber must receive work published after it went quiet");
});

// The slot count is now an IMPORTED value, so this asserts real behaviour instead of matching source
// text — the previous version regex-scanned deploy.js, which proves nothing and breaks the moment the
// file is restructured. config/models.js owns the number; deploy.js and worker/lease.js both consume it.
// The slot count is a capacity DECISION, so the contract that must hold changes with it. Both tests
// below are permanent; each skips itself when the fleet is not on its number, so flipping
// config/models.js back and forth swaps which one runs instead of editing either.
const LLAMA = MODELS.find((m) => m.topic === "llama3_1_8b_v1");
const SLOTS = parallelOf(LLAMA);
// llama3.1's real trained window. `ctx` in config/models.js is what ONE SLOT gets, so once slots > 1
// that field is the share, not the window — the full number has to live somewhere and this is it.
const LLAMA_WINDOW = 131072;

// NEVER skipped, and it does NOT derive its expectation from the thing it checks — the numbers below
// are written down here. Every skip in this file keys off config/models.js, so without this test a
// config edit would just pick which contract runs and no value could ever be wrong.
//
// What it asserts is the MACHINE ceiling, not the model's. Ollama allocates num_ctx per slot
// (server/sched.go effectiveLlamaServerContext multiplies by numParallel), so raising `parallel`
// multiplies the KV bill; maxCtxFor() is what keeps a request inside the card. The failure this
// catches: a slot count high enough that the cap falls under the worker's own num_ctx floor, which
// would silently trim every request's window instead of erroring.
const L4_USABLE_GB = 20;      // 24 GB card, 23034 MiB visible, minus CUDA context + compute buffers
const WORKER_CTX_FLOOR = 8192; // worker/index.js OLLAMA_NUM_CTX default — the smallest usable window
test("no model's slot count starves its context below the worker's floor", () => {
  for (const m of MODELS) {
    const slots = parallelOf(m);
    const cap = maxCtxFor(m, slots, L4_USABLE_GB);
    assert.ok(cap >= WORKER_CTX_FLOOR,
      `${m.topic}: ${slots} slots caps num_ctx at ${cap}, under the ${WORKER_CTX_FLOOR} floor — ` +
      `every request would be trimmed. Lower parallel, or raise GPU_VRAM_GB if the box is bigger.`);
    assert.ok(cap <= m.ctx,
      `${m.topic}: the machine cap ${cap} exceeds the model's own ${m.ctx} window — cap the smaller`);
    assert.equal(leaseBound({ OLLAMA_NUM_PARALLEL: String(slots) }), slots,
      `${m.topic}: the Pub/Sub lease must equal the slots — never lease what you cannot run`);
  }
});

test("generation slots: one imported value drives every model", {
  skip: SLOTS !== 1 && `fleet runs ${SLOTS} slots — the one-slot contract does not apply`,
}, () => {
  assert.equal(DEFAULT_PARALLEL, 1, "2 slots halve num_ctx per request on a single L4");
  for (const m of MODELS) {
    assert.equal(parallelOf(m), 1, `${m.topic} must run one generation per box unless ctx is reduced with it`);
  }
});

test("generation slots: at 3, the card still holds a real window and the lease follows", {
  skip: SLOTS !== 3 && `fleet runs ${SLOTS} slots — the three-slot contract does not apply`,
}, () => {
  assert.equal(DEFAULT_PARALLEL, 1, "an unset env must still mean ONE — 3 is opt-in per model, never a default");
  assert.equal(LLAMA.ctx, LLAMA_WINDOW, "ctx is the model's CAPABILITY ceiling and does not move with parallel");
  // Measured on a 1× L4: 3 slots at the production context (9366) used 8.6 GB and gave 2.14× the
  // throughput of one at a time. The cap must leave room for that request, not merely for the floor.
  const cap = maxCtxFor(LLAMA, SLOTS, L4_USABLE_GB);
  assert.ok(cap >= 9366, `3 slots caps num_ctx at ${cap}, under the 9366 a real job asks for`);
  assert.equal(leaseBound({ OLLAMA_NUM_PARALLEL: String(SLOTS) }), SLOTS, "the lease must equal the slots — never lease what you cannot run");
  assert.equal(generationSlots({ OLLAMA_NUM_PARALLEL: String(SLOTS) }), SLOTS, "the in-process gate must open the same number");
  // The other four dev models did not opt in; a box-wide setting must not silently raise their lease.
  for (const m of MODELS.filter((x) => x !== LLAMA)) {
    assert.equal(parallelOf(m), 1, `${m.topic} did not opt into extra slots`);
  }
});

test("generation slots: a per-model override is honoured, and garbage is not", () => {
  assert.equal(parallelOf({ topic: "x", parallel: 2 }), 2, "an explicit capacity decision must be possible");
  assert.equal(parallelOf({ topic: "x", parallel: 0 }), 1, "0 would consume nothing");
  assert.equal(parallelOf({ topic: "x", parallel: "junk" }), 1, "must not yield NaN");
  assert.equal(parallelOf(undefined), 1, "missing model must not throw");
});

test("the worker lease falls back to that same value, not its own copy", () => {
  assert.equal(leaseBound({}), DEFAULT_PARALLEL, "the lease default IS the config default — no second source");
});
