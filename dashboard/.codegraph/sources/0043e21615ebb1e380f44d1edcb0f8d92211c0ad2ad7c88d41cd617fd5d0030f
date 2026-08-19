import { getCollection } from '../../utils/db'

// List prompt_library entries (newest first), excluding soft-deleted ones.
export default defineEventHandler(async () => {
  try {
    const collection = await getCollection('prompt_library')
    return await collection.find({ isDeleted: { $ne: true } }).sort({ updatedAt: -1 }).toArray()
  } catch (error: any) {
    throw createError({ statusCode: 500, statusMessage: error.message || 'Failed to fetch prompts' })
  }
})
