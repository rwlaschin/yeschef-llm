// steps/outcome.js — pull the trailing status block out of a STREAMED response.
//
// Marker format (our tweak of developit-ai's PLAN_STATUS block — see docs/design/plan-orchestration.md):
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

// The literal openings a trailing partial could still become: "@", "@@", "@@:", "@@::", "@@::P" …
// "@@::PASS", "@@::F" … "@@::FAIL". Withhold from there — the next chunk may complete it.
const OPENING_MARKS = ["@@::PASS", "@@::FAIL"];

// Earliest index at which a trailing PARTIAL of any `marker` begins, else -1. Derived from the
// marker text, so a new marker needs no new regex — used for both the status block and THINKING.
function trailingPartialIndex(s, ...marks) {
  let at = -1;
  for (const marker of marks) {
    for (let n = Math.min(s.length, marker.length - 1); n > 0; n--) {
      if (marker.toUpperCase().startsWith(s.slice(s.length - n).toUpperCase())) {
        at = at < 0 ? s.length - n : Math.min(at, s.length - n);
        break;
      }
    }
  }
  return at;
}

// A step may be told to show its WORKING between markers before the deliverable. That region is not
// the deliverable: it must not reach the stored response, the next step's context, or the live
// stream. Same class as the status block above, so it is removed on the same two paths.
//
// The working is KEPT, not discarded — splitOutcome returns it as `thinking` so a wrong row can be
// diagnosed from the reasoning that produced it. It is separated from the deliverable, not deleted.
//
// BOTH markers required. An unterminated block (the model opened it and never closed it) is LEFT
// ALONE: eating to end of string would delete the deliverable, and since the status block is parsed
// first a PASS would already have been extracted — storing an empty response marked success. A
// visible unclosed marker is a defect the caller can see; a silently emptied run is not.
// The trailing \n? closes the gap the removal leaves between surrounding lines.
const THINKING = /---\s*THINKING START\s*---\n?([\s\S]*?)\n?---\s*THINKING END\s*---\n?/g;
const THINKING_OPENING = /---\s*THINKING START\s*---/;
const THINKING_MARK = "--- THINKING START ---";



// What is safe to render right now, given the full text received so far.
export function visibleResponse(full) {
  let s = (full ?? "").replace(THINKING, "");
  const think = s.match(THINKING_OPENING);
  if (think) s = s.slice(0, think.index);                        // block opened → hold from here
  else {
    const i = trailingPartialIndex(s, THINKING_MARK);
    if (i > -1) s = s.slice(0, i);                               // tail may become the opening
  }
  s = s.replace(/\s+$/, "");
  const open = s.match(OPENING);
  if (open) return s.slice(0, open.index).replace(/\s+$/, ""); // block started → freeze here
  const pre = trailingPartialIndex(s, ...OPENING_MARKS);
  if (pre > -1) return s.slice(0, pre).replace(/\s+$/, "");     // tail may become the opening → hold it
  return s;
}

// Final split once the stream is complete → { status, reason, clean }:
//   status = "PASS" | "FAIL" | null (no block emitted).
//   reason = the FAIL explanation (empty for PASS / none).
//   clean  = the response with the block (and everything from the opening on) removed.
//   thinking = the working captured from any THINKING block(s), kept for diagnosis. "" if none.
// The caller maps PASS → success and FAIL → fail, and stores `reason` in the run's `outcome`.
export function splitOutcome(full) {
  const raw = full ?? "";
  const thinking = [...raw.matchAll(THINKING)].map((m) => m[1].trim()).filter(Boolean).join("\n\n");
  const s = raw.replace(THINKING, "");
  const m = s.match(MARKER); // well-formed block, with the closing ::@@>
  if (m) return { status: m[1] ? "PASS" : "FAIL", reason: (m[2] || "").trim(), thinking, clean: s.slice(0, m.index).replace(/\s+$/, "") };
  // No well-formed block. Either the close dropped mid-stream, or a FAIL came without its required
  // reason (a bare "@@::FAIL::@@"). Pull the opening out anyway (eat to end) so streaming's
  // withheld text isn't re-revealed as a half-block. A conforming model never reaches here.
  const open = s.match(OPENING);
  if (!open) return { status: null, reason: "", thinking, clean: s.replace(/\s+$/, "") };
  const status = open[1].toUpperCase();
  let reason = s.slice(open.index + open[0].length).replace(/::@@\s*$/, "").replace(/^:\s*/, "").trim();
  // A FAIL is required to carry a reason. If it didn't (bare block / dropped close), surface that
  // explicitly rather than storing an empty outcome that reads as a mystery failure.
  if (status === "FAIL" && !reason) reason = "no reason given";
  return { status, reason, thinking, clean: s.slice(0, open.index).replace(/\s+$/, "") };
}
