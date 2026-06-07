import { getCollection } from '../../utils/db'
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

    await collection.updateOne({ _id: objectId }, {
      $set: {
        mapping: body?.mapping && typeof body.mapping === 'object' ? body.mapping : {},
        active: !!body?.active,
        content: body?.content || '',
        updatedAt: new Date(),
      },
    })
    return await collection.findOne({ _id: objectId })
  } catch (error: any) {
    throw createError({
      statusCode: error.statusCode || 500,
      statusMessage: error.statusMessage || error.message || 'Failed to update prompt',
    })
  }
})
