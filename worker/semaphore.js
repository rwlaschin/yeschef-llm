// Pure in-process concurrency gate. This is NOT a lease and NOT cross-server correctness — that
// lives in the completion CAS (admission.js / docs/design/worker-dispatch.md). It only bounds how
// many GENERATIONS this single process runs at once, so a transport that hands us more messages
// than the local Ollama can serve does not flood it.
//
// Why we need it even though main() sets flowControl.maxMessages: the dev Pub/Sub emulator IGNORES
// maxMessages and delivers a whole step's fanout at once; in prod a redelivery can overlap a live
// run. Either way we can end up with more concurrent generations than Ollama has run-slots
// (OLLAMA_NUM_PARALLEL) — which on a CPU box means every generation fights for cores and the
// first-token watchdog trips (multi-minute stalls). The gate queues the excess instead.
//
// Sized to OLLAMA_NUM_PARALLEL (Ollama's run-slot count). A generation past the limit AWAITS a
// slot; while it waits the Pub/Sub lease keeps auto-extending (maxExtensionMinutes), so a queued
// message is not redelivered. No leak: acquire() resolves with a one-shot release fn; finishing a
// generation releases the next waiter and drops the closure — nothing retains a completed task.
export function createSemaphore(limit) {
  const max = Math.max(1, Number(limit) || 1);
  let active = 0;
  const waiters = []; // pending grant() callbacks, FIFO

  // acquire() resolves once a slot is free, yielding an idempotent release(). Call release() in a
  // `finally` so a thrown generation still frees its slot.
  const acquire = () =>
    new Promise((resolve) => {
      const grant = () => {
        active++;
        let released = false;
        resolve(() => {
          if (released) return; // idempotent — double release must not over-free a slot
          released = true;
          active--;
          const next = waiters.shift();
          if (next) next();
        });
      };
      if (active < max) grant();
      else waiters.push(grant);
    });

  return {
    acquire,
    max,
    get active() { return active; },
    get waiting() { return waiters.length; },
  };
}
