// Subscriber lifecycle: attach handlers, and REOPEN when the stream closes instead of going quiet.
//
// Why this is its own module: the failure it guards against is "the box is up, healthy to the MIG, and
// permanently deaf", which is invisible to every unit test that only checks message handling. Taking the
// subscription as an injected `open()` lets a fake EventEmitter emit `close` on demand, so the reopen,
// the backoff, the counter reset and the give-up are all testable with no GCP and no deploy — the
// emulator cannot force a stream closed, so this was otherwise only verifiable in prod.
//
// Routine server-side connection cycling is handled INSIDE the Pub/Sub client library and never reaches
// here (subscription.js re-emits its subscriber's close), so an emitted `close` means this subscriber is
// finished and reopening is the correct response.

/** Backoff + give-up decision for the Nth consecutive failed reopen. Pure. */
export function reopenPlan(attempt, { capMs = 30_000, giveUp = 10 } = {}) {
  const next = attempt + 1;
  if (next > giveUp) return { action: "give-up", attempt };
  return { action: "reopen", attempt: next, delayMs: Math.min(capMs, 1000 * 2 ** attempt) };
}

/** A debug line that reports the stream dropping, rather than routine chatter. */
const isTransportDisruption = (detail) => /\b(stream|connection)\b/i.test(detail)
  && /\b(ended|closed|retried|retrying)\b|status \d+/i.test(detail);

/**
 * Wire a subscription and keep it alive.
 *  open      (name) => subscription — an EventEmitter emitting message | error | close | debug
 *  onMessage (msg, name) => void
 *  onGiveUp  (name, attempt) => void — consecutive reopens exhausted; the caller decides (exit, alert)
 *  log       (event, name, extra) => void — every transition, so a quiet box is explainable
 *  timers    { setTimeout } — injectable for tests
 */
export function makeSubscriberLoop({ open, onMessage, onGiveUp, log = () => {}, timers = { setTimeout }, capMs, giveUp } = {}) {
  // Consecutive failures PER SUBSCRIPTION, not a lifetime count: a box that reopens cleanly and closes
  // again hours later is healthy, and a lifetime counter would retire it on its 10th close in a week.
  const attempts = new Map();

  const listen = (name) => {
    const attempt = attempts.get(name) ?? 0;
    const subscription = open(name);

    subscription.on("message", (m) => {
      // Receiving anything proves this subscriber works, so the failure streak resets here — not on a
      // successful open(), which only proves the object was constructed.
      if (attempts.get(name)) {
        log("reopen-recovered", name, { afterAttempts: attempts.get(name) });
        attempts.set(name, 0);
      }
      onMessage(m, name);
    });

    subscription.on("error", (err) => log("error", name, { detail: err?.message || String(err) }, "error"));

    subscription.on("close", () => {
      // Read the streak NOW, not the value captured when this subscriber was opened. A subscriber that
      // reopened and then received a message has had its streak cleared; using the stale closure value
      // made it back off as if still failing (8s instead of 1s) and left it three steps from give-up
      // despite having proven healthy.
      const plan = reopenPlan(attempts.get(name) ?? 0, { capMs, giveUp });
      if (plan.action === "give-up") {
        log("close-giving-up", name, { attempt: plan.attempt }, "error");
        onGiveUp?.(name, plan.attempt);
        return;
      }
      attempts.set(name, plan.attempt);
      log("close-reopening", name, { attempt: plan.attempt, delayMs: plan.delayMs }, "warn");
      // Drop the dead subscription's handlers first, so it cannot emit `close` twice and stack timers.
      subscription.removeAllListeners?.();
      // NOT unref'd. With the subscriber closed this timer can be the only handle keeping the event loop
      // alive; unref'd, Node exits here and the worker dies silently while its VM stays up — the exact
      // failure this code exists to prevent.
      timers.setTimeout(() => listen(name), plan.delayMs);
    });

    // Severity has to be decided here: downstream the worker's stdout and stderr are merged into one
    // stream, so a transport disruption buried in the generic debug channel is unrecoverable later.
    subscription.on("debug", (msg) => {
      const detail = msg?.message || String(msg);
      log("debug", name, { detail }, isTransportDisruption(detail) ? "warn" : undefined);
    });
    log(attempt ? "reopened" : "listening", name, attempt ? { attempt } : {});
    return subscription;
  };

  return { listen, _attempts: () => new Map(attempts) };
}
