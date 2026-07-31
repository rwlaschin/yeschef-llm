<template>
  <div class="flex h-full min-h-0 gap-3">
    <!-- Canvas -->
    <div class="relative flex-1 panel overflow-clip rounded-lg min-h-0">
      <!-- Top-left: search + filter -->
      <div class="absolute top-3 left-3 right-3 z-10 flex items-center gap-2">
        <div class="flex items-center gap-2 bg-black/30 backdrop-blur rounded-lg px-3 min-h-9 flex-1 max-w-sm border border-white/10">
          <span class="text-muted text-xs">⌕</span>
          <input v-model="search" placeholder="Search nodes…" class="flex-1 bg-transparent outline-none text-xs text-secondary" />
        </div>
        <button @click="reload" :disabled="loading" class="px-3 min-h-9 text-xs btn-muted rounded-lg hover:text-primary disabled:opacity-50">
          {{ loading ? '…' : 'Reload' }}
        </button>
      </div>

      <!-- Empty / error / loading -->
      <div v-if="error" class="flex items-center justify-center h-full text-error text-xs p-6 text-center">{{ error }}</div>
      <div v-else-if="loading" class="flex items-center justify-center h-full text-muted text-xs">Loading graph…</div>
      <div v-else-if="!nodes.length" class="flex items-center justify-center h-full text-muted text-xs">No nodes in this database.</div>

      <v-network-graph
        v-else
        ref="graphRef"
        v-model:zoom-level="zoom"
        v-model:selected-nodes="selectedNodes"
        :nodes="vgNodes"
        :edges="vgEdges"
        :layouts="layouts"
        :configs="configs"
        :event-handlers="eventHandlers"
        class="w-full h-full"
      />

      <!-- Bottom-left: count + layout selector -->
      <div class="absolute bottom-3 left-3 z-10 flex items-center gap-2">
        <div class="px-3 min-h-[34px] flex items-center text-xs text-muted bg-black/30 backdrop-blur rounded-lg border border-white/10">
          {{ shownNodes.length }}/{{ nodes.length }} nodes
        </div>
        <select v-model="layout" class="px-3 min-h-[34px] btn-muted border border-white/10 rounded-lg text-xs hover:text-primary">
          <option v-for="l in LAYOUTS" :key="l.id" :value="l.id">{{ l.label }}</option>
        </select>
      </div>

      <!-- Bottom-right: zoom -->
      <div class="absolute bottom-3 right-3 z-10 flex flex-col items-center gap-1">
        <button @click="zoom = Math.min(4, zoom * 1.25)" class="w-8 h-8 grid place-items-center text-sm btn-muted border border-white/10 rounded-lg hover:text-primary">+</button>
        <button @click="zoom = Math.max(0.1, zoom / 1.25)" class="w-8 h-8 grid place-items-center text-sm btn-muted border border-white/10 rounded-lg hover:text-primary">−</button>
        <div class="text-[10px] text-muted">{{ Math.round(zoom * 100) }}%</div>
      </div>
    </div>

    <!-- Right panel -->
    <div class="w-72 panel rounded-lg flex flex-col min-h-0">
      <!-- Selected node → properties -->
      <div v-if="selected" class="flex flex-col min-h-0 h-full">
        <div class="flex items-center justify-between p-3 border-b border-white/10">
          <button @click="selectedNodes = []" class="text-xs text-muted hover:text-primary">← Back</button>
          <span class="w-3 h-3 rounded-full" :style="{ background: colorFor(selected.labels[0]) }" />
        </div>
        <div class="p-3 space-y-2 overflow-auto">
          <div class="text-xs text-muted uppercase tracking-wide">{{ selected.labels.join(' · ') }}</div>
          <div class="text-sm text-secondary font-semibold break-words">{{ nameOf(selected) }}</div>
          <div class="pt-2 space-y-1">
            <div v-for="(v, k) in selected.properties" :key="k" class="text-xs grid grid-cols-[auto_1fr] gap-2">
              <span class="text-muted">{{ k }}</span>
              <span class="text-secondary font-mono break-words text-right">{{ fmt(v) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Tabs: Nodes / Relationships -->
      <template v-else>
        <div class="flex border-b border-white/10">
          <button v-for="t in ['Nodes', 'Relationships']" :key="t" @click="tab = t"
            :class="['flex-1 py-2.5 text-xs font-semibold transition', tab === t ? 'text-primary border-b-2 border-amber-500' : 'text-muted hover:text-secondary']">
            {{ t }}
          </button>
        </div>
        <div class="p-3">
          <input v-model="catFilter" :placeholder="`Filter ${tab.toLowerCase()}`" class="w-full form-input text-xs" />
        </div>
        <div class="flex-1 overflow-auto px-3 pb-3 space-y-1">
          <!-- Nodes (labels) -->
          <template v-if="tab === 'Nodes'">
            <button v-for="c in shownCategories" :key="c.label" @click="toggleCat(c.label)"
              :class="['w-full flex items-center gap-3 p-2 rounded-lg transition', hidden.has(c.label) ? 'opacity-40' : 'hover:bg-white/5']">
              <span class="w-5 h-5 rounded-full shrink-0" :style="{ background: colorFor(c.label) }" />
              <span class="flex-1 text-left text-sm text-secondary truncate">{{ c.label }}</span>
              <span class="text-xs text-muted">{{ c.count }}</span>
            </button>
            <div v-if="!shownCategories.length" class="text-xs text-muted text-center py-4">No categories.</div>
          </template>
          <!-- Relationships (types) -->
          <template v-else>
            <div v-for="r in shownRelTypes" :key="r.type" class="w-full flex items-center gap-3 p-2 rounded-lg">
              <span class="w-2 h-5 rounded shrink-0 bg-white/30" />
              <span class="flex-1 text-left text-sm text-secondary truncate">{{ r.type }}</span>
              <span class="text-xs text-muted">{{ r.count }}</span>
            </div>
            <div v-if="!shownRelTypes.length" class="text-xs text-muted text-center py-4">No relationships.</div>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { VNetworkGraph, defineConfigs } from 'v-network-graph'
import { ForceLayout } from 'v-network-graph/lib/force-layout'
import 'v-network-graph/lib/style.css'

const props = defineProps({ env: { type: String, default: 'local' } })

const LAYOUTS = [
  { id: 'force', label: 'Force-based layout' },
  { id: 'grid', label: 'Grid layout' },
  { id: 'circular', label: 'Circular layout' },
]
// Stable category palette — assigned per label in first-seen order.
const PALETTE = ['#f5a623', '#5b9bd5', '#e8788a', '#f0c419', '#9b7ede', '#5fb88a', '#e07a5f', '#7ec4cf', '#c98bdb', '#b0b884']

const nodes = ref([])           // [{ id, labels, properties }]
const relationships = ref([])   // [{ id, type, from, to, properties }]
const loading = ref(false)
const error = ref('')
const tab = ref('Nodes')
const search = ref('')
const catFilter = ref('')
const hidden = ref(new Set())   // hidden category labels
const layout = ref('force')
const zoom = ref(1)
const selectedNodes = ref([])
const graphRef = ref(null)

const colorMap = new Map()
function colorFor(label) {
  if (!colorMap.has(label)) colorMap.set(label, PALETTE[colorMap.size % PALETTE.length])
  return colorMap.get(label)
}
const catOf = (n) => n.labels?.[0] ?? 'Node'
function nameOf(n) {
  const p = n.properties || {}
  // Human-readable props only — never a UUID `id`/`key` (those make the canvas unreadable).
  const k = ['name', 'title', 'label', 'displayName', 'dish'].find((x) => p[x] != null)
  const v = k ? String(p[k]) : catOf(n)
  return v.length > 28 ? v.slice(0, 27) + '…' : v
}
const fmt = (v) => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))

// Category + relationship-type counts.
const categories = computed(() => {
  const m = new Map()
  for (const n of nodes.value) { const c = catOf(n); m.set(c, (m.get(c) || 0) + 1) }
  return [...m.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count)
})
const relTypes = computed(() => {
  const m = new Map()
  for (const r of relationships.value) m.set(r.type, (m.get(r.type) || 0) + 1)
  return [...m.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count)
})
const shownCategories = computed(() => categories.value.filter((c) => !catFilter.value || c.label.toLowerCase().includes(catFilter.value.toLowerCase())))
const shownRelTypes = computed(() => relTypes.value.filter((r) => !catFilter.value || r.type.toLowerCase().includes(catFilter.value.toLowerCase())))

function toggleCat(label) {
  const s = new Set(hidden.value)
  s.has(label) ? s.delete(label) : s.add(label)
  hidden.value = s
}

// Visible nodes = category not hidden AND matches search.
const shownNodes = computed(() => {
  const q = search.value.trim().toLowerCase()
  return nodes.value.filter((n) => !hidden.value.has(catOf(n)) && (!q || nameOf(n).toLowerCase().includes(q) || catOf(n).toLowerCase().includes(q)))
})
const shownIds = computed(() => new Set(shownNodes.value.map((n) => n.id)))

const selected = computed(() => nodes.value.find((n) => n.id === selectedNodes.value[0]) || null)

// v-network-graph data shapes.
const vgNodes = computed(() => {
  const o = {}
  for (const n of shownNodes.value) o[n.id] = { name: nameOf(n), color: colorFor(catOf(n)) }
  return o
})
const vgEdges = computed(() => {
  const o = {}
  for (const r of relationships.value) {
    if (shownIds.value.has(r.from) && shownIds.value.has(r.to)) o[r.id] = { source: r.from, target: r.to, label: r.type }
  }
  return o
})

// Layout positions for non-force layouts (force lets the handler place them).
const layouts = ref({ nodes: {} })
function recomputeLayout() {
  if (layout.value === 'force') { layouts.value = { nodes: {} }; return }
  const ids = shownNodes.value.map((n) => n.id)
  const pos = {}
  if (layout.value === 'grid') {
    const cols = Math.ceil(Math.sqrt(ids.length)) || 1
    ids.forEach((id, i) => { pos[id] = { x: (i % cols) * 120, y: Math.floor(i / cols) * 120 } })
  } else { // circular
    const R = Math.max(160, ids.length * 14)
    ids.forEach((id, i) => { const a = (i / Math.max(1, ids.length)) * Math.PI * 2; pos[id] = { x: Math.cos(a) * R, y: Math.sin(a) * R } })
  }
  layouts.value = { nodes: pos }
}
watch([layout, shownNodes], recomputeLayout, { immediate: true })

const force = new ForceLayout({ positionFixedByDrag: false, positionFixedByClickWithAltKey: true })
const configs = computed(() => defineConfigs({
  view: {
    scalingObjects: true,
    minZoom: 0.1,
    maxZoom: 4,
    ...(layout.value === 'force' ? { layoutHandler: force } : {}),
  },
  node: {
    normal: { radius: 18, color: (n) => n.color },
    hover: { radius: 20, color: (n) => n.color },
    selectable: true,
    // Captions get unreadable past ~60 nodes — hide them when dense, show once filtered down.
    label: { visible: shownNodes.value.length <= 60, fontSize: 10, color: '#cbd5e1', directionAutoAdjustment: true },
  },
  edge: {
    normal: { color: '#94a3b830', width: 1.5 },
    hover: { color: '#f5a623', width: 2.5 },
    marker: { target: { type: 'arrow' } },
    label: { fontSize: 8, color: '#64748b' },
  },
}))

const eventHandlers = { 'node:click': ({ node }) => { selectedNodes.value = [node] } }

async function reload() {
  loading.value = true
  error.value = ''
  try {
    const res = await $fetch('/api/store/neo4j-graph', { method: 'POST', body: { env: props.env, limit: 300 } })
    nodes.value = res.nodes || []
    relationships.value = res.relationships || []
    // Seed the palette so the sidebar + canvas agree on colors.
    categories.value.forEach((c) => colorFor(c.label))
  } catch (err) {
    error.value = err?.data?.statusMessage || err?.message || 'Failed to load graph'
  } finally {
    loading.value = false
  }
}

watch(() => props.env, reload)
onMounted(reload)
defineExpose({ reload })
</script>
