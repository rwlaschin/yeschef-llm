// ONE number decides how much work a worker takes on: how many generations it can run at once.
//
// It was two knobs. OLLAMA_NUM_PARALLEL sized the generation gate, MAX_CONCURRENCY sized the Pub/Sub
// lease, and nothing tied them together — so prod ran a gate of 1 with a lease of 2 and every box took
// a second message it could not start. Pub/Sub marks that message outstanding: invisible to every other
// box, deadline auto-extended up to 60 min, and gone when the box dies. That is how a backlog of >1
// stranded a message nothing picked up, and why a box generating nothing still looked busy.
//
// OLLAMA_NUM_PARALLEL is the source of truth — it is already what deploy.js bakes into the image
// (Dockerfile.ejs `ENV OLLAMA_NUM_PARALLEL`), passes to the VM, and feeds to the autoscaler as
// messages-per-box (`singleInstanceAssignment`). The lease now derives from the same number instead of
// duplicating it, so the two cannot drift again.
//
// Its own module so it can be unit-tested without importing worker/index.js (which starts a subscriber
// on import), and because this CANNOT be tested against the Pub/Sub emulator — the emulator ignores
// flowControl.maxMessages and delivers a burst regardless (measured: 4 messages to a maxMessages:1
// subscriber). The number is asserted here as arithmetic; the in-process gate is what holds dev.
// Default 1, in EVERY environment. A prod-only fallback of 2 was wrong twice over: on a 1× L4 the 8B at
// ctx 131072 already needs ~21.8 GB of 24 GB for a single slot, so Ollama splits num_ctx across slots
// and 2 parallel silently halves every request's context to 65k — and it doubles the lease at the same
// time. More than one slot is a deliberate capacity decision (drop `ctx` to match), never a default
// that appears because an env var was missing.
import { DEFAULT_PARALLEL } from "../config/models.js";

export function generationSlots(env = process.env) {
  const raw = parseInt(env.OLLAMA_NUM_PARALLEL, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PARALLEL;
}

/** The Pub/Sub lease bound IS the generation slot count — never lease what you cannot run. */
export const leaseBound = generationSlots;
