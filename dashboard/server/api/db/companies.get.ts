import { resolveEnv } from '../../utils/envConfig'
import { getMongoClient } from '../../utils/mongo'

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
