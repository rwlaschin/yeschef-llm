import { readdir } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const env = (query.env as string) || 'local'

  const status = {
    databases: {
      mongodb: { ok: false, error: '' },
      firebase: { ok: false, error: '' },
      neo4j: { ok: false, error: '' },
    },
    pubsub: { ok: false, error: '' },
    models: {},
  }

  // Get environment-specific config
  const getEnvConfig = (envName: string) => {
    if (envName === 'production') {
      return {
        mongoUri: process.env.MONGO_URI_PROD || process.env.MONGO_URI,
        gcpProjectId: process.env.GCP_PROJECT_ID_PROD || process.env.GCP_PROJECT_ID,
        pubsubEmulatorHost: process.env.PUBSUB_EMULATOR_HOST_PROD,
        neo4jUri: process.env.NEO4J_URI_PROD || process.env.NEO4J_URI,
        neo4jUsername: process.env.NEO4J_USERNAME_PROD || process.env.NEO4J_USERNAME,
        neo4jPassword: process.env.NEO4J_PASSWORD_PROD || process.env.NEO4J_PASSWORD,
      }
    }
    // local or default
    return {
      mongoUri: process.env.MONGO_URI,
      gcpProjectId: process.env.GCP_PROJECT_ID,
      pubsubEmulatorHost: process.env.PUBSUB_EMULATOR_HOST,
      neo4jUri: process.env.NEO4J_URI,
      neo4jUsername: process.env.NEO4J_USERNAME,
      neo4jPassword: process.env.NEO4J_PASSWORD,
    }
  }

  const config = getEnvConfig(env)

  // Check MongoDB
  try {
    const { MongoClient } = await import('mongodb')
    if (config.mongoUri) {
      const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 2000 })
      await client.connect()
      await client.close()
      status.databases.mongodb = { ok: true, error: '' }
    } else {
      status.databases.mongodb = { ok: false, error: 'URI not configured' }
    }
  } catch (e: any) {
    status.databases.mongodb = { ok: false, error: e.message || 'Connection failed' }
  }

  // Check Firebase (GCP Project ID configured = Firebase available)
  try {
    if (!config.gcpProjectId) {
      status.databases.firebase = { ok: false, error: 'Project ID not configured' }
    } else {
      status.databases.firebase = { ok: true, error: '' }
    }
  } catch (e: any) {
    status.databases.firebase = { ok: false, error: e.message || 'Not configured' }
  }

  // Check Neo4j
  try {
    const { driver, auth } = await import('neo4j-driver')
    if (!config.neo4jUri) {
      status.databases.neo4j = { ok: false, error: 'NEO4J_URI not configured' }
    } else if (!config.neo4jUsername) {
      status.databases.neo4j = { ok: false, error: 'NEO4J_USERNAME not configured' }
    } else if (!config.neo4jPassword) {
      status.databases.neo4j = { ok: false, error: 'NEO4J_PASSWORD not configured' }
    } else {
      const d = driver(config.neo4jUri, auth.basic(config.neo4jUsername, config.neo4jPassword), {
        connectionAcquisitionTimeout: 5000,
        maxConnectionPoolSize: 1,
      })
      try {
        await d.verifyConnectivity()
        status.databases.neo4j = { ok: true, error: '' }
      } finally {
        await d.close()
      }
    }
  } catch (e: any) {
    status.databases.neo4j = { ok: false, error: e.message || 'Connection failed' }
  }

  // Check Pub/Sub
  try {
    const { PubSub } = await import('@google-cloud/pubsub')
    if (!config.gcpProjectId) {
      status.pubsub = { ok: false, error: 'Project ID not configured' }
    } else {
      const pubsub = new PubSub({
        projectId: config.gcpProjectId,
        apiEndpoint: config.pubsubEmulatorHost ? `http://${config.pubsubEmulatorHost}` : undefined,
      })
      await pubsub.getTopic('test').exists()
      status.pubsub = { ok: true, error: '' }
    }
  } catch (e: any) {
    status.pubsub = { ok: false, error: e.message || 'Connection failed' }
  }

  // Check Models from docker/shared folder
  try {
    const sharedPath = join(__dirname, '..', '..', '..', '..', 'docker', 'shared')
    const files = await readdir(sharedPath)

    for (const file of files) {
      const filePath = join(sharedPath, file)
      try {
        const content = await Bun.file(filePath).text()
        status.models[file] = { ok: !content.includes('error'), error: content.trim() }
      } catch {
        status.models[file] = { ok: false, error: 'Could not read' }
      }
    }
  } catch {
    // ./shared folder doesn't exist or is empty - no models yet
  }

  return status
})
