// Where a prompt_library fragment is assembled, and the marker layout that makes it possible.
//
// This lives in config/ because it is the ONE thing three separately-packaged consumers must agree
// on byte-for-byte: compose.js (Firebase function, ships `functions/`, which symlinks config/), the
// worker (its image COPYs config/), and the dashboard. config/ is the project's existing answer to
// exactly this — models.js, yaml.js and regions.js are shared the same way.
//
// A section and its marker share ONE name: `relatesTo: "pass"` is placed at `{pass}`. Two names for
// one thing is how includeInOutput/includeInResults became a pair nobody could grep for.
//
// `system` is the system MESSAGE — a separate message before the user message, and where every
// fragment authored before placement existed still lives. The other five are positions INSIDE the
// user message. "trailing" and "system" both read as "at the end" and are not the same thing, which
// is why system is a named value rather than a blank.
export const SYSTEM = "system";
export const SECTIONS = ["leading", "trailing", "conditions", "pass", "fail"];

// Listed in the order they appear in the user message; `system` last because it is a DIFFERENT
// message, not a position in this one.
export const RELATES_TO = [...SECTIONS, SYSTEM];

export const MARKER = Object.fromEntries(SECTIONS.map((s) => [s, `{${s}}`]));

export const MARKER_PATTERN = `\\{(${SECTIONS.join("|")})\\}`;

// The marker layout, in one place. compose.js `renderUnit` emits exactly this per fan-out unit; the
// dashboard preview builds it from the step record; the worker substitutes into it at send time.
export const withMarkers = (instruction, pass, fail) =>
  `{leading}\n${instruction ?? ""}\n{trailing}\n{conditions}\n\nPass: ${pass ?? ""}\n{pass}\nFail: ${fail ?? ""}\n{fail}`;

// What each placement MEANS, in the terms of the prompt the model receives. Lives here beside the
// vocabulary so the label and the behaviour cannot drift, and so every surface says the same thing.
// The UI shows these — never the raw `{leading}` token, which is an engine detail an author has no
// use for and cannot act on.
export const SECTION_DESCRIPTION = {
  system: "In the system message, before the request",
  leading: "Opens the request, above the step's instructions",
  trailing: "Straight after the step's instructions",
  conditions: "Between the instructions and the Pass criteria",
  pass: "Straight after the Pass criteria",
  fail: "Straight after the Fail criteria — the last thing the model reads",
};

// The ONE decision about what `relatesTo` is allowed to reach the database. Both write handlers
// (dashboard/server/api/admin/prompt.post.ts and prompt.put.ts) call this instead of each holding
// its own copy of the vocabulary — they are the only writers, and `dashboard/**` is not in the test
// glob, so logic left in them is covered by nothing. Here it runs under config/**/*.test.js.
//
// Unrecognised → SYSTEM, matching what assembly does with an unknown value at read time. The two
// must agree: if the writer stored something assembly would not recognise, a fragment would sit in
// the database claiming a placement it never gets.
export const normalizeRelatesTo = (value) => (RELATES_TO.includes(value) ? value : SYSTEM);

// ---- Assembly -------------------------------------------------------------------------------
// ONE implementation, here, for the same reason the vocabulary is here. It used to exist twice —
// once in the worker and once in the dashboard — with a test asserting the two agreed byte for
// byte. Two implementations plus a test proving they match is strictly worse than one
// implementation: the test can only ever tell you they have already diverged.

// Stray markdown escape backslashes ("\#", "\-") that older editor saves left in stored content.
const unescape = (c) => String(c || "").replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1");

// Fragments for a type, in send order. Plain code-unit sort on the order key — must match the
// dashboard's lexBetween ordering, never localeCompare.
export function fragmentsFor(prompts, type, { includeInactive = true } = {}) {
  return (prompts || [])
    .filter((p) => p && !p.isDeleted && (includeInactive || p.active) && p.mapping && p.mapping[type] != null)
    .sort((a, b) => {
      const x = String(a.mapping[type]), y = String(b.mapping[type]);
      return x < y ? -1 : x > y ? 1 : 0;
    })
    // An unset or unrecognised relatesTo resolves to the system message — the pre-existing behaviour.
    .map((p) => ({ prompt: p, section: SECTIONS.includes(p.relatesTo) ? p.relatesTo : SYSTEM, content: unescape(p.content) }))
    // Whitespace-only content contributes nothing but would join as a blank section.
    .filter((f) => f.content.trim());
}

// → { system, instructions, parts }. Every marker replaced; a section no fragment claims collapses
// to nothing rather than leaving a blank gap. No markers (every plan frozen before placement
// shipped, and every non-plan path) → all fragments in the system message, instruction untouched.
export function assembleFor(prompts, type, instructions, opts = {}) {
  const text = String(instructions ?? "");
  const parts = fragmentsFor(prompts, type, opts);
  // A FRESH non-global regex for the test. A module-level /g regex advances lastIndex on .test(),
  // so alternate calls would report "no markers" → fallback → markers ship to the model verbatim.
  const hasMarkers = new RegExp(MARKER_PATTERN).test(text);

  if (!hasMarkers) return { system: parts.map((f) => f.content).join("\n\n"), instructions: text, parts };

  const system = parts.filter((f) => f.section === SYSTEM).map((f) => f.content).join("\n\n");
  const bySection = {};
  for (const f of parts) if (f.section !== SYSTEM) (bySection[f.section] ||= []).push(f.content);

  const filled = text.replace(new RegExp(MARKER_PATTERN, "g"), (_, section) => (bySection[section] || []).join("\n\n"));
  // A marker that resolved to nothing leaves its own line behind; drop the runs of blank lines it
  // creates so a claimed and an unclaimed section produce the same shape either side.
  return { system, instructions: filled.replace(/\n{3,}/g, "\n\n").replace(/^\n+|\s+$/g, ""), parts };
}
