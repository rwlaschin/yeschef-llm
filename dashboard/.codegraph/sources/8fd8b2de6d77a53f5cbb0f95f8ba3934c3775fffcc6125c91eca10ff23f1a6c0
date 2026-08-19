import { getCollection } from '../utils/db'

export default defineEventHandler(async (event) => {
  try {
    const query = getQuery(event)
    const inactive = query.inactive === 'true'

    // Base filter: never return deleted
    const filter: any = { isDeleted: false }

    // If inactive=false (default), only return active tools
    // If inactive=true, return both active and inactive
    if (!inactive) {
      filter.active = true
    }

    const collection = await getCollection('llmtools')
    const tools = await collection.find(filter).toArray()

    return tools
  } catch (error: any) {
    throw createError({
      statusCode: 500,
      statusMessage: error.message || 'Failed to fetch tools'
    })
  }
})
