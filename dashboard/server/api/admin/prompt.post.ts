import { getCollection } from '../../utils/db'
// #prompt-sections, not a relative path — see nuxt.config.ts and prompt.put.ts.
import { normalizeRelatesTo, normalizeScopes } from '#prompt-sections'

// Create a prompt_library entry: { mapping:{<type>:<priority>}, active, content }.
export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event)
    const collection = await getCollection('prompt_library')
    const doc = {
      mapping: body?.mapping && typeof body.mapping === 'object' ? body.mapping : {},
      active: !!body?.active,
      content: body?.content || '',
      modelOverride: body?.modelOverride ?? null,   // null → use the request's model
      // Optional label, and which part of the step this fragment is assembled beside. Anything
      // unrecognised resolves to the system message at assembly time (worker/lib/assemble.js), so a
      // bad value degrades to today's behaviour rather than vanishing.
      name: typeof body?.name === 'string' ? body.name.trim() : '',
      relatesTo: normalizeRelatesTo(body?.relatesTo),
      // Which pipeline(s) may use this fragment. normalizeScopes returns null when nothing valid
      // was sent, and null reads back as menu_plan — the same as an absent field. See inScope.
      scopes: normalizeScopes(body?.scopes),
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const result = await collection.insertOne(doc)
    return { _id: result.insertedId, ...doc }
  } catch (error: any) {
    throw createError({
      statusCode: error.statusCode || 500,
      statusMessage: error.statusMessage || error.message || 'Failed to create prompt',
    })
  }
})
