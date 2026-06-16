import { PubSub } from '@google-cloud/pubsub'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { randomUUID } from 'crypto'
// Single source of truth shared with the worker infra (yeschef-llm/config/models.js)
import { byTopic } from '#models'

const pubsubClients: { [env: string]: PubSub } = {}
let firestoreDb: any = null

// One client per target env. PUBSUB_EMULATOR_HOST is set/cleared by the handler
// before the first construction for each env, so the channel mode sticks.
function getPubSubClient(targetEnv: string) {
  if (!pubsubClients[targetEnv]) {
    const projectId = process.env.GCP_PROJECT_ID
    pubsubClients[targetEnv] = new PubSub({ projectId })
  }
  return pubsubClients[targetEnv]
}

function getFirestoreDb() {
  if (!firestoreDb) {
    const projectId = process.env.GCP_PROJECT_ID
    if (!getApps().length) {
      initializeApp({ projectId })
    }
    firestoreDb = getFirestore()
  }
  return firestoreDb
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const body = await readBody(event)
  const { userId, companyId, type, userPrompt, model, env, metadata } = body

  // The UI toggle (ConfigPanel) decides the target:
  //   local      → Pub/Sub EMULATOR
  //   production → real GCP Pub/Sub
  // Firestore stays the real project either way (worker writes there too).
  const targetEnv = env === 'production' ? 'production' : 'local'
  if (targetEnv === 'local') {
    process.env.PUBSUB_EMULATOR_HOST =
      process.env.PUBSUB_EMULATOR_HOST || (config.public.firebaseEmulatorHost as string) || 'localhost:8185'
  } else {
    delete process.env.PUBSUB_EMULATOR_HOST
  }

  // Validate required fields
  if (!userId || !companyId || !type || !userPrompt || !model) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing required fields: userId, companyId, type, userPrompt, model',
    })
  }

  // `model` from the UI is the topic name (e.g. llama3_1_8b_v1). Validate against
  // the shared registry; the topic is the model's topic.
  const known = byTopic(model)
  if (!known) {
    throw createError({
      statusCode: 400,
      statusMessage: `Unknown model: ${model}`,
    })
  }

  const jobId = randomUUID()
  const topic = known.topic

  try {
    // 1. Create Firestore doc
    const collectionName = process.env.NUXT_PUBLIC_FIRESTORE_COLLECTION_RESULTS || 'llmResults'
    const db = getFirestoreDb()

    await db.collection(collectionName).doc(jobId).set({
      jobId,
      userId,
      companyId,
      type,
      userPrompt,
      model,
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
    })

    // 2. Publish to Pub/Sub (emulator or real GCP, per the UI toggle)
    const pubsub = getPubSubClient(targetEnv)
    const topicRef = pubsub.topic(topic)

    const message = {
      jobId,
      userId,
      companyId,
      type,
      query: userPrompt,
      metadata: metadata || {},
    }

    await topicRef.publish(Buffer.from(JSON.stringify(message)))

    // 3. Return jobId
    return {
      jobId,
      createdAt: new Date().toISOString(),
      type,
      model,
    }
  } catch (err) {
    console.error('LLM request failed:', err)
    throw createError({
      statusCode: 500,
      statusMessage: `Failed to submit request: ${err.message}`,
    })
  }
})
