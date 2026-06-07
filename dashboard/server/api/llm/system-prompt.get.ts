import { getCollection } from '../../utils/db'

// Assemble the system prompt for a message type from prompt_library.
// Mirrors the worker's systemPromptFor(): non-deleted prompts mapped to the type,
// sorted ascending by their lexBetween order key (plain code-unit compare), joined.
// So the dashboard preview matches what the worker actually builds.
export default defineEventHandler(async (event) => {
  const type = String(getQuery(event).type || '')
  if (!type) return ''

  const col = await getCollection('prompt_library')
  const prompts = await col.find({ isDeleted: { $ne: true } }).toArray()

  return prompts
    .filter((p) => p.mapping && p.mapping[type] != null)
    .sort((a, b) => {
      const x = String(a.mapping[type]), y = String(b.mapping[type])
      return x < y ? -1 : x > y ? 1 : 0
    })
    .map((p) => p.content)
    .filter(Boolean)
    // strip stray escape backslashes from legacy editor saves (matches the worker)
    .map((c) => c.replace(/\\([\\`*_{}[\]()#+\-.!>])/g, '$1'))
    .join('\n\n')
})
