<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- scrollable body -->
    <div class="flex-1 overflow-y-auto min-h-0 pr-1">
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-xl font-serif text-primary">{{ form._id ? 'Edit Prompt' : 'New Prompt' }}</h2>
      <div class="flex items-center gap-2">
        <span class="text-sm text-secondary">Active</span>
        <Toggle v-model="form.active" />
      </div>
    </div>

    <!-- which request types this prompt applies to (order is set by drag-drop in the list) -->
    <div class="mb-5">
      <div v-if="availableTypes.length === 0" class="text-xs text-muted">No request types defined.</div>
      <div v-else class="relative max-w-md">
        <button
          type="button"
          @click="open = !open"
          class="w-full form-input text-left text-sm flex items-center justify-between"
        >
          <span class="truncate" :class="{ 'text-muted': !selected.length }">{{ selected.length ? selected.join(', ') : 'Use this prompt for these request types' }}</span>
          <span class="text-xs opacity-60 ml-2">▼</span>
        </button>
        <template v-if="open">
          <div class="fixed inset-0 z-40" @click="open = false"></div>
          <div class="absolute z-50 w-full mt-1 rounded-lg bg-white border border-gray-200 dark:bg-gray-950 dark:border-gray-700/60 shadow-xl overflow-hidden">
            <div class="p-2 border-b border-gray-200 dark:border-gray-700/40">
              <input v-model="typeSearch" placeholder="Search types…" class="w-full form-input text-sm" />
            </div>
            <div class="max-h-40 overflow-auto p-1">
              <button
                v-for="t in filteredTypes"
                :key="t"
                type="button"
                @click="toggle(t)"
                class="w-full px-3 py-2 rounded text-sm flex items-center justify-between hover:bg-amber-500/15"
              >
                <span>{{ t }}</span>
                <span v-if="selected.includes(t)" class="text-amber-500">✓</span>
              </button>
              <div v-if="filteredTypes.length === 0" class="px-3 py-2 text-xs text-muted">No matches</div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- name: optional, purely so a fragment can be referred to by something other than its _id -->
    <div class="mb-5 max-w-md">
      <label class="block text-sm text-secondary mb-1">Name <span class="text-muted">· optional</span></label>
      <input v-model="form.name" placeholder="e.g. Status contract" class="w-full form-input text-sm" />
    </div>

    <!-- placement: which part of the step this fragment sits beside. `system` is a DIFFERENT
         message, the other five are positions inside the user message. -->
    <div class="mb-5 max-w-md">
      <label class="block text-sm text-secondary mb-1">Placement</label>
      <select v-model="form.relatesTo" class="w-full form-input text-sm">
        <option v-for="s in RELATES_TO" :key="s" :value="s">{{ s }} — {{ SECTION_DESCRIPTION[s] }}</option>
      </select>
    </div>

    <!-- model override: pin a model for this prompt; otherwise the request's model is used -->
    <div class="mb-5 max-w-md">
      <label class="block text-sm text-secondary mb-1">Model override</label>
      <select v-model="form.modelOverride" class="w-full form-input text-sm">
        <option :value="null">Not set — use the request's model</option>
        <option v-for="m in availableModels" :key="m.value" :value="m.value">{{ m.label }}</option>
      </select>
    </div>

    <!-- WYSIWYG editor (client-only, isolated; content stored as markdown) -->
    <label class="block text-sm text-secondary mb-1">Content</label>
    <MarkdownEditor v-model="form.content" />
    </div>

    <!-- fixed footer — Save stays reachable without scrolling a long prompt -->
    <div class="shrink-0 flex gap-2 pt-2">
      <button
        type="button"
        @click="onSave"
        :disabled="!canSave"
        class="px-4 py-2 bg-amber-500 text-gray-900 rounded-lg font-medium hover:bg-amber-600 transition disabled:opacity-50"
      >Save</button>
      <button
        type="button"
        @click="$emit('cancel')"
        class="px-4 py-2 btn-muted rounded-lg transition"
      >Cancel</button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import Toggle from '~/components/Toggle.vue'
import { RELATES_TO, SYSTEM, SECTION_DESCRIPTION } from '~/utils/assemblePrompt'

const props = defineProps({
  prompt: { type: Object, required: true },
  availableTypes: { type: Array, default: () => [] },  // predetermined message types
  availableModels: { type: Array, default: () => [] }, // [{value,label}] for the model override
  defaultTypes: { type: Array, default: () => [] },    // preselect these on a new prompt
})
const emit = defineEmits(['save', 'cancel'])

// `relatesTo` defaults to SYSTEM so an existing record with the field unset shows the section it is
// actually assembled into, rather than an empty select the author has to guess at.
const form = ref({ active: false, content: '', modelOverride: null, name: '', relatesTo: SYSTEM, ...JSON.parse(JSON.stringify(props.prompt)) })
if (!RELATES_TO.includes(form.value.relatesTo)) form.value.relatesTo = SYSTEM
// Existing prompt → its mapped types; new prompt → the type currently in focus.
const initialTypes = Object.keys(props.prompt.mapping || {})
const selected = ref(initialTypes.length ? initialTypes : [...props.defaultTypes])
const open = ref(false)
const typeSearch = ref('')

const filteredTypes = computed(() => {
  const q = typeSearch.value.trim().toLowerCase()
  return q ? props.availableTypes.filter((t) => t.toLowerCase().includes(q)) : props.availableTypes
})

const toggle = (t) => {
  const i = selected.value.indexOf(t)
  if (i >= 0) selected.value.splice(i, 1)
  else selected.value.push(t)
}

const canSave = computed(() => (form.value.content || '').trim().length > 0 && selected.value.length > 0)

const onSave = () => {
  emit('save', {
    _id: form.value._id,
    active: !!form.value.active,
    content: form.value.content || '',
    modelOverride: form.value.modelOverride || null,
    // name + relatesTo MUST be here. The page reads `data.relatesTo ?? 'system'`, so omitting them
    // does not fail — it silently saves the default, discarding whatever the author chose.
    name: form.value.name || '',
    relatesTo: form.value.relatesTo || SYSTEM,
    types: selected.value, // page builds mapping from these; deselected types are dropped (order cleared)
  })
}
</script>
