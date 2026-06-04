import { MongoClient } from 'mongodb'

let mongoClient = null
let mongoClientPromise = null

async function getMongoClient() {
  if (mongoClient) {
    return mongoClient
  }

  if (!mongoClientPromise) {
    mongoClientPromise = (async () => {
      try {
        const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017'
        const client = new MongoClient(mongoUri, {
          maxPoolSize: 50,
          minPoolSize: 1,
          maxIdleTimeMS: 10000,
          waitQueueTimeoutMS: 20000
        })
        await client.connect()
        mongoClient = client
        return client
      } catch (error) {
        mongoClientPromise = null
        throw new Error(`Failed to connect to MongoDB: ${error}`)
      }
    })()
  }

  return mongoClientPromise
}

export async function getCollection(name) {
  const client = await getMongoClient()
  const db = client.db(process.env.MONGO_DB || 'yeschef_dev')
  return db.collection(name)
}

export async function getDb() {
  const client = await getMongoClient()
  return client.db(process.env.MONGO_DB || 'yeschef_dev')
}
