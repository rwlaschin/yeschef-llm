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
