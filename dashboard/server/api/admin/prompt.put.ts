import { getCollection } from '../../utils/db'
// #prompt-sections, not a relative path: Nitro rewrites relative paths into .nuxt/dev and the
// import fails at runtime. Same reason #models exists (nuxt.config.ts).
import { normalizeRelatesTo, normalizeScopes } from '#prompt-sections'
import { ObjectId } from 'mongodb'

// Update a prompt_library entry by ?id=.
export default defineEventHandler(async (event) => {
  try {
    const id = getQuery(event).id as string
    const body = await readBody(event)
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id parameter' })

    let objectId
    try { objectId = new ObjectId(id) } catch { throw createError({ statusCode: 400, statusMessage: 'Invalid id format' }) }

    const collection = await getCollection('prompt_library')
    const existing = await collection.findOne({ _id: objectId })
    if (!existing) throw createError({ statusCode: 404, statusMessage: 'Prompt not found' })

    const update: Record<string, any> = {
      mapping: body?.mapping && typeof body.mapping === 'object' ? body.mapping : {},
      active: !!body?.active,
      content: body?.content || '',
      updatedAt: new Date(),
    }
    if (body?.modelOverride !== undefined) update.modelOverride = body.modelOverride  // null = explicitly cleared
    if (body?.name !== undefined) update.name = typeof body.name === 'string' ? body.name.trim() : ''
    // Unrecognised placement → the system message, which is what assembly does with it anyway.
    if (body?.relatesTo !== undefined) update.relatesTo = normalizeRelatesTo(body.relatesTo)
    // Only touched when the caller actually sends it, so a drag-reorder or an active toggle can
    // never rewrite the scope. null (nothing valid sent) reads back as menu_plan, like an absent field.
    if (body?.scopes !== undefined) update.scopes = normalizeScopes(body.scopes)
    await collection.updateOne({ _id: objectId }, { $set: update })
    return await collection.findOne({ _id: objectId })
  } catch (error: any) {
    throw createError({
      statusCode: error.statusCode || 500,
      statusMessage: error.statusMessage || error.message || 'Failed to update prompt',
    })
  }
})
