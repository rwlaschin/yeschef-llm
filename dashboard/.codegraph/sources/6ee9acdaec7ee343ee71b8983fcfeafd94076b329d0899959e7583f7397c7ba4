import { getCollection } from '../../utils/db'
import { MODELS, devModels, defaultSampler, SAMPLER_PARAMS } from '#models'

// Everything the /model-config page needs in one call:
//   params   — the sampler schema (one entry per editable field; drives the form)
//   defaults — the code-level fallback values (shown as the baseline placeholder)
//   targets  — the models that can have per-model overrides. Several topics can share one
//              backing model (e.g. raw + OpenClaw both run gemma4:12b-it-qat); sampling is a
//              property of the MODEL, so we dedupe by `model`.
//   saved    — the model_config docs already in Mongo: [{ _id, params, updatedAt }, …],
//              where _id is "_default" or a model string.
export default defineEventHandler(async (event) => {
  // Follow the UI env toggle: dev shows only dev-capable tiers (matches /api/llm/models).
  const { env } = getQuery(event)
  const list = env === 'production' ? MODELS : devModels()

  const seen = new Set<string>()
  const targets: { model: string; label: string }[] = []
  for (const m of list as any[]) {
    if (!seen.has(m.model)) { seen.add(m.model); targets.push({ model: m.model, label: m.label }) }
  }

  try {
    const collection = await getCollection('model_config')
    const saved = await collection.find({}).toArray()
    return { params: SAMPLER_PARAMS, defaults: defaultSampler(), targets, saved }
  } catch (error: any) {
    throw createError({ statusCode: 500, statusMessage: error.message || 'Failed to fetch model config' })
  }
})
