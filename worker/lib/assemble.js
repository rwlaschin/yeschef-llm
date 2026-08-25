// Fragment placement for the worker — a thin re-export of the ONE implementation in
// config/promptSections.js, which the Firebase function (via the functions/config symlink) and the
// dashboard (via the #prompt-sections alias) also use.
//
// It lived here as a second copy until a red-team pass showed the cost: two implementations plus a
// test asserting they agree is strictly worse than one, because that test can only tell you they
// have ALREADY diverged. Nothing but re-exports belongs in this file.
//
// A `prompt_library` fragment carries `relatesTo`, naming the part of the step it belongs beside.
// Blank (the default, and every fragment authored before placement existed) means the system
// message — today's behaviour, unchanged.
//
// Substitution happens at SEND time, not in compose: a job freezes its `plan[]`, so assembling
// fragments at compose time would freeze them too and destroy the one property that puts prompts in
// the database at all — edit a fragment, every running job picks it up on its next call.
//
// NO-MARKER FALLBACK: an instruction with no markers (every plan frozen before this shipped, and
// every non-plan path — query, planner, compliance) gets ALL fragments in the system message,
// exactly as `systemPromptFor` has always done. That is what makes this need no backfill.
export {
  SYSTEM,
  SECTIONS,
  RELATES_TO,
  MARKER,
  MARKER_PATTERN,
  withMarkers,
  fragmentsFor,
  assembleFor,
  PROMPT_SCOPES,
  inScope,
  scopeOfJobType,
  normalizeScopes,
} from "../../config/promptSections.js";
