import { MongoClient } from 'mongodb'
import { resolveEnv } from '../../utils/envConfig'

const clients: Record<string, MongoClient> = {}

async function getMongoClient(uri: string) {
  if (!clients[uri]) {
    const client = new MongoClient(uri)
    await client.connect()
    clients[uri] = client
  }
  return clients[uri]
}

export default defineEventHandler(async (event) => {
  const { env } = getQuery(event)
  const cfg = resolveEnv(env as string)
  try {
    const client = await getMongoClient(cfg.mongoUri!)
    const db = client.db(cfg.mongoDb)
    const companies = await db.collection('companies').find({}).toArray()

    return companies
  } catch (err) {
    console.error('Failed to fetch companies:', err)
    throw createError({
      statusCode: 500,
      statusMessage: `Failed to fetch companies: ${err.message}`,
    })
  }
})
