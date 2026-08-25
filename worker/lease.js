// ONE number decides how much work a worker takes on: how many generations it can run at once.
//
// It was two knobs. OLLAMA_NUM_PARALLEL sized the generation gate, MAX_CONCURRENCY sized the Pub/Sub
// lease, and nothing tied them together — so prod ran a gate of 1 with a lease of 2 and every box took
// a second message it could not start. Pub/Sub marks that message outstanding: invisible to every other
// box, deadline auto-extended up to 60 min, and gone when the box dies. That is how a backlog of >1
// stranded a message nothing picked up, and why a box generating nothing still looked busy.
//
// config/models.js is the source of truth. Deploy/dev derive OLLAMA_NUM_PARALLEL from the selected
// model and pass it into the worker as runtime transport; the lease and generation gate both consume
// that transported value, so they cannot drift from each other.
//
// Its own module so it can be unit-tested without importing worker/index.js (which starts a subscriber
// on import), and because this CANNOT be tested against the Pub/Sub emulator — the emulator ignores
// flowControl.maxMessages and delivers a burst regardless (measured: 4 messages to a maxMessages:1
// subscriber). The number is asserted here as arithmetic; the in-process gate is what holds dev.
// UNSET defaults to 1 — the safest possible lease, and the value every path that forgets to transport
// it actually wants. Fatal fail-fast on unset cost 5,077 respawns of the `fake` worker in one day.
// MALFORMED is still fatal ("0", "-1", "1.5", "junk"): a wrong number is a broken deployment leasing
// a different amount of work than its model declares, and silently correcting it hides that.

export function generationSlots(env = process.env) {
  const raw = env.OLLAMA_NUM_PARALLEL;
  if (raw == null || raw === "") return 1;
  const parsed = Number(raw);
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("OLLAMA_NUM_PARALLEL must be a positive integer derived from config/models.js");
  }
  return parsed;
}

/** The Pub/Sub lease bound IS the generation slot count — never lease what you cannot run. */
export const leaseBound = generationSlots;
