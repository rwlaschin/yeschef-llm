// admission.js — PURE, distributed-safe decisions for the leaseless dispatch model.
// See design/distributed-dispatch.md. No lease, no holder, no `active` counter — nothing a
// crash can leak. Correctness rests on ONE primitive: first-writer-wins completion (a CAS the
// caller runs inside a Firestore transaction). These two functions encode the guard.
//
// `attempt` (carried on the message + stored on the slot) is the discriminator that lets us tell
// a genuine orchestrator RETRY (re-runs the same step-unit slot with a higher attempt) apart from
// a stale DUPLICATE delivery of an attempt already finished. Without it, "skip if terminal" would
// wrongly suppress retries.

const TERMINAL = new Set(["success", "fail"]);
const isTerminal = (slot) => !!slot && TERMINAL.has(slot.status);

// Should THIS delivery run the generation? Called in the receive transaction (atomic with the
// running-mark) so a stale attempt can't slip in between read and write.
//   - no slot yet                      -> run (first time)
//   - slot owned by a NEWER attempt    -> skip (a retry superseded this delivery)
//   - this attempt already terminal    -> skip (duplicate of finished work)
//   - otherwise (running, same attempt, or older terminal being retried) -> run
// Running + same attempt still returns true: a redelivery after a crash MUST be able to take over
// an abandoned `running` slot, and a concurrent same-attempt duplicate is allowed (harmless — the
// completion CAS dedups the write).
export function shouldRun(slot, attempt = 0) {
  if (!slot) return true;
  const a = slot.attempt ?? 0;
  if (a > attempt) return false;                 // newer attempt owns/finished this slot
  if (isTerminal(slot) && a === attempt) return false; // this exact attempt already terminal
  return true;
}

// The completion CAS body. Returns the fields to write, or null to no-op (lost the race / superseded).
// Run inside a Firestore transaction: the txn re-reads `slot` on a concurrent commit, so the loser
// re-evaluates here against the winner's write and returns null.
//   - slot owned by a NEWER attempt        -> null (don't clobber a retry that overtook us)
//   - this/newer attempt already terminal  -> null (first writer already won)
//   - otherwise                            -> write {status, attempt, response, outcome}
export function completionWrite(slot, { attempt = 0, status, response = "", outcome = null }) {
  const a = slot?.attempt ?? 0;
  if (a > attempt) return null;                        // superseded by a newer attempt
  if (isTerminal(slot) && a >= attempt) return null;   // already terminal for this/newer attempt
  return { status, attempt, response, outcome };
}
