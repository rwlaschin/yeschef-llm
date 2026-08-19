import { getCollection } from '../../utils/db'
import { ObjectId } from 'mongodb'

// Soft-delete a prompt_library entry by ?id= (and deactivate it so the worker
// never loads it, even before its cache refreshes).
export default defineEventHandler(async (event) => {
  try {
    const id = getQuery(event).id as string
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id parameter' })

    let objectId
    try { objectId = new ObjectId(id) } catch { throw createError({ statusCode: 400, statusMessage: 'Invalid id format' }) }

    const collection = await getCollection('prompt_library')
    const r = await collection.updateOne(
      { _id: objectId },
      { $set: { isDeleted: true, active: false, updatedAt: new Date() } }
    )
    if (r.matchedCount === 0) throw createError({ statusCode: 404, statusMessage: 'Prompt not found' })
    return { success: true }
  } catch (error: any) {
    throw createError({
      statusCode: error.statusCode || 500,
      statusMessage: error.statusMessage || error.message || 'Failed to delete prompt',
    })
  }
})
