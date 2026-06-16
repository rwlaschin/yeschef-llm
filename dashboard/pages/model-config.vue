<template>
  <div class="glass p-6">
    <div class="flex items-start justify-between mb-6">
      <div>
        <h1 class="text-2xl font-serif text-primary">Model Sampling</h1>
        <p class="text-sm text-muted mt-1">
          Ollama generation params. <span class="text-secondary">Defaults</span> apply to every model;
          a per-model card overrides them. Leave a field blank to inherit — the hint shows what it falls back to.
        </p>
      </div>
    </div>

    <!-- One card per target. The first is the global "_default" baseline; the rest are per-model overrides. -->
    <div class="space-y-5">
      <div
        v-for="card in cards"
        :key="card.id"
        class="rounded-xl border p-5"
        :class="card.id === '_default'
          ? 'border-amber-500/40 bg-amber-500/5'
          : 'border-divider bg-black/5 dark:bg-white/5'"
      >
        <div class="flex items-center justify-between mb-4">
          <div class="min-w-0">
            <h2 class="text-sm font-medium text-primary truncate">{{ card.label }}</h2>
            <p class="text-xs text-muted font-mono truncate">{{ card.sub }}</p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button
              type="button"
              @click="clearCard(card.id)"
              :disabled="isEmpty(card.id)"
              class="px-2.5 py-1.5 text-xs btn-muted rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
              title="Blank every field (inherit everything). Save to persist."
            >
              Clear
            </button>
            <button
              type="button"
              @click="save(card.id)"
              :disabled="!!saving[card.id] || !isDirty(card.id)"
              class="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-amber-500 text-gray-900 rounded-lg font-medium hover:bg-amber-600 transition disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-amber-500"
            >
              <CheckIcon class="w-3.5 h-3.5" />
              {{ saving[card.id] ? 'Saving…' : 'Save' }}
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-4">
          <div v-for="p in params" :key="p.key">
            <label class="flex items-center justify-between text-xs text-secondary mb-1">
              <span class="font-medium" :title="p.help">{{ p.label }}</span>
              <span class="font-mono text-[10px] text-muted">{{ p.key }}</span>
            </label>
            <input
              v-model="drafts[card.id][p.key]"
              type="number"
              :min="p.min"
              :max="p.max"
              :step="p.step"
              :placeholder="placeholderFor(card.id, p.key)"
              class="w-full form-input text-sm font-mono"
            />
            <p class="text-[10px] text-muted mt-1">
              {{ card.id === '_default' ? `Ollama default ${p.default}` : `inherits ${placeholderFor(card.id, p.key)}` }}
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { CheckIcon } from '@heroicons/vue/24/outline'

const params = ref([])        // sampler schema from the server (drives the form)
const defaults = ref({})      // code-level fallback values, keyed by param
const targets = ref([])       // [{ model, label }] — models that can have an override
const drafts = reactive({})   // { [id]: { [key]: string } } — raw input strings ('' = inherit)
const baselines = reactive({}) // last-saved snapshot per id — drives the Save dirty-check
const saving = reactive({})
const toast = useToast()
const { env: currentEnv } = useEnvironment()

// Defaults card first, then one per model. Same env-follows-toggle behavior as the prompts page.
const cards = computed(() => [
  { id: '_default', label: 'Defaults — all models', sub: 'baseline sent to every model' },
  ...targets.value.map((t) => ({ id: t.model, label: t.label, sub: t.model })),
])

// Save enables only when the card differs from its last-saved snapshot; Clear only when it has values.
const isDirty = (id) => !!baselines[id] && (params.value || []).some((p) => drafts[id]?.[p.key] !== baselines[id]?.[p.key])
const isEmpty = (id) => (params.value || []).every((p) => (drafts[id]?.[p.key] ?? '') === '')

// What a blank field falls back to: model cards inherit the (edited) _default value, then code default.
const placeholderFor = (id, key) => {
  if (id === '_default') return String(defaults.value[key] ?? '')
  const d = drafts['_default']?.[key]
  if (d !== '' && d != null) return String(d)
  return String(defaults.value[key] ?? '')
}

const load = async () => {
  try {
    const data = await $fetch('/api/admin/model-configs', { query: { env: currentEnv.value } })
    params.value = data.params
    defaults.value = data.defaults
    targets.value = data.targets
    const savedById = Object.fromEntries((data.saved || []).map((d) => [d._id, d.params || {}]))
    for (const id of ['_default', ...data.targets.map((t) => t.model)]) {
      drafts[id] = {}
      for (const p of data.params) {
        const v = savedById[id]?.[p.key]
        drafts[id][p.key] = v === undefined || v === null ? '' : String(v)
      }
      baselines[id] = { ...drafts[id] }   // pristine snapshot → Save starts disabled
    }
  } catch (e) {
    console.error('Failed to load model config:', e)
    toast.error('Failed to load model config', e?.data?.statusMessage || e?.message || 'Unknown error')
  }
}
watch(currentEnv, load)

const clearCard = (id) => {
  for (const p of params.value) drafts[id][p.key] = ''
}

const save = async (id) => {
  saving[id] = true
  try {
    const payload = {}
    for (const p of params.value) {
      const v = drafts[id][p.key]
      if (v !== '' && v !== null && v !== undefined) payload[p.key] = v
    }
    await $fetch(`/api/admin/model-config?id=${encodeURIComponent(id)}`, { method: 'PUT', body: { params: payload } })
    baselines[id] = { ...drafts[id] }   // re-snapshot → Save goes inert until the next edit
    toast.success(id === '_default' ? 'Defaults saved' : `Override saved · ${id}`)
  } catch (e) {
    console.error('Failed to save model config:', e)
    toast.error('Failed to save', e?.data?.statusMessage || e?.message || 'Unknown error')
  } finally {
    saving[id] = false
  }
}

onMounted(load)
</script>
