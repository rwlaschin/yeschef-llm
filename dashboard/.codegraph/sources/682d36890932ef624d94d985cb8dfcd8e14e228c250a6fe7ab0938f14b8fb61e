// Shares the HMR-safe (globalThis-cached) client so server hot reloads don't
// leak connection pools — see server/utils/mongo.ts.
import { getMongoClient } from './mongo'

const uri = () => process.env.MONGO_URI || 'mongodb://localhost:27017'
const dbName = () => process.env.MONGO_DB || 'yeschef_dev'

export async function getCollection(name) {
  const client = await getMongoClient(uri())
  return client.db(dbName()).collection(name)
}

export async function getDb() {
  const client = await getMongoClient(uri())
  return client.db(dbName())
}
