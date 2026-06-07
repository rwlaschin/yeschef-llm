<template>
  <div>
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
          <div class="absolute z-50 w-full mt-1 rounded-lg bg-gray-950 border border-gray-700/60 shadow-xl overflow-hidden">
            <div class="p-2 border-b border-gray-700/40">
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

    <!-- WYSIWYG editor (client-only, isolated; content stored as markdown) -->
    <label class="block text-sm text-secondary mb-1">Content</label>
    <MarkdownEditor v-model="form.content" />

    <div class="flex gap-2 mt-4">
      <button
        type="button"
        @click="onSave"
        :disabled="!canSave"
        class="px-4 py-2 bg-amber-500 text-gray-900 rounded-lg font-medium hover:bg-amber-600 transition disabled:opacity-50"
      >Save</button>
      <button
        type="button"
        @click="$emit('cancel')"
        class="px-4 py-2 bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition"
      >Cancel</button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import Toggle from '~/components/Toggle.vue'

const props = defineProps({
  prompt: { type: Object, required: true },
  availableTypes: { type: Array, default: () => [] }, // predetermined message types
  defaultTypes: { type: Array, default: () => [] },   // preselect these on a new prompt
})
const emit = defineEmits(['save', 'cancel'])

const form = ref({ active: false, content: '', ...JSON.parse(JSON.stringify(props.prompt)) })
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
    types: selected.value, // page builds mapping from these; deselected types are dropped (order cleared)
  })
}
</script>
