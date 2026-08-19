import { getCollection } from '../../utils/db'
import { validateTool } from '../../utils/toolSchema'

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event)

    // Validate input
    if (!validateTool(body)) {
      throw createError({
        statusCode: 400,
        statusMessage: `Validation failed: ${validateTool.errors?.map(e => e.message).join(', ')}`
      })
    }

    const collection = await getCollection('llmtools')

    // Check if tool with this name already exists
    const existing = await collection.findOne({
      name: body.name,
      isDeleted: false
    })

    const version = existing ? (existing.version || 0) + 1 : 1

    const tool = {
      name: body.name,
      version,
      active: body.active,
      isDeleted: false,
      type: body.type || 'custom',
      definition: body.definition,
      implementation: body.implementation || {},
      createdAt: new Date(),
      updatedAt: new Date()
    }

    const result = await collection.insertOne(tool)

    return {
      _id: result.insertedId,
      ...tool
    }
  } catch (error: any) {
    throw createError({
      statusCode: error.statusCode || 500,
      statusMessage: error.statusMessage || error.message || 'Failed to create tool'
    })
  }
})
