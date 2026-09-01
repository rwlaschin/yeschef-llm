<!-- Menu Plan page. Same shell as the Request page: a narrow history column on the left, a wide
     working panel on the right with tabs (New plan / Results). Menu jobs are ordinary llmResults
     docs, so the reused JobResults viewer streams them as-is. -->
<template>
  <div class="flex gap-4 h-full">
    <!-- Left: history -->
    <!-- The column itself does NOT scroll: the New plan button and the filters stay pinned, and
         only the list below them scrolls. overscroll-contain keeps the wheel from chaining to the
         page once that list hits its end. -->
    <div class="w-64 panel backdrop-blur-md p-4 flex flex-col min-h-0">
      <button
        type="button"
        class="mb-3 w-full px-3 py-2 rounded bg-amber-500 text-gray-900 hover:bg-amber-600 text-sm font-medium"
        @click="newPlan"
      >
        + New plan
      </button>
      <!-- Status filter. Dots only — the colors are the same ones the rows use for status, so the
           legend is the list itself. 'In flight' covers pending AND running: both mean not finished. -->
      <div class="flex items-center gap-1.5 mb-3">
        <button
          v-for="f in FILTERS"
          :key="f.key"
          type="button"
          :title="f.title"
          @click="filter = f.key"
          class="w-6 h-6 rounded flex items-center justify-center transition"
          :class="filter === f.key ? 'bg-amber-500/20 ring-1 ring-amber-500' : 'hover:bg-amber-500/10'"
        >
          <span v-if="f.key === 'all'" class="text-[10px] text-muted leading-none">All</span>
          <span v-else class="inline-block w-2 h-2 rounded-full" :class="f.dot"></span>
        </button>
      </div>
      <div ref="historyEl" class="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-2">
        <div v-if="!shown.length" class="text-muted text-xs text-center py-4">
          {{ history.length ? 'None match' : 'No menu plans' }}
        </div>
        <div
          v-for="h in shown"
          :key="h.id"
          class="group relative p-2 rounded-lg cursor-pointer transition text-xs border"
          :class="selected === h.id ? 'bg-amber-500/20 border-amber-500' : 'hover:bg-amber-500/10 border-transparent'"
          @click="select(h.id)"
        >
          <!-- Line 1: title + delete -->
          <div class="flex items-center gap-1">
            <div class="flex-1 min-w-0 truncate">{{ h.message || h.id.slice(0, 8) }}</div>
            <button
              type="button"
              @click.stop="deletePlan(h.id)"
              title="Delete"
              class="shrink-0 w-5 h-5 rounded flex items-center justify-center text-muted opacity-0 group-hover:opacity-100 hover:bg-error/20 hover:text-error active:scale-90 transition"
            >×</button>
          </div>
          <!-- Line 2: date -->
          <div class="text-[11px] text-muted mt-0.5">{{ fmtDate(h.createdAt) }}</div>
          <!-- Line 3: copy · id · status — copy stays on the LEFT, never between id and status -->
          <div class="mt-0.5 flex items-center gap-1.5">
            <button
              type="button"
              @click.stop="copy(h.id, 'Job ID copied')"
              title="Copy job ID"
              class="shrink-0 w-4 h-4 rounded flex items-center justify-center text-muted hover:text-amber-400 active:scale-90 transition"
            ><ClipboardDocumentIcon class="w-3.5 h-3.5" /></button>
            <span class="font-mono text-gray-50 flex-1 min-w-0">{{ h.id.slice(0, 8) }}</span>
            <span class="capitalize flex items-center gap-1 shrink-0"
              :class="h.status === 'success' ? 'text-success' : h.status === 'fail' ? 'text-error' : h.status === 'running' ? 'text-primary' : 'text-muted'">
              <span v-if="h.status === 'running'" class="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
              {{ h.status }}
            </span>
          </div>
        </div>
        <!-- Sentinel: entering the viewport pulls the next page. -->
        <div ref="sentinelEl" class="h-1"></div>
      </div>
    </div>

    <!-- Right: working panel with tabs -->
    <div class="flex-1 panel overflow-clip flex flex-col min-h-0">
      <div class="flex px-4 border-b border-divider">
        <button
          class="px-4 py-3 text-sm font-medium transition-colors"
          :class="tab === 'form' ? 'text-primary border-b-2 border-amber-500' : 'text-secondary hover:text-primary'"
          @click="tab = 'form'"
        >
          Plan
        </button>
        <button
          class="px-4 py-3 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          :class="tab === 'results' ? 'text-primary border-b-2 border-amber-500' : (selected ? 'text-secondary hover:text-primary' : 'text-secondary')"
          :disabled="!selected"
          @click="tab = 'results'"
        >
          Results
          <span v-if="selected && liveStatus === 'running'" class="ml-1.5 inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse align-middle"></span>
        </button>
      </div>

      <div class="flex-1 overflow-auto p-6 min-h-0">
        <MenuForm v-show="tab === 'form'" :preset="preset" @created="onCreated" @rerun="onRerun" />
        <div v-show="tab === 'results'">
          <JobResults v-if="selected" :jobId="selected" />
          <div v-else class="text-muted text-sm text-center py-8">Select a plan from history.</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { collection, query, orderBy, limit, onSnapshot, doc, getDoc } from 'firebase/firestore'
import { getDb } from '~/lib/firebase'
import MenuForm from '~/components/MenuForm.vue'
import JobResults from '~/components/JobResults.vue'
import { useJob } from '~/composables/useJob'
import { ClipboardDocumentIcon } from '@heroicons/vue/24/outline'

const tab = ref('form')
const selected = ref('')
const history = ref([])

// Status filter. 'inflight' deliberately matches BOTH pending and running — a job the worker never
// picked up sits on one or the other, and from the chef's side they are the same "not done yet".
const FILTERS = [
  { key: 'all',      dot: '',              title: 'All plans' },
  { key: 'inflight', dot: 'bg-amber-400',  title: 'Running / pending' },
  { key: 'success',  dot: 'bg-green-400',  title: 'Succeeded' },
  { key: 'fail',     dot: 'bg-red-400',    title: 'Failed' },
]
const filter = ref('all')
const shown = computed(() => (
  filter.value === 'all'
    ? history.value
    : history.value.filter((h) => (
        filter.value === 'inflight' ? h.status === 'running' || h.status === 'pending' : h.status === filter.value
      ))
))
let unsub = null
const coll = useRuntimeConfig().public.firestoreCollectionResults || 'llmResults'

// Live status of the selected job (drives the Results-tab pulse dot, mirroring the Request page).
const { jobStatus: liveStatus, bind } = useJob()

// The selected plan's saved inputs (menuPlans doc, id = jobId) → handed to MenuForm to prefill.
// MenuForm dirty-tracks it: its button reads "Rerun" while unchanged, "Generate" once edited.
const preset = ref(null)

const PAGE = 50
const pageLimit = ref(PAGE)
const hasMore = ref(false)

// Order by createdAt and filter to menu jobs client-side (avoids needing a composite index).
// One doc past the window tells us more exist without a count query.
const startHistory = () => {
  unsub && unsub()
  const q = query(collection(getDb(), coll), orderBy('createdAt', 'desc'), limit(pageLimit.value + 1))
  unsub = onSnapshot(q, (snap) => {
    // Re-subscribing emits a cached partial snapshot first — rendering it collapses the list to a
    // row or two for a beat. Ignore any cached snapshot smaller than what is already on screen.
    if (snap.metadata.fromCache && snap.docs.length < history.value.length) return
    hasMore.value = snap.docs.length > pageLimit.value
    history.value = snap.docs
      .slice(0, pageLimit.value)
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((r) => r.type === 'menu')
      .map((r) => ({
        id: r.jobId || r.id,
        companyId: r.companyId || '',
        message: r.message || '',
        status: r.status || 'pending',
        // A just-created doc has a pending serverTimestamp (null) — treat it as now so it
        // sorts to the TOP instead of falling to the bottom with createdAt 0.
        createdAt: r.createdAt?.toMillis?.() ?? Date.now(),
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
    nextTick(fill)
  })
}

// The status filter is applied client-side, so a page can render only a handful of rows — too few
// to push the sentinel off screen, and IntersectionObserver only fires on a transition. Keep
// pulling pages while the sentinel is still in view, so a filter that matches rarely still fills
// the column instead of stalling after one page.
const fill = () => {
  if (!hasMore.value || !historyEl.value || !sentinelEl.value) return
  const root = historyEl.value.getBoundingClientRect()
  const s = sentinelEl.value.getBoundingClientRect()
  if (s.top <= root.bottom + 200) loadMore()
}

// Infinite scroll. A sentinel + IntersectionObserver, not a scroll listener: the column's own
// scroll event never reaches Vue here, and the observer also re-fires when a short page leaves
// the sentinel still visible (the client-side type filter can thin a page down to a few rows).
const historyEl = ref(null)
const sentinelEl = ref(null)
let io = null

const loadMore = () => {
  if (!hasMore.value) return
  hasMore.value = false
  pageLimit.value += PAGE
  startHistory()
}

onMounted(() => {
  startHistory()
  io = new IntersectionObserver(
    (entries) => { if (entries.some((e) => e.isIntersecting)) loadMore() },
    { root: historyEl.value, rootMargin: '200px' }
  )
  io.observe(sentinelEl.value)
})

// Switching to a rarely-matching filter empties the column — pull more until it fills again.
watch(filter, () => nextTick(fill))
onBeforeUnmount(() => { unsub && unsub(); io && io.disconnect() })

const select = async (id) => {
  selected.value = id; bind(id); tab.value = 'results'
  // Load the saved inputs so the form is prefilled for edit/rerun (read-only get; the client never writes).
  try {
    // menuPlans is path-scoped under the company (companies/{companyId}/menuPlans/{jobId}).
    const cid = history.value.find((h) => h.id === id)?.companyId
    const snap = cid ? await getDoc(doc(getDb(), 'companies', cid, 'menuPlans', id)) : null
    preset.value = snap?.exists() ? { jobId: id, input: snap.data().input } : null
  } catch { preset.value = null }
}
const onCreated = (jobId) => { selected.value = jobId; bind(jobId); tab.value = 'results' }
const onRerun = (jobId) => { selected.value = jobId; bind(jobId); tab.value = 'results' }
const newPlan = () => { preset.value = null; tab.value = 'form' }

// Delete a plan: the shared endpoint removes BOTH the Job (llmResults/{id}, recursive) and the
// Menu (menuPlans/{id}). onSnapshot drops the row; if it was selected, reset to a fresh form.
const { error: showError } = useToast()
const { copy } = useClipboard()
const deletePlan = async (id) => {
  try {
    await $fetch(`/api/llm/${id}`, { method: 'DELETE' })
  } catch (err) {
    showError('Delete failed', err.message)
    return
  }
  if (selected.value === id) { selected.value = ''; newPlan() }
}
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
</script>
