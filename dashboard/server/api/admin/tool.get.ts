import { getCollection } from '../../utils/db'
import { ObjectId } from 'mongodb'

export default defineEventHandler(async (event) => {
  try {
    const query = getQuery(event)
    const id = query.id as string

    if (!id) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Missing id parameter'
      })
    }

    let objectId
    try {
      objectId = new ObjectId(id)
    } catch {
      throw createError({
        statusCode: 400,
        statusMessage: 'Invalid id format'
      })
    }

    const collection = await getCollection('llmtools')
    const tool = await collection.findOne({ _id: objectId })

    if (!tool) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Tool not found'
      })
    }

    return tool
  } catch (error: any) {
    throw createError({
      statusCode: error.statusCode || 500,
      statusMessage: error.statusMessage || error.message || 'Failed to fetch tool'
    })
  }
})
