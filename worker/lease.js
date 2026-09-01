// ONE number decides how much work a worker takes on: how many generations it can run at once.
//
// It was two knobs. OLLAMA_NUM_PARALLEL sized the generation gate, MAX_CONCURRENCY sized the Pub/Sub
// lease, and nothing tied them together — so prod ran a gate of 1 with a lease of 2 and every box took
// a second message it could not start. Pub/Sub marks that message outstanding: invisible to every other
// box, deadline auto-extended up to 60 min, and gone when the box dies. That is how a backlog of >1
// stranded a message nothing picked up, and why a box generating nothing still looked busy.
//
// config/models.js is the source of truth and is read DIRECTLY here — no env var carries this number
// into the worker any more. OLLAMA_NUM_PARALLEL still exists, but only as the OLLAMA SERVER's own
// configuration (Dockerfile / devbox); it is not a worker input, so it cannot be unset, malformed,
// or disagree with the model's declaration.
//
// The model is resolved by TOPIC, not by model string: `llama3.1:8b` appears twice in MODELS (raw
// tier parallel:3, OpenClaw gateway tier parallel:1), so matching on `m.model` silently picks
// whichever comes first. SUBSCRIPTION_NAME is `sub_<topic>` and is unambiguous.
//
// Its own module so it can be unit-tested without importing worker/index.js (which starts a subscriber
// on import), and because this CANNOT be tested against the Pub/Sub emulator — the emulator ignores
// flowControl.maxMessages and delivers a burst regardless (measured: 4 messages to a maxMessages:1
// subscriber). The number is asserted here as arithmetic; the in-process gate is what holds dev.

import { byTopic, parallelOf } from "../config/models.js";

/** `sub_llama3_1_8b_v1` → the MODELS entry, or null (fake sub, or imported outside a worker). */
const modelOfSubscription = (name) => (name ? byTopic(String(name).split(",")[0].replace(/^sub_/, "")) : null) ?? null;

export function generationSlots(env = process.env) {
  const m = modelOfSubscription(env.SUBSCRIPTION_NAME);
  // No model tier behind this subscription — the fake/canned worker, or a module-scope import in a
  // test. It runs no generations, so one slot is the whole truth; MODELS is untouched either way.
  return m ? parallelOf(m) : 1;
}

/** The Pub/Sub lease bound IS the generation slot count — never lease what you cannot run. */
export const leaseBound = generationSlots;

/** Where the number came from, for boot logs: the model's declared `parallel`. */
export const slotsSource = (env = process.env) => {
  const m = modelOfSubscription(env.SUBSCRIPTION_NAME);
  return m ? `${m.topic}.parallel (config/models.js)` : "no model tier for this subscription — 1 slot";
};
