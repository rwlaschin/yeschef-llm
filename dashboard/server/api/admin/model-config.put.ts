import { getCollection } from '../../utils/db'
import { samplerKeys } from '#models'

// Upsert one model_config doc by ?id= ("_default" or a model string e.g. "llama3.1:8b").
// Body: { params: { <samplerKey>: <number>, … } }. Only known sampler keys with a real
// numeric value are stored; blanks/unknowns are dropped so an omitted field cleanly falls
// through to the next level (per-model → _default → code default) at the worker.
export default defineEventHandler(async (event) => {
  try {
    const id = getQuery(event).id as string
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id parameter' })

    const body = await readBody(event)
    const allowed = new Set(samplerKeys())
    const params: Record<string, number> = {}
    for (const [k, v] of Object.entries(body?.params || {})) {
      if (!allowed.has(k)) continue
      if (v === '' || v === null || v === undefined) continue        // blank → inherit
      const n = Number(v)
      if (!Number.isNaN(n)) params[k] = n
    }

    const collection = await getCollection('model_config')
    await collection.updateOne(
      { _id: id as any },
      { $set: { params, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    )
    return await collection.findOne({ _id: id as any })
  } catch (error: any) {
    throw createError({
      statusCode: error.statusCode || 500,
      statusMessage: error.statusMessage || error.message || 'Failed to save model config',
    })
  }
})
