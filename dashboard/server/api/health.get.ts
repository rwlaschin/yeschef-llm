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
    orchestrator: { ok: false, error: '' },
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
    // Bolt failed — ask the Aura API why. A suspended/resuming Free instance is the common case;
    // show that plainly instead of the routing error.
    const state = await auraStatus(config.neo4jUri, env === 'production')
    const label = state === 'paused' || state === 'suspended' ? 'Paused — instance suspended (resume to use)'
      : state === 'resuming' ? 'Resuming… (~1 min)'
      : state === 'suspending' ? 'Suspending…'
      : (state && state !== 'running') ? `Instance ${state}`
      : (e.message || 'Connection failed')
    status.databases.neo4j = { ok: false, error: label }
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
      await pubsub.topic('test').exists()
      status.pubsub = { ok: true, error: '' }
    }
  } catch (e: any) {
    status.pubsub = { ok: false, error: e.message || 'Connection failed' }
  }

  // Check Orchestrator (/ai function — the plan backend). Use 127.0.0.1 for the local
  // emulator: this fetch is server-side (Node), where `localhost` may resolve to IPv6 ::1
  // while the emulator listens on IPv4.
  try {
    const cfg = useRuntimeConfig(event).public
    const base = String(env === 'production' ? cfg.aiBaseUrl : cfg.aiBaseUrlLocal).replace('localhost', '127.0.0.1')
    const res: any = await $fetch(`${base}/health`, { timeout: 3000 })
    status.orchestrator = res?.status === 'ok' ? { ok: true, error: '' } : { ok: false, error: 'unexpected response' }
  } catch (e: any) {
    status.orchestrator = { ok: false, error: e.message || 'Not reachable' }
  }

  // Check Models — source of truth is config/models.js (MODELS), NOT a folder scan.
  //  • local/dev: Ollama runs INSIDE each model's worker container (no host port is
  //    published), so the model is reachable iff its container is running. We ask Docker
  //    directly — the same signal the waker uses. Only dev models exist locally (the 70B
  //    tiers need 2× L4). A model that's "cold" (no recent traffic) is simply not running.
  //  • production: a model is "ok" if its per-model Pub/Sub topic exists (i.e. deployed).
  try {
    const { MODELS, containerOf } = await import('#models') as { MODELS: any[]; containerOf: (m: any) => string }

    if (env === 'production') {
      const { PubSub } = await import('@google-cloud/pubsub')
      const pubsub = config.gcpProjectId ? new PubSub({ projectId: config.gcpProjectId }) : null
      await Promise.all(MODELS.map(async (m) => {
        if (!pubsub) { status.models[m.label] = { ok: false, error: 'Project ID not configured' }; return }
        try {
          const [exists] = await pubsub.topic(m.topic).exists()
          status.models[m.label] = { ok: exists, error: exists ? '' : `topic ${m.topic} not deployed` }
        } catch (e: any) {
          status.models[m.label] = { ok: false, error: e.message || 'check failed' }
        }
      }))
    } else {
      // One `docker ps` → the set of running container names; membership = up.
      let running = new Set<string>()
      let dockerErr = ''
      try {
        const { execFileSync } = await import('node:child_process')
        const out = execFileSync('docker', ['ps', '--format', '{{.Names}}', '--filter', 'status=running'], {
          encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
        })
        running = new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))
      } catch {
        dockerErr = 'Docker not reachable'
      }
      for (const m of MODELS.filter((m) => m.dev)) {
        const ok = running.has(containerOf(m))
        status.models[m.label] = { ok, error: ok ? '' : (dockerErr || 'container not running (cold)') }
      }
    }
  } catch (e: any) {
    // models config unavailable — leave models empty rather than failing the whole check
  }

  return status
})
