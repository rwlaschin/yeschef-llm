// steps/outcome.js — pull the trailing status block out of a STREAMED response.
//
// Marker format (our tweak of developit-ai's PLAN_STATUS block — see PLAN_ORCHESTRATION_SPEC.md):
//
//   PASS → @@::PASS::@@
//   FAIL → @@::FAIL:<REASON>::@@
//
//   • REQUIRED DELIMITERS: the literal "@@::" at the start and "::@@" at the end. NO angle brackets —
//     weak models drop "<"/">" ("<" is special-token territory to the tokenizer) and HTML/markdown
//     renderers eat "<…>" as a tag; the 8B reproduces the bare "@@::"/"::@@" verbatim.
//   • PASS sits alone between the delimiters ("@@::PASS::@@"). FAIL adds a SINGLE-colon reason:
//     "@@::FAIL:<reason>::@@" — one ":" between FAIL and the reason, not two.
//   • We dropped developit's "?!"/"!?" and "PLAN_STATUS" word; the "@@:: … ::@@" bookend is
//     distinctive enough that ordinary prose can't false-trigger.
//
// STREAMING: the response is written to Firestore incrementally, so the block arrives split
// across chunk boundaries — a flush can land with the buffer ending on "@" or "@@::FA". We must
// never write a half-block into the live response. So visibleResponse(full), called each flush,
// freezes the visible text the moment the block OPENS and withholds any trailing run that could
// still BECOME the opening. splitOutcome(full) does the final separation once the stream ends.

// Full block (final parse): "@@::PASS::@@" or "@@::FAIL:<reason>::@@". PASS stands alone;
// FAIL REQUIRES a single-colon reason of ≥1 char — a bare "@@::FAIL::@@" is non-compliant and is
// NOT matched here (the optional-reason form would have silently passed it as a fail with an empty
// outcome). splitOutcome surfaces such a reasonless fail instead. The closing "::@@" terminates
// the reason (the prompt forbids ":" inside it). Capture: group 1 = "PASS" (pass), group 2 = reason (fail).
const MARKER = /@@::(?:(PASS)|FAIL:\s*([\s\S]+?))\s*::@@/i;

// The OPENING alone — "@@::PASS" / "@@::FAIL" with no close yet. Once this appears mid-stream
// the block has begun, so the visible response freezes here even before "::@@" streams in.
const OPENING = /@@::(PASS|FAIL)/i;

// A trailing PARTIAL of the opening, anchored at end of string: "@", "@@", "@@:",
// "@@::", "@@::P" … "@@::PASS", "@@::F" … "@@::FAIL". Withhold from here — the next chunk may
// complete it. Nested optionals so it only matches a genuine prefix of "@@::(PASS|FAIL)".
const OPENING_PREFIX = /@(?:@(?::(?::(?:P(?:A(?:S(?:S)?)?)?|F(?:A(?:I(?:L)?)?)?)?)?)?)?$/i;

// What is safe to render right now, given the full text received so far.
export function visibleResponse(full) {
  const s = full ?? "";
  const open = s.match(OPENING);
  if (open) return s.slice(0, open.index).replace(/\s+$/, ""); // block started → freeze here
  const pre = s.match(OPENING_PREFIX);
  if (pre) return s.slice(0, pre.index).replace(/\s+$/, "");    // tail may become the opening → hold it
  return s;
}

// Final split once the stream is complete → { status, reason, clean }:
//   status = "PASS" | "FAIL" | null (no block emitted).
//   reason = the FAIL explanation (empty for PASS / none).
//   clean  = the response with the block (and everything from the opening on) removed.
// The caller maps PASS → success and FAIL → fail, and stores `reason` in the run's `outcome`.
export function splitOutcome(full) {
  const s = full ?? "";
  const m = s.match(MARKER); // well-formed block, with the closing ::@@>
  if (m) return { status: m[1] ? "PASS" : "FAIL", reason: (m[2] || "").trim(), clean: s.slice(0, m.index).replace(/\s+$/, "") };
  // No well-formed block. Either the close dropped mid-stream, or a FAIL came without its required
  // reason (a bare "@@::FAIL::@@"). Pull the opening out anyway (eat to end) so streaming's
  // withheld text isn't re-revealed as a half-block. A conforming model never reaches here.
  const open = s.match(OPENING);
  if (!open) return { status: null, reason: "", clean: s.replace(/\s+$/, "") };
  const status = open[1].toUpperCase();
  let reason = s.slice(open.index + open[0].length).replace(/::@@\s*$/, "").replace(/^:\s*/, "").trim();
  // A FAIL is required to carry a reason. If it didn't (bare block / dropped close), surface that
  // explicitly rather than storing an empty outcome that reads as a mystery failure.
  if (status === "FAIL" && !reason) reason = "no reason given";
  return { status, reason, clean: s.slice(0, open.index).replace(/\s+$/, "") };
}
