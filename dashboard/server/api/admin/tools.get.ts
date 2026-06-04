import { getCollection } from '../../utils/db'

export default defineEventHandler(async () => {
  try {
    const collection = await getCollection('llmtools')
    const tools = await collection.find({ isDeleted: { $ne: true } }).toArray()
    return tools
  } catch (error: any) {
    throw createError({
      statusCode: 500,
      statusMessage: error.message || 'Failed to fetch tools'
    })
  }
})
