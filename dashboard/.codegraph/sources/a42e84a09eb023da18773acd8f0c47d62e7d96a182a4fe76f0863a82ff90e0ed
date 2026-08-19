// Exposes the shared model registry to the UI so the dropdown stays in sync
// with the worker infra (single source of truth: yeschef-llm/config/models.js).
import { MODELS, devModels, FAKE_MODEL_OPTION } from '#models'

export default defineEventHandler((event) => {
  // Match the UI env toggle: in local/dev only dev-capable models exist (their
  // topics are the only ones provisioned), so don't offer prod-only tiers there.
  const { env } = getQuery(event)
  const list = env === 'production' ? MODELS : devModels()
  // value = topic (what /api/llm/request expects as `model`)
  // ctx = the model's max context window in tokens (capability ceiling; see config/models.js)
  return [
    ...list.map((m: any) => ({ value: m.topic, label: m.label, ctx: m.ctx })),
    FAKE_MODEL_OPTION,
  ]
})
