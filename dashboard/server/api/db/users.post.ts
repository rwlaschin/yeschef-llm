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
  const body = await readBody(event)
  const username = (body?.username || '').trim()
  const role = (body?.role || '').trim()
  const companyId = (body?.companyId || '').trim()
  if (!username || !role || !companyId) {
    throw createError({ statusCode: 400, statusMessage: 'username, role and companyId are required' })
  }
  const cfg = resolveEnv(body?.env)
  try {
    const client = await getMongoClient(cfg.mongoUri!)
    const db = client.db(cfg.mongoDb)
    const doc = { username, role, companyId, createdAt: new Date() }
    const result = await db.collection('users').insertOne(doc)
    return { _id: result.insertedId, ...doc }
  } catch (err: any) {
    console.error('Failed to create user:', err)
    throw createError({ statusCode: 500, statusMessage: `Failed to create user: ${err.message}` })
  }
})
