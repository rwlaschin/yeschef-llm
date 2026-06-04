import { getCollection } from '../../utils/db'
import { validateTool } from '../../utils/toolSchema'
import { ObjectId } from 'mongodb'

export default defineEventHandler(async (event) => {
  try {
    const query = getQuery(event)
    const id = query.id as string
    const body = await readBody(event)

    if (!id) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Missing id parameter'
      })
    }

    // Validate input
    if (!validateTool(body)) {
      throw createError({
        statusCode: 400,
        statusMessage: `Validation failed: ${validateTool.errors?.map(e => e.message).join(', ')}`
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

    // Check if tool exists
    const existing = await collection.findOne({ _id: objectId })
    if (!existing) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Tool not found'
      })
    }

    const result = await collection.updateOne(
      { _id: objectId },
      {
        $set: {
          name: body.name,
          active: body.active,
          type: body.type || 'custom',
          definition: body.definition,
          implementation: body.implementation || {},
          updatedAt: new Date()
        }
      }
    )

    if (result.modifiedCount === 0) {
      throw createError({
        statusCode: 500,
        statusMessage: 'Failed to update tool'
      })
    }

    return await collection.findOne({ _id: objectId })
  } catch (error: any) {
    throw createError({
      statusCode: error.statusCode || 500,
      statusMessage: error.statusMessage || error.message || 'Failed to update tool'
    })
  }
})
