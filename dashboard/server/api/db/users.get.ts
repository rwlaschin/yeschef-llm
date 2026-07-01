import { resolveEnv } from '../../utils/envConfig'
import { getMongoClient } from '../../utils/mongo'

export default defineEventHandler(async (event) => {
  const { env } = getQuery(event)
  const cfg = resolveEnv(env as string)
  try {
    const client = await getMongoClient(cfg.mongoUri!)
    const db = client.db(cfg.mongoDb)
    const users = await db.collection('entities').find({}).toArray()

    return users
  } catch (err) {
    console.error('Failed to fetch users:', err)
    throw createError({
      statusCode: 500,
      statusMessage: `Failed to fetch users: ${err.message}`,
    })
  }
})
