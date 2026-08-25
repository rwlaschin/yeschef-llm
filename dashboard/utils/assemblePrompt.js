// Prompt assembly for the dashboard preview. The ASSEMBLY ITSELF is not implemented here — it comes
// from config/promptSections.js, the same function the worker runs. That is what makes "the preview
// shows what the worker sends" true by construction instead of by a test that can only tell you the
// two copies have already diverged.
//
// '#prompt-sections' is aliased in nuxt.config.ts. It must NOT be a relative path: '../../config/…'
// resolves correctly on disk and then fails at runtime once Nitro rewrites it into .nuxt/dev —
// "Cannot find module '/Users/<you>/config/promptSections.js'".
import { assembleFor, SYSTEM, SECTIONS, RELATES_TO, MARKER, SECTION_DESCRIPTION, withMarkers } from '#prompt-sections'

export { SYSTEM, SECTIONS, RELATES_TO, MARKER, SECTION_DESCRIPTION, withMarkers }

// Which PIPELINE a prompt fragment serves. VOCABULARY AND SEMANTICS COME FROM #prompt-sections —
// the same `inScope` the worker filters with. Do not re-derive either here: a second copy is exactly
// how this shipped backwards once (a dashboard that stored "both" as [] against a reader for which
// []/absent means menu_plan ONLY, silently dropping the task-list half).
// Absent/empty = menu_plan only, because every prompt that predates the field is a meal-plan prompt.
export { PROMPT_SCOPES, inScope, scopeOfJobType, normalizeScopes } from '#prompt-sections'

// Plain-language labels for the three states an author may choose. `both` is not a stored value —
// it writes ["menu_plan","task_list"] — but it is the only honest way to offer the choice, since
// "nothing selected" reads back as meal-plans-only rather than as no restriction.
export const SCOPE_CHOICES = [
  { value: 'menu_plan', label: 'Meal plans only' },
  { value: 'task_list', label: 'Task lists only' },
  { value: 'both',      label: 'Both meal plans and task lists' },
]
export const SCOPE_LABEL = { menu_plan: 'Meal plans', task_list: 'Task lists' }

// `includeInactive` mirrors the worker's INCLUDE_INACTIVE (dev loads inactive prompts too, prod
// doesn't). It DEFAULTS TO FALSE here so the preview shows what production would actually send —
// an inactive fragment appearing in the preview is how a safety rule looks present while being
// dropped by the worker's `active: true` filter.
export const assemblePrompt = (prompts, type, { includeInactive = false } = {}) => {
  const { parts } = assembleFor(prompts, type, '', { includeInactive })
  return { parts, text: parts.map((p) => p.content).join('\n\n') }
}

// The FULL message pair for a type + a step's rendered instruction — what the worker sends, in the
// order it sends it. Without a step there is nothing to place fragments against, so every fragment
// falls back to the system message exactly as an unmarked instruction does.
export const assembleFull = (prompts, type, instructions, { includeInactive = false } = {}) =>
  assembleFor(prompts, type, instructions, { includeInactive })

// Two prompts sharing an order key resolve in whatever order Mongo returns them — an authoring
// hazard the author can only see here.
export const tiedOrderKeys = (parts, type) => {
  const seen = new Set(), tied = new Set()
  for (const { prompt } of parts) {
    const k = String(prompt.mapping[type])
    if (seen.has(k)) tied.add(k)
    seen.add(k)
  }
  return tied
}
