<!-- Task Lists page. Same shell as the Menu Plan page: a narrow history column on the left, a wide
     working panel on the right with tabs (Tasks / Results). A task list is an ordinary llmResults doc
     carrying type: "tquery" (written by POST /ai/tquery), so the reused JobResults viewer streams it
     as-is and nothing here is task-list-specific except the filter and the composer. -->
<template>
  <div class="flex gap-4 h-full">
    <!-- Left: history -->
    <div class="w-64 panel backdrop-blur-md p-4 overflow-y-auto flex flex-col min-h-0">
      <!-- Status filter. Same dots-only control as the Menu Plan page — the colors match the row
           statuses, so the legend is the list itself. 'In flight' covers pending AND running. -->
      <button
        type="button"
        class="mb-3 w-full px-3 py-2 rounded bg-amber-500 text-gray-900 hover:bg-amber-600 text-sm font-medium"
        @click="newTaskList"
      >
        + New task list
      </button>
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
      <div class="space-y-2">
        <div v-if="!shown.length" class="text-muted text-xs text-center py-4">
          {{ history.length ? 'None match' : 'No task lists' }}
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
              @click.stop="deleteTaskList(h.id)"
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
      </div>
    </div>

    <!-- Right: the selected task list's steps and answers -->
    <div class="flex-1 panel overflow-clip flex flex-col min-h-0">
      <div class="flex px-4 border-b border-divider">
        <button
          class="px-4 py-3 text-sm font-medium transition-colors"
          :class="tab === 'form' ? 'text-primary border-b-2 border-amber-500' : 'text-secondary hover:text-primary'"
          @click="tab = 'form'"
        >
          Tasks
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
        <TaskListForm v-show="tab === 'form'" :preset="preset" @created="onCreated" />
        <div v-show="tab === 'results'">
          <!-- The tasks AS SUBMITTED, so an unfinished list still shows what was asked for. This is the
               caller's list only — the server wraps it (pre-sanitize … post-sanitize), so the step cards
               below can legitimately show MORE steps than there are lines here. -->
          <div v-if="selectedTasks.length" class="text-[11px] uppercase tracking-wide text-muted mb-1">Requested tasks</div>
          <ol v-if="selectedTasks.length" class="mb-5 space-y-1 text-xs text-secondary list-decimal pl-5">
            <li v-for="(t, i) in selectedTasks" :key="i">
              <span class="text-muted">{{ t.subtype }}</span> — {{ t.query }}
            </li>
          </ol>
          <JobResults v-if="selected" :jobId="selected" />
          <div v-else class="text-muted text-sm text-center py-8">Select a task list from history.</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore'
import { getDb } from '~/lib/firebase'
import JobResults from '~/components/JobResults.vue'
import { useJob } from '~/composables/useJob'
import { ClipboardDocumentIcon } from '@heroicons/vue/24/outline'

const tab = ref('form')
const selected = ref('')
const history = ref([])

// The selected list's submitted tasks → handed to TaskListForm to prefill, the same way menu.vue
// hands MenuForm a preset. Read off the job doc's `input.tasks`; there is no second collection.
const preset = ref(null)

const FILTERS = [
  { key: 'all',      dot: '',              title: 'All task lists' },
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

// DEEPLINK: /tasks?job=<id> opens straight onto that list's results. Same shape as prompts.vue's
// ?type= — the query string IS the selection, so a link survives a reload and can be shared.
const route = useRoute()
const router = useRouter()

const { jobStatus: liveStatus, bind } = useJob()
const selectedTasks = computed(() => history.value.find((h) => h.id === selected.value)?.tasks || [])

onMounted(() => {
  // A ?job= in the URL binds BEFORE history arrives — the job doc and its steps are their own
  // listens, so a deeplinked list streams immediately instead of waiting for the history query.
  const linked = typeof route.query.job === 'string' ? route.query.job : ''
  if (linked) { selected.value = linked; bind(linked); tab.value = 'results' }

  // Order by createdAt and filter to task-list jobs client-side (avoids needing a composite index).
  const q = query(collection(getDb(), coll), orderBy('createdAt', 'desc'), limit(50))
  unsub = onSnapshot(q, (snap) => {
    history.value = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((r) => r.type === 'tquery')
      .map((r) => ({
        id: r.jobId || r.id,
        message: r.message || '',
        status: r.status || 'pending',
        tasks: r.input?.tasks || [],
        createdAt: r.createdAt?.toMillis?.() ?? 0,
      }))
    // A deeplinked list is bound before this arrives, so its form prefill fills in here.
    if (selected.value && !preset.value) {
      preset.value = { jobId: selected.value, tasks: history.value.find((h) => h.id === selected.value)?.tasks || [] }
    }
  })
})
onBeforeUnmount(() => unsub && unsub())

// The URL follows the selection, so what the reader is looking at is always linkable. `replace`,
// not `push`: clicking down a history list is browsing one page, not a stack of back steps.
const link = (id) => router.replace({ query: id ? { ...route.query, job: id } : { ...route.query, job: undefined } })

const select = (id) => {
  selected.value = id; bind(id); tab.value = 'results'
  preset.value = { jobId: id, tasks: history.value.find((h) => h.id === id)?.tasks || [] }
  link(id)
}
// onSnapshot adds the new job to history on its own; this just focuses its results.
const onCreated = (id) => { selected.value = id; bind(id); tab.value = 'results'; link(id) }
const newTaskList = () => { preset.value = null; tab.value = 'form'; selected.value = ''; link('') }

const { error: showError } = useToast()
const { copy } = useClipboard()
// Same shared endpoint the other pages use — removes llmResults/{id} recursively.
const deleteTaskList = async (id) => {
  try {
    await $fetch(`/api/llm/${id}`, { method: 'DELETE' })
  } catch (err) {
    showError('Delete failed', err.message)
    return
  }
  if (selected.value === id) { selected.value = ''; newTaskList() }
}
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
</script>
