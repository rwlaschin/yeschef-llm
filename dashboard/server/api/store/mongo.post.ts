import { MongoClient } from 'mongodb'

let cachedClient: MongoClient | null = null

async function getMongoClient() {
  if (cachedClient) {
    return cachedClient
  }

  const uri = process.env.MONGO_URI
  const client = new MongoClient(uri)
  await client.connect()
  cachedClient = client
  return client
}

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event)
    const { collection, query } = body

    if (!collection) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Collection name is required',
      })
    }

    const client = await getMongoClient()
    const db = client.db(process.env.MONGO_DB)
    const results = await db.collection(collection).find(query || {}).limit(50).toArray()

    return results
  } catch (err) {
    console.error('MongoDB query failed:', err)
    throw createError({
      statusCode: 500,
      statusMessage: `MongoDB query failed: ${err.message}`,
    })
  }
})
