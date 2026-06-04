// Exposes the shared model registry to the UI so the dropdown stays in sync
// with the worker infra (single source of truth: yeschef-llm/config/models.js).
import { MODELS } from '#models'

export default defineEventHandler(() => {
  // value = topic (what /api/llm/request expects as `model`)
  return MODELS.map((m: any) => ({ value: m.topic, label: m.label }))
})
