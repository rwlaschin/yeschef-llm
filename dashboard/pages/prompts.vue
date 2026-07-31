<template>
  <div class="glass p-6" :class="editing ? 'h-full flex flex-col min-h-0' : ''">
    <div v-if="!editing" class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-serif text-primary">Prompt Library</h1>
      <button
        @click="startCreate"
        class="flex items-center gap-2 px-4 py-2 bg-amber-500 text-gray-900 rounded-lg font-medium hover:bg-amber-600 transition"
      >
        <PlusIcon class="w-4 h-4" />
        New Prompt
      </button>
    </div>

    <template v-if="editing">
      <PromptForm
        :prompt="editing"
        :available-types="types"
        :available-models="models"
        :default-types="editing._id || isPseudo(selectedType) ? [] : [selectedType]"
        @save="savePrompt"
        @cancel="editing = null"
      />
    </template>
    <template v-else>
      <!-- Filter row: searchable type select (scales to many types) + hide-inactive. -->
      <div class="flex items-center justify-between gap-4 mb-5">
        <div class="relative w-72">
          <button
            type="button"
            @click="typeOpen = !typeOpen"
            class="w-full form-input text-left text-sm flex items-center justify-between"
          >
            <span class="font-mono">{{ selectedType }} <span class="text-muted">· {{ countFor(selectedType) }}</span></span>
            <span class="text-xs opacity-60 ml-2">▼</span>
          </button>
          <template v-if="typeOpen">
            <div class="fixed inset-0 z-40" @click="typeOpen = false"></div>
            <div class="absolute z-50 w-full mt-1 rounded-lg bg-white border border-gray-200 dark:bg-gray-950 dark:border-gray-700/60 shadow-xl overflow-hidden">
              <div class="p-2 border-b border-gray-200 dark:border-gray-700/40">
                <input v-model="typeSearch" placeholder="Search types…" class="w-full form-input text-sm" />
              </div>
              <div class="max-h-40 overflow-auto p-1">
                <button
                  v-for="t in filteredTypes"
                  :key="t"
                  type="button"
                  @click="selectedType = t; typeOpen = false; typeSearch = ''"
                  :class="[
                    'w-full px-3 py-2 rounded text-sm flex items-center justify-between font-mono',
                    selectedType === t ? 'bg-amber-500/15 text-primary' : 'text-secondary hover:bg-amber-500/10'
                  ]"
                >
                  <span>{{ t }}</span>
                  <span class="text-muted">· {{ countFor(t) }}</span>
                </button>
                <div v-if="filteredTypes.length === 0" class="px-3 py-2 text-xs text-muted">No matches</div>
              </div>
            </div>
          </template>
        </div>

        <input
          v-model="contentSearch"
          placeholder="Filter by content… (searches all types)"
          class="form-input text-sm flex-1 max-w-md"
        />

        <label class="flex items-center gap-2 text-sm text-secondary cursor-pointer select-none">
          <input type="checkbox" v-model="hideInactive" class="accent-amber-500 w-4 h-4" />
          Hide inactive
        </label>
      </div>

      <PromptsList
        :prompts="visiblePrompts"
        :only="selectedType"
        :flat="!!contentSearch.trim() || selectedType === 'all'"
        @edit="editPrompt"
        @delete="deletePrompt"
        @reorder="onReorder"
        @toggleActive="onToggleActive"
      />
    </template>

    <ConfirmDialog ref="confirmDialog" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { PlusIcon } from '@heroicons/vue/24/outline'
import PromptsList from '~/components/prompts/PromptsList.vue'
import PromptForm from '~/components/prompts/PromptForm.vue'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import { lexBetween } from '~/utils/lexBetween'

const prompts = ref([])
const types = ref([])
const models = ref([])   // [{value,label}] for the prompt's model override
const selectedType = ref('query') // which type's prompts the list is focused on
const typeOpen = ref(false)
const typeSearch = ref('')
const hideInactive = ref(false)
const contentSearch = ref('') // free-text content filter — active query searches ALL types
const editing = ref(null)
const confirmDialog = ref(null)
const toast = useToast()
const { env: currentEnv } = useEnvironment()

// Pseudo-types on top of the real subtype list: "all" shows every group,
// "unassigned" shows prompts mapped to no type (otherwise invisible in every view).
const PSEUDO_TYPES = ['all', 'unassigned']
const isPseudo = (t) => PSEUDO_TYPES.includes(t)

// How many prompts map to a given type (shown next to each type).
const countFor = (t) =>
  t === 'all' ? prompts.value.length
  : t === 'unassigned' ? prompts.value.filter((p) => !Object.keys(p.mapping || {}).length).length
  : prompts.value.filter((p) => p.mapping && p.mapping[t] != null).length

const filteredTypes = computed(() => {
  const all = [...PSEUDO_TYPES, ...types.value]
  const q = typeSearch.value.trim().toLowerCase()
  return q ? all.filter((t) => t.toLowerCase().includes(q)) : all
})

// Prompts shown in the list — optionally hide inactive ones, then apply the content filter.
const visiblePrompts = computed(() => {
  let list = hideInactive.value ? prompts.value.filter((p) => p.active) : prompts.value
  const q = contentSearch.value.trim().toLowerCase()
  if (q) list = list.filter((p) => (p.content || '').toLowerCase().includes(q))
  return list
})

const fetchPrompts = async () => {
  try { prompts.value = await $fetch('/api/admin/prompts') }
  catch (e) { console.error('Failed to fetch prompts:', e) }
}
const fetchTypes = async () => {
  try {
    types.value = await $fetch('/api/llm/types')
    // Default the focus to the first type if the current one isn't available (pseudo-types stay).
    if (types.value.length && !isPseudo(selectedType.value) && !types.value.includes(selectedType.value)) selectedType.value = types.value[0]
  } catch (e) { console.error('Failed to fetch types:', e) }
}
const fetchModels = async () => {
  // Override picker follows the env toggle: dev shows only dev-capable tiers (their
  // topics are the only ones provisioned), so prod-only models (e.g. 70B) don't appear in dev.
  try { models.value = await $fetch('/api/llm/models', { query: { env: currentEnv.value } }) }
  catch (e) { console.error('Failed to fetch models:', e) }
}
// Re-fetch when the environment toggle changes.
watch(currentEnv, fetchModels)

const startCreate = () => { editing.value = { active: false, content: '', mapping: {}, modelOverride: null } }
const editPrompt = (p) => { editing.value = JSON.parse(JSON.stringify(p)) }

// Order key placing a prompt at the END of `type`'s stack.
const endOrderForType = (type) => {
  const orders = prompts.value
    .filter((p) => p.mapping && p.mapping[type] != null && p._id !== editing.value?._id)
    .map((p) => String(p.mapping[type]))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) // plain code-unit order (matches lexBetween)
  return lexBetween(orders.length ? orders[orders.length - 1] : null, null)
}

const savePrompt = async (data) => {
  try {
    const existing = (editing.value && editing.value.mapping) || {}
    const mapping = {}
    for (const type of data.types) {
      // keep current order for types the prompt already had; append new ones
      mapping[type] = existing[type] != null ? String(existing[type]) : endOrderForType(type)
    }
    const body = { active: data.active, content: data.content, mapping, modelOverride: data.modelOverride ?? null }
    const isEdit = !!data._id
    await $fetch(isEdit ? `/api/admin/prompt?id=${data._id}` : '/api/admin/prompt', {
      method: isEdit ? 'PUT' : 'POST',
      body,
    })
    await fetchPrompts()
    editing.value = null
    toast.success(isEdit ? 'Prompt updated' : 'Prompt created')
  } catch (e) {
    // Surface the failure instead of silently leaving the form open.
    console.error('Failed to save prompt:', e)
    toast.error('Failed to save prompt', e?.data?.statusMessage || e?.message || 'Unknown error')
  }
}

const persist = (p) =>
  $fetch(`/api/admin/prompt?id=${p._id}`, { method: 'PUT', body: { active: p.active, content: p.content, mapping: p.mapping, modelOverride: p.modelOverride ?? null } })

const onReorder = async ({ id, type, order }) => {
  const p = prompts.value.find((x) => x._id === id)
  if (!p) return
  p.mapping = { ...(p.mapping || {}), [type]: order } // optimistic
  try { await persist(p) } catch (e) { console.error('reorder failed:', e); await fetchPrompts() }
}

const onToggleActive = async (p) => {
  p.active = !p.active // optimistic
  try { await persist(p) } catch (e) { console.error('toggle failed:', e); await fetchPrompts() }
}

const deletePrompt = async (id) => {
  const ok = await confirmDialog.value.open({
    title: 'Delete Prompt',
    message: 'Delete this prompt? This cannot be undone.',
    confirmText: 'Delete',
    isDangerous: true,
  })
  if (!ok) return
  try { await $fetch(`/api/admin/prompt?id=${id}`, { method: 'DELETE' }); await fetchPrompts() }
  catch (e) { console.error('Failed to delete prompt:', e) }
}

onMounted(() => { fetchPrompts(); fetchTypes(); fetchModels() })
</script>
