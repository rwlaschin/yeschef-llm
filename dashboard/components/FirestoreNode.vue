<template>
  <!-- One document. Expanding it shows its data, then (if enabled) its subcollections,
       whose docs are FirestoreNodes too — recursive drill-down. No indent: nesting is
       shown by the per-level background tint + the subcollection-name label. -->
  <div :class="['fsnode border-l-4 border-l-transparent [&:hover:not(:has(.fsnode:hover))]:!border-l-amber-500 border-b border-b-gray-200 dark:border-b-white/5 transition duration-500', levelBg]">
    <div class="px-3 py-2 cursor-pointer flex items-center gap-2 text-xs font-mono text-amber-400" @click="toggle">
      <span>{{ open ? '▼' : '▶' }}</span>
      <span class="truncate">{{ doc.id }}</span>
    </div>

    <div v-if="open">
      <pre v-if="!isEmpty" class="px-3 pb-2 text-xs text-secondary font-mono whitespace-pre-wrap break-words overflow-x-auto">{{ JSON.stringify(doc.data, null, 2) }}</pre>

      <template v-if="showSubcollections">
        <div v-if="loading" class="px-3 pb-2 text-xs text-muted">Loading subcollections…</div>
        <div v-for="sub in subcollections" :key="sub.name">
          <div class="px-3 py-1 text-[10px] uppercase tracking-wide text-amber-400/70 font-semibold">{{ sub.name }} ({{ sub.docs.length }})</div>
          <FirestoreNode
            v-for="child in sub.docs"
            :key="child.path"
            :doc="child"
            :level="level + 1"
            :show-subcollections="showSubcollections"
          />
        </div>
        <div v-if="loaded && subcollections.length === 0" class="px-3 pb-2 text-[10px] text-muted opacity-60">no subcollections</div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

const props = defineProps({
  doc: { type: Object, required: true },          // { id, path, data }
  level: { type: Number, default: 0 },
  showSubcollections: { type: Boolean, default: true },
})

const open = ref(false)
// A field-less doc (exists only as a parent of subcollections, e.g. tools_limits/web_search) has
// nothing to show but its children — so auto-expand it to list them, no click needed.
const isEmpty = computed(() => !props.doc.data || Object.keys(props.doc.data).length === 0)
onMounted(() => { if (isEmpty.value && props.showSubcollections) toggle() })
const loaded = ref(false)
const loading = ref(false)
const subcollections = ref([])

// No indent — distinguish nesting by a cycling background tint per level.
const PALETTE = [
  'bg-transparent',
  'bg-gray-100 dark:bg-white/5',
  'bg-gray-200/70 dark:bg-white/10',
  'bg-gray-300/60 dark:bg-white/[0.15]',
]
const levelBg = computed(() => PALETTE[props.level % PALETTE.length])

const toggle = async () => {
  open.value = !open.value
  if (open.value && props.showSubcollections && !loaded.value) {
    loading.value = true
    try {
      const res = await $fetch('/api/store/firestore', { method: 'POST', body: { path: props.doc.path } })
      subcollections.value = res.subcollections || []
      loaded.value = true
    } catch (e) {
      console.error('Failed to load subcollections:', e)
    } finally {
      loading.value = false
    }
  }
}
</script>
