import { getDb } from '../../utils/db'

export default defineEventHandler(async (event) => {
  try {
    const db = await getDb()
    const collections = await db.listCollections().toArray()

    return collections.map(col => col.name).sort()
  } catch (error) {
    console.error('Failed to list collections:', error)
    throw createError({
      statusCode: 500,
      statusMessage: error.message || 'Failed to list collections'
    })
  }
})
