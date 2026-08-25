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

// ---- Scope: which PIPELINE a prompt belongs to ------------------------------------------------
// The point is subtype REUSE. `compliance`, `query`, `task` are all useful in both a meal-plan build
// and a task list, but they need different prompt text in each — and forking the subtype per pipeline
// (`compliance_task`, `compliance_menu`…) is a subtype explosion that the planner menu, MESSAGE_TYPES
// and every mapping would then have to carry. So the SUBTYPE stays one name and the PROMPT carries
// the scope: same `mapping: { compliance: "a0" }`, two docs, different `scopes`.
//
// Shape on a prompt_library doc, alongside `mapping`/`active`/`relatesTo`:
//   scopes: ["menu_plan"] | ["task_list"] | ["menu_plan", "task_list"] | absent
// An ARRAY, not a second mapping level: `mapping[type]` is a lexBetween ORDER KEY and must stay one,
// and a prompt's order within a type does not differ per pipeline.
export const PROMPT_SCOPES = ["menu_plan", "task_list"];

// BACKWARD COMPATIBILITY, and the only reason this is a function: every prompt written before this
// existed has NO `scopes`, and every one of them is a meal-plan prompt (task lists had no prompts at
// all — `task` and `analytics_widget` map zero). So absent/empty means menu_plan, NOT "both" and NOT
// "neither". Reading it as "both" would leak the entire meal-plan prompt library into task lists;
// reading it as "neither" would silently empty the meal-plan pipeline. No backfill is needed.
export const inScope = (prompt, scope) => {
  const s = prompt?.scopes;
  return Array.isArray(s) && s.length ? s.includes(scope) : scope === "menu_plan";
};

// A job's pipeline, from the job doc's `type`. /ai/tquery writes type:"tquery"; every meal-plan build
// (type "plan", "meal_plan", or absent on older docs) is menu_plan. Default-menu_plan on purpose —
// same reason as above: an unrecognised type must not empty the pipeline that has all the prompts.
export const scopeOfJobType = (jobType) => (jobType === "tquery" ? "task_list" : "menu_plan");

// The ONE decision about what `scopes` may reach the database — the counterpart of
// normalizeRelatesTo, for the dashboard's two write handlers. Unknown values dropped; nothing left
// (including "the author unchecked everything") stores `null`, which reads back as menu_plan.
export const normalizeScopes = (value) => {
  const list = [...new Set((Array.isArray(value) ? value : []).filter((s) => PROMPT_SCOPES.includes(s)))];
  return list.length ? PROMPT_SCOPES.filter((s) => list.includes(s)) : null;
};

// ---- Assembly -------------------------------------------------------------------------------
// ONE implementation, here, for the same reason the vocabulary is here. It used to exist twice —
// once in the worker and once in the dashboard — with a test asserting the two agreed byte for
// byte. Two implementations plus a test proving they match is strictly worse than one
// implementation: the test can only ever tell you they have already diverged.

// Stray markdown escape backslashes ("\#", "\-") that older editor saves left in stored content.
const unescape = (c) => String(c || "").replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1");

// Fragments for a type, in send order. Plain code-unit sort on the order key — must match the
// dashboard's lexBetween ordering, never localeCompare.
// `scope` filters by PIPELINE (see inScope). Undefined = no scope filter, which is what every
// pre-existing caller passes — the dashboard preview and the tests keep their exact behaviour, and
// only the worker's step path, which knows the job's type, narrows it.
export function fragmentsFor(prompts, type, { includeInactive = true, scope } = {}) {
  return (prompts || [])
    .filter((p) => p && !p.isDeleted && (includeInactive || p.active) && p.mapping && p.mapping[type] != null)
    .filter((p) => scope === undefined || inScope(p, scope))
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
