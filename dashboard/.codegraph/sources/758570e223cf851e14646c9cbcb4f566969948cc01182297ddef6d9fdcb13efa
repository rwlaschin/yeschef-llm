import { resolveEnv } from '../../utils/envConfig'
import { getMongoClient } from '../../utils/mongo'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const name = (body?.name || '').trim()
  if (!name) {
    throw createError({ statusCode: 400, statusMessage: 'Company name is required' })
  }
  const cfg = resolveEnv(body?.env)
  try {
    const client = await getMongoClient(cfg.mongoUri!)
    const db = client.db(cfg.mongoDb)
    // Company names are globally unique (joining an existing one is invite-only).
    const clash = await db.collection('companies').findOne({ name })
    if (clash) {
      throw createError({ statusCode: 409, statusMessage: `A company named "${name}" already exists.` })
    }
    const doc = { name, plan: null, stripeCustomerId: null, permissions: [], createdAt: new Date() }
    const result = await db.collection('companies').insertOne(doc)
    return { _id: result.insertedId, ...doc }
  } catch (err: any) {
    console.error('Failed to create company:', err)
    throw createError({
      statusCode: err.statusCode || 500,
      statusMessage: err.statusMessage || `Failed to create company: ${err.message}`,
    })
  }
})
