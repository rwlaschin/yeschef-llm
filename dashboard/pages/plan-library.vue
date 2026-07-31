<!-- Step Library — author the step_definitions the menu plan is composed from (Mongo
     `plan_library`, alongside the prompt library). Same shape as the Prompt Library page: list +
     editor. Reads (GET) and writes (POST) both go through /ai/steps on the orchestrator function;
     the function reads the same collection at submit to render the plan. -->
<template>
  <div class="glass p-6" :class="editing ? 'h-full flex flex-col min-h-0' : ''">
    <div v-if="!editing" class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-serif text-primary">Plan Library</h1>
      <div class="flex items-center gap-2">
        <button
          type="button"
          :title="filterOpen ? 'Hide filters' : 'Show filters'"
          :aria-expanded="filterOpen"
          class="relative grid place-items-center w-8 h-8 shrink-0 rounded-lg active:scale-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40 transition"
          :class="filterOpen ? 'text-primary bg-amber-400/10' : 'text-secondary hover:text-primary hover:bg-amber-400/10'"
          @click="filterOpen = !filterOpen"
        >
          <FunnelIcon class="w-5 h-5" />
          <!-- Badge stays whether the bar is open or closed — an active filter must never be invisible. -->
          <span
            v-if="activeFilterCount"
            class="absolute -top-1 -right-1 min-w-[1rem] h-4 px-1 grid place-items-center rounded-full bg-amber-500 text-gray-900 text-[10px] font-medium leading-none"
          >{{ activeFilterCount }}</span>
        </button>
        <button
          type="button"
          class="flex items-center gap-2 px-4 py-2 bg-amber-500 text-gray-900 rounded-lg font-medium hover:bg-amber-600 transition"
          @click="startCreate"
        >
          <PlusIcon class="w-4 h-4" /> New Step
        </button>
      </div>
    </div>

    <StepForm v-if="editing" :step="editing" :step-options="stepOptions" @save="saveStep" @cancel="editing = null" />

    <template v-else>
      <div v-if="filterOpen" class="rounded-lg surface-2-soft border border-divider p-3 mb-4 space-y-3">
        <div class="grid grid-cols-[4rem_1fr] items-start gap-1.5" role="group" aria-label="Filter by step type">
          <span class="text-xs text-muted pt-1">type</span>
          <div class="flex flex-wrap gap-1.5">
          <button
            v-for="t in SUBTYPES" :key="t.name"
            type="button"
            :title="t.description"
            :aria-pressed="typeFilter.includes(t.name)"
            class="px-2.5 py-1 rounded-full text-xs font-mono border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40"
            :class="typeFilter.includes(t.name)
              ? 'bg-amber-500/15 text-primary border-amber-500/40'
              : 'text-secondary border-divider hover:bg-amber-500/10'"
            @click="toggleType(t.name)"
          >{{ t.name }}</button>
          </div>
        </div>
        <div class="grid grid-cols-[4rem_1fr] items-start gap-1.5" role="group" aria-label="Filter by operation">
          <span class="text-xs text-muted pt-1">operation</span>
          <div class="flex flex-wrap gap-1.5">
          <button
            v-for="k in kinds" :key="k"
            type="button"
            :aria-pressed="kindFilter.includes(k)"
            class="px-2.5 py-1 rounded-full text-xs font-mono border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40"
            :class="kindFilter.includes(k)
              ? 'bg-amber-500/15 text-primary border-amber-500/40'
              : 'text-secondary border-divider hover:bg-amber-500/10'"
            @click="toggleKind(k)"
          >{{ k }}</button>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <input v-model="textFilter" placeholder="Filter by name or instruction…" class="form-input text-sm flex-1 max-w-md" />
          <span class="text-xs text-muted whitespace-nowrap">{{ visibleSteps.length }} of {{ steps.length }} steps{{ filterActive ? ' · reordering paused' : '' }}</span>
          <button v-if="activeFilterCount" type="button" class="flex items-center gap-1 text-xs text-secondary hover:text-primary transition" @click="clearFilters">
            <XMarkIcon class="w-3.5 h-3.5" /> Clear filters
          </button>
        </div>
      </div>

      <div v-if="loading" class="text-muted text-sm py-10 text-center">Loading…</div>
      <div v-else-if="!steps.length" class="text-muted text-sm py-10 text-center">No steps yet — create one.</div>
      <div v-else-if="!visibleSteps.length" class="text-muted text-sm py-10 text-center">
        No steps match your filters
        <button type="button" class="block mx-auto mt-2 text-primary hover:underline text-sm" @click="clearFilters">Clear filters</button>
      </div>
      <div class="space-y-2">
        <div
          v-for="s in visibleSteps"
          :key="s.id"
          :draggable="!filterActive"
          class="group flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded-lg border transition"
          :class="[
            s.active ? '' : 'opacity-50',
            dragId === s.id ? 'opacity-40' : '',
            overId === s.id && dragId !== s.id ? 'border-amber-500 ring-1 ring-amber-500' : 'border-divider hover:bg-amber-500/5',
          ]"
          @dragstart="dragId = s.id"
          @dragend="resetDrag"
          @dragover.prevent
          @dragenter="overId = s.id"
          @drop="onDrop(s.id)"
        >
          <Bars2Icon
            class="w-4 h-4 text-muted shrink-0"
            :class="filterActive ? 'opacity-20 cursor-not-allowed' : 'opacity-40 group-hover:opacity-100 cursor-move'"
            :title="filterActive ? 'Clear filters to reorder' : 'Drag to reorder'"
          />
          <div class="flex-1 min-w-0">
            <div class="flex flex-wrap items-baseline gap-x-2">
              <span class="text-sm font-medium text-strong truncate">{{ s.name }}</span>
              <span class="text-xs text-muted shrink-0">{{ s.subtype }} · {{ s.kind }}{{ s.mapOf ? ` · per ${s.mapOf}` : '' }}</span>
              <span
                v-if="issuesById.get(s.id)?.length"
                class="text-xs text-error shrink-0 cursor-help"
                :title="'Fix these links:\n· ' + issuesById.get(s.id).join('\n· ')"
              >⚠ {{ issuesById.get(s.id).length }} link issue{{ issuesById.get(s.id).length > 1 ? 's' : '' }}</span>
              <span v-if="s.requiredFlags?.length" class="text-xs text-amber-400 shrink-0" :title="'requires: ' + s.requiredFlags.join(', ')">⚑ {{ s.requiredFlags.join(',') }}</span>
              <span v-if="s.includeInOutput" class="text-xs text-success shrink-0 cursor-help" title="This step's result is included in the plan's final output">output</span>
            </div>
            <div class="text-sm text-secondary whitespace-pre-wrap break-words mt-1">{{ s.instruction || '(no instruction)' }}</div>
          </div>
          <div class="flex sm:flex-col items-center gap-3 sm:gap-4 self-end sm:self-auto shrink-0">
            <Toggle :model-value="s.active" @update:model-value="toggleActive(s)" />
            <div class="flex items-center gap-1">
              <button type="button" title="Edit" class="grid place-items-center w-8 h-8 rounded-lg text-secondary hover:text-primary hover:bg-amber-400/10 active:scale-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40 transition shrink-0" @click="editStep(s)">
                <PencilSquareIcon class="w-5 h-5" />
              </button>
              <button type="button" title="Delete" class="grid place-items-center w-8 h-8 rounded-lg text-error opacity-60 hover:opacity-100 hover:bg-red-500/10 active:scale-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40 transition shrink-0" @click="removeStep(s)">
                <TrashIcon class="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <ConfirmDialog ref="confirmDialog" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { PlusIcon, PencilSquareIcon, TrashIcon, Bars2Icon, FunnelIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import { SUBTYPES } from '#models'
import { lexBetween } from '~/utils/lexBetween'
import StepForm from '~/components/StepForm.vue'
import ConfirmDialog from '~/components/ConfirmDialog.vue'

const steps = ref([])
const editing = ref(null)
const confirmDialog = ref(null)
const toast = useToast()

// Reads (GET) and writes (POST) both go through /ai/steps on the orchestrator function (Mongo
// plan_library). Mongo has no realtime feed, so re-fetch after each write — like the Prompts page.
const { env } = useEnvironment()
const cfg = useRuntimeConfig().public
const aiBase = computed(() => String(env.value === 'production' ? cfg.aiBaseUrl : cfg.aiBaseUrlLocal).replace(/\/$/, ''))
const { getToken } = useAuth()
const authHdr = async () => ({ Authorization: `Bearer ${await getToken()}` })
const writeStep = async (body) => $fetch(`${aiBase.value}/steps`, { method: 'POST', body, headers: await authHdr() })
const loading = ref(true)
const fetchSteps = async () => {
  try { steps.value = await $fetch(`${aiBase.value}/steps`, { headers: await authHdr() }) }
  catch (e) { toast.error('Failed to load steps', e.data?.error || e.message) }
  finally { loading.value = false }
}

// "Depends on" picker options: other steps shown as "name (subtype)" (value = the step name),
// excluding the step currently being edited.
const stepOptions = computed(() => steps.value
  .filter((s) => s.id !== editing.value?.id)
  .map((s) => ({ value: s.name, label: `${s.name} (${s.subtype})` })))

// Sanity of a step's links — context (earlier deps), On-failure revert target, On-success target.
// All three are step NAMES; an empty/unset ref is FINE (it means the sane default: no dep / re-run
// this step / linear next). We flag only NON-empty refs that are broken: missing step, self-reference,
// or pointing the WRONG WAY (context + on-failure must be an EARLIER step, since the plan replays from
// there). Returns plain-language problems so the list can warn and you can fix by reorder/repick.
// Filters are client-side over the fetched list. Type pills are multi-select (OR within types,
// AND with the text query). Issues are keyed by id off the FULL list — refIssues depends on a
// step's true position, which a filtered render index would get wrong.
const filterOpen = ref(false)
const typeFilter = ref([])
const textFilter = ref('')
const toggleType = (name) => {
  typeFilter.value = typeFilter.value.includes(name)
    ? typeFilter.value.filter((t) => t !== name)
    : [...typeFilter.value, name]
}
const kindFilter = ref([])
const toggleKind = (k) => {
  kindFilter.value = kindFilter.value.includes(k)
    ? kindFilter.value.filter((x) => x !== k)
    : [...kindFilter.value, k]
}
// Operations offered are the kinds present in the data — stays in sync with whatever kinds exist.
const kinds = computed(() => [...new Set(steps.value.map((s) => s.kind).filter(Boolean))])
const clearFilters = () => { typeFilter.value = []; kindFilter.value = []; textFilter.value = '' }
const filterActive = computed(() => typeFilter.value.length > 0 || kindFilter.value.length > 0 || textFilter.value.trim() !== '')
const activeFilterCount = computed(() => typeFilter.value.length + kindFilter.value.length + (textFilter.value.trim() ? 1 : 0))
const visibleSteps = computed(() => {
  const q = textFilter.value.trim().toLowerCase()
  return steps.value.filter((s) =>
    (!typeFilter.value.length || typeFilter.value.includes(s.subtype))
    && (!kindFilter.value.length || kindFilter.value.includes(s.kind))
    && (!q || `${s.name || ''} ${s.instruction || ''}`.toLowerCase().includes(q)))
})
const issuesById = computed(() => new Map(steps.value.map((s, i) => [s.id, refIssues(s, i)])))

const refIssues = (s, i) => {
  const names = steps.value.map((x) => x.name)
  const earlier = new Set(steps.value.slice(0, i).map((x) => x.name))
  const out = []
  for (const name of (s.context || [])) {
    if (!names.includes(name)) out.push(`context "${name}" — no such step`)
    else if (!earlier.has(name)) out.push(`context "${name}" — runs after this step (reorder it earlier)`)
  }
  if (s.failStep) {
    if (!names.includes(s.failStep)) out.push(`on-failure "${s.failStep}" — no such step (will just re-run this step)`)
    else if (s.failStep === s.name) out.push(`on-failure points at itself`)
    else if (!earlier.has(s.failStep)) out.push(`on-failure "${s.failStep}" — runs after this step (will just re-run this step)`)
  }
  if (s.successStep && !names.includes(s.successStep)) out.push(`on-success "${s.successStep}" — no such step`)
  return out
}

onMounted(fetchSteps)

const startCreate = () => {
  const last = steps.value.length ? String(steps.value.at(-1).order ?? '') : null
  editing.value = { order: lexBetween(last, null) } // append to the end of the order
}
const editStep = (s) => { editing.value = JSON.parse(JSON.stringify(s)) }

// Drag-drop reorder (same idiom as the Prompts list): on drop, compute a lexBetween order key for
// the moved row and persist it via the server, then re-fetch (the list re-sorts by 'order').
const dragId = ref(null)
const overId = ref(null)
const resetDrag = () => { dragId.value = null; overId.value = null }
const onDrop = async (dropId) => {
  const id = dragId.value
  // Reordering against filtered neighbors would compute an order key between non-adjacent rows.
  if (filterActive.value) return resetDrag()
  if (!id || id === dropId) return resetDrag()
  const arr = [...steps.value]
  const from = arr.findIndex((s) => s.id === id)
  const to = arr.findIndex((s) => s.id === dropId)
  if (from < 0 || to < 0) return resetDrag()
  const [moved] = arr.splice(from, 1)
  arr.splice(to, 0, moved)
  const idx = arr.findIndex((s) => s.id === id)
  const prev = idx > 0 ? String(arr[idx - 1].order ?? '') : null
  const next = idx < arr.length - 1 ? String(arr[idx + 1].order ?? '') : null
  try { await writeStep({ op: 'update', id, doc: { order: lexBetween(prev, next) } }); await fetchSteps() }
  catch (e) { toast.error('Reorder failed', e.data?.error || e.message) }
  resetDrag()
}

const saveStep = async (data) => {
  try {
    const { id, ...payload } = data
    await writeStep({ op: id ? 'update' : 'create', id, doc: payload })
    await fetchSteps()
    editing.value = null
    toast.success(id ? 'Step updated' : 'Step created')
  } catch (e) {
    toast.error('Save failed', e.data?.error || e.message)
  }
}

const toggleActive = async (s) => {
  try { await writeStep({ op: 'update', id: s.id, doc: { active: !s.active } }); await fetchSteps() }
  catch (e) { toast.error('Toggle failed', e.data?.error || e.message) }
}

const removeStep = async (s) => {
  const ok = await confirmDialog.value.open({ title: 'Delete step', message: `Delete "${s.name}"? This cannot be undone.`, confirmText: 'Delete', isDangerous: true })
  if (!ok) return
  try { await writeStep({ op: 'delete', id: s.id }); await fetchSteps() }
  catch (e) { toast.error('Delete failed', e.data?.error || e.message) }
}
</script>
