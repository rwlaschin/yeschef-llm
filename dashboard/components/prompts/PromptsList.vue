<template>
  <div>
    <div v-if="groups.length === 0" class="text-muted text-sm text-center py-8">
      No prompts yet. Click "New Prompt" to add one.
    </div>

    <div v-for="g in groups" :key="g.type" class="mb-8">
      <h3 v-if="!flat && !only" class="text-sm font-mono text-primary mb-2">{{ g.type }} <span class="text-muted">· {{ g.items.length }}</span></h3>

      <div v-if="g.items.length === 0 && !g.sections" class="text-muted text-sm py-8">
        {{ flat ? 'No prompts match.' : `No prompts for "${g.type}" yet. Click "New Prompt" to add one.` }}
      </div>

      <!-- Sectioned: fragments grouped by WHERE they are assembled, in send order. An empty section
           still renders, so there is somewhere to drop a fragment you want to move into it. -->
      <template v-if="g.sections">
        <div
          v-for="s in g.sections"
          :key="s.section"
          class="mb-4"
          @dragover.prevent
          @drop="onDrop(g.type, s.items, null, s.section)"
        >
          <div class="flex items-baseline gap-2 border-b border-gray-200 dark:border-gray-700/40 pb-1 mb-1">
            <span class="text-xs font-mono uppercase tracking-wide text-secondary">{{ s.section }}</span>
            <!-- what the placement DOES, never the raw {marker} — that token is an engine detail
                 the author cannot act on. Copy lives beside the vocabulary in config/. -->
            <span class="text-xs text-muted">{{ SECTION_DESCRIPTION[s.section] }}</span>
            <span class="text-xs text-muted ml-auto">{{ s.items.length }}</span>
          </div>

          <div v-if="s.items.length === 0" class="text-xs text-muted italic py-2 pl-6">nothing here — drop a prompt to place it</div>

          <PromptRow
            v-for="p in s.items"
            :key="p._id"
            :p="p" :type="g.type" :section="s.section" :items="s.items"
            :flat="flat" :dragId="dragId" :dragType="dragType" :overId="overId"
            @dragstart="onDragStart" @dragend="reset" @over="overId = $event" @drop="onDrop"
            @edit="$emit('edit', $event)" @delete="$emit('delete', $event)" @toggleActive="$emit('toggleActive', $event)"
          />
        </div>
      </template>

      <!-- Flat / unassigned: no ordering, no sections. -->
      <PromptRow
        v-else
        v-for="p in g.items"
        :key="p._id"
        :p="p" :type="g.type" :section="null" :items="g.items"
        :flat="flat" :dragId="dragId" :dragType="dragType" :overId="overId"
        @dragstart="onDragStart" @dragend="reset" @over="overId = $event" @drop="onDrop"
        @edit="$emit('edit', $event)" @delete="$emit('delete', $event)" @toggleActive="$emit('toggleActive', $event)"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import PromptRow from '~/components/prompts/PromptRow.vue'
import { lexBetween } from '~/utils/lexBetween'
import { RELATES_TO, SYSTEM, SECTION_DESCRIPTION } from '~/utils/assemblePrompt'

const props = defineProps({
  prompts: { type: Array, default: () => [] },
  only: { type: String, default: null }, // when set, focus a single type (shows it even if empty)
  flat: { type: Boolean, default: false }, // search results: each prompt ONCE, types labeled per row
})
const emit = defineEmits(['edit', 'delete', 'toggleActive', 'reorder'])

const dragId = ref(null)
const dragType = ref(null)
const dragSection = ref(null)
const overId = ref(null)

// Group prompts by the types they map to; within each type, sort ascending by order.
// A prompt mapped to NO type lands in the "unassigned" group so it can never be invisible.
// With `only` set we render just that type — even with zero prompts (empty state).
const groups = computed(() => {
  // Flat mode ("all" view or content search): no grouping — a prompt mapped to N types
  // must not appear N times. One row per prompt; its types render as a label on the row.
  if (props.flat) return [{ type: 'results', items: props.prompts }]
  const byType = {}
  for (const p of props.prompts) {
    const keys = Object.keys(p.mapping || {})
    if (!keys.length) (byType.unassigned ||= []).push(p)
    for (const type of keys) (byType[type] ||= []).push(p)
  }
  const types = props.only ? [props.only] : Object.keys(byType).sort()
  return types.map((type) => {
    // plain code-unit sort (matches lexBetween's 0-9A-Za-z ordering; NOT localeCompare)
    const items = (byType[type] || []).slice().sort((a, b) => {
      const x = String(a.mapping?.[type] ?? ''), y = String(b.mapping?.[type] ?? '')
      return x < y ? -1 : x > y ? 1 : 0
    })
    return {
      type,
      items,
      // Second level: where in the step each fragment is assembled. Rendered in SEND order, and an
      // empty section still renders its header — otherwise there is nowhere to drop a fragment you
      // want to move INTO it. "unassigned" has no order key, so it stays a single flat list.
      sections: type === 'unassigned' ? null : RELATES_TO.map((section) => ({
        section,
        items: items.filter((p) => sectionOf(p) === section),
      })),
    }
  })
})

// Mirrors assembly: an unset or unrecognised relatesTo is the system message.
const sectionOf = (p) => (RELATES_TO.includes(p?.relatesTo) ? p.relatesTo : SYSTEM)

// Show the prompt exactly as stored — verbatim, no transforms/trim/unescape.
const display = (c) => (c && c.length ? c : '(empty)')

const onDragStart = (type, id, section = null) => { dragId.value = id; dragType.value = type; dragSection.value = section }
const reset = () => { dragId.value = null; dragType.value = null; dragSection.value = null; overId.value = null }

// `section` is the section DROPPED INTO. Dropping into a different one moves the fragment there —
// which writes TWO fields, relatesTo and a fresh order key against its new neighbours. `dropId` is
// null when the drop lands on an empty section header, which is the only way to reach a section
// that has nothing in it yet.
const onDrop = (type, items, dropId, section = null) => {
  const id = dragId.value
  // only reorder within the same real type — "unassigned" has no order key to write
  if (type === 'unassigned' || dragType.value !== type || !id || (id === dropId && section === dragSection.value)) return reset()
  const arr = [...items].filter((p) => p._id !== id)
  const to = dropId ? arr.findIndex((p) => p._id === dropId) : arr.length
  const moved = items.find((p) => p._id === id) || (props.prompts || []).find((p) => p._id === id)
  if (!moved) return reset()
  arr.splice(to < 0 ? arr.length : to, 0, moved)
  const idx = arr.findIndex((p) => p._id === id)
  const prev = idx > 0 ? String(arr[idx - 1].mapping[type]) : null
  const next = idx < arr.length - 1 ? String(arr[idx + 1].mapping[type]) : null
  const payload = { id, type, order: lexBetween(prev, next) }
  if (section && section !== dragSection.value) payload.relatesTo = section
  emit('reorder', payload)
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
