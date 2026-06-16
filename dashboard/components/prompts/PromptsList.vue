<template>
  <div>
    <div v-if="groups.length === 0" class="text-muted text-sm text-center py-8">
      No prompts yet. Click "New Prompt" to add one.
    </div>

    <div v-for="g in groups" :key="g.type" class="mb-8">
      <h3 v-if="!only" class="text-sm font-mono text-primary mb-2">{{ g.type }} <span class="text-muted">· {{ g.items.length }}</span></h3>

      <div v-if="g.items.length === 0" class="text-muted text-sm py-8">
        No prompts for "{{ g.type }}" yet. Click "New Prompt" to add one.
      </div>

      <article
        v-for="p in g.items"
        :key="p._id"
        draggable="true"
        @dragstart="onDragStart(g.type, p._id)"
        @dragend="reset"
        @dragover.prevent
        @drop="onDrop(g.type, g.items, p._id)"
        @dragenter="overId = p._id"
        :class="[
          'group relative pl-6 pr-28 py-6 transition',
          dragId === p._id ? 'opacity-40' : '',
          dragType === g.type && overId === p._id && dragId !== p._id ? 'ring-2 ring-amber-500 rounded-lg' : '',
          !p.active ? 'opacity-50' : ''
        ]"
      >
        <!-- drag affordance (whole row is draggable) -->
        <span
          class="absolute left-0 top-6 text-muted opacity-30 group-hover:opacity-100 cursor-move select-none"
          title="Drag to reorder"
        >⠿</span>

        <!-- actions: active toggle, edit, delete -->
        <div class="absolute right-0 top-6 flex items-center gap-3">
          <Toggle :modelValue="p.active" @update:modelValue="$emit('toggleActive', p)" />
          <button @click="$emit('edit', p)" title="Edit" class="text-secondary hover:text-primary transition">
            <PencilSquareIcon class="w-5 h-5" />
          </button>
          <button @click="$emit('delete', p._id)" title="Delete" class="text-secondary hover:text-error transition">
            <TrashIcon class="w-5 h-5" />
          </button>
        </div>

        <!-- full prompt, shown verbatim (whitespace + indentation preserved) -->
        <pre class="prompt-doc text-sm text-secondary whitespace-pre-wrap break-words">{{ display(p.content) }}</pre>
      </article>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { PencilSquareIcon, TrashIcon } from '@heroicons/vue/24/outline'
import Toggle from '~/components/Toggle.vue'
import { lexBetween } from '~/utils/lexBetween'

const props = defineProps({
  prompts: { type: Array, default: () => [] },
  only: { type: String, default: null }, // when set, focus a single type (shows it even if empty)
})
const emit = defineEmits(['edit', 'delete', 'toggleActive', 'reorder'])

const dragId = ref(null)
const dragType = ref(null)
const overId = ref(null)

// Group prompts by the types they map to; within each type, sort ascending by order.
// With `only` set we render just that type — even with zero prompts (empty state).
const groups = computed(() => {
  const byType = {}
  for (const p of props.prompts) {
    for (const type of Object.keys(p.mapping || {})) (byType[type] ||= []).push(p)
  }
  const types = props.only ? [props.only] : Object.keys(byType).sort()
  return types.map((type) => ({
    type,
    // plain code-unit sort (matches lexBetween's 0-9A-Za-z ordering; NOT localeCompare)
    items: (byType[type] || []).slice().sort((a, b) => {
      const x = String(a.mapping[type]), y = String(b.mapping[type])
      return x < y ? -1 : x > y ? 1 : 0
    }),
  }))
})

// Show the prompt exactly as stored — verbatim, no transforms/trim/unescape.
const display = (c) => (c && c.length ? c : '(empty)')

const onDragStart = (type, id) => { dragId.value = id; dragType.value = type }
const reset = () => { dragId.value = null; dragType.value = null; overId.value = null }

const onDrop = (type, items, dropId) => {
  const id = dragId.value
  if (dragType.value !== type || !id || id === dropId) return reset() // only reorder within the same type
  const arr = [...items]
  const from = arr.findIndex((p) => p._id === id)
  const to = arr.findIndex((p) => p._id === dropId)
  if (from < 0 || to < 0) return reset()
  const [moved] = arr.splice(from, 1)
  arr.splice(to, 0, moved)
  const idx = arr.findIndex((p) => p._id === id)
  const prev = idx > 0 ? String(arr[idx - 1].mapping[type]) : null
  const next = idx < arr.length - 1 ? String(arr[idx + 1].mapping[type]) : null
  emit('reorder', { id, type, order: lexBetween(prev, next) })
  reset()
}
</script>

<style scoped>
.prompt-doc {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  line-height: 1.5;
  margin: 0;
}
</style>
