<!-- Step Library — author the step_definitions the menu plan is composed from (Mongo
     `plan_library`, alongside the prompt library). Same shape as the Prompt Library page: list +
     editor. Reads (GET) and writes (POST) both go through /ai/steps on the orchestrator function;
     the function reads the same collection at submit to render the plan. -->
<template>
  <div class="glass p-6" :class="editing ? 'h-full flex flex-col min-h-0' : ''">
    <div v-if="!editing" class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-serif text-primary">Plan Library</h1>
      <button
        type="button"
        class="flex items-center gap-2 px-4 py-2 bg-amber-500 text-gray-900 rounded-lg font-medium hover:bg-amber-600 transition"
        @click="startCreate"
      >
        <PlusIcon class="w-4 h-4" /> New Step
      </button>
    </div>

    <StepForm v-if="editing" :step="editing" :step-options="stepOptions" @save="saveStep" @cancel="editing = null" />

    <template v-else>
      <div v-if="!steps.length" class="text-muted text-sm py-10 text-center">No steps yet — create one.</div>
      <div class="space-y-2">
        <div
          v-for="(s, i) in steps"
          :key="s.id"
          draggable="true"
          class="group flex items-center gap-3 p-3 rounded-lg border transition"
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
          <Bars2Icon class="w-4 h-4 text-muted opacity-40 group-hover:opacity-100 cursor-move shrink-0" title="Drag to reorder" />
          <div class="flex-1 min-w-0">
            <div class="flex items-baseline gap-2">
              <span class="text-sm font-medium text-strong truncate">{{ s.name }}</span>
              <span class="text-xs text-muted shrink-0">{{ s.subtype }} · {{ s.kind }}{{ s.mapOf ? ` · per ${s.mapOf}` : '' }}</span>
            </div>
            <div class="text-sm text-secondary whitespace-pre-wrap break-words mt-1">{{ s.instruction || '(no instruction)' }}</div>
          </div>
          <span
            v-if="refIssues(s, i).length"
            class="text-xs text-error shrink-0 cursor-help"
            :title="'Fix these links:\n· ' + refIssues(s, i).join('\n· ')"
          >⚠ {{ refIssues(s, i).length }} link issue{{ refIssues(s, i).length > 1 ? 's' : '' }}</span>
          <span v-if="s.requiredFlags?.length" class="text-xs text-amber-400 shrink-0" :title="'requires: ' + s.requiredFlags.join(', ')">⚑ {{ s.requiredFlags.join(',') }}</span>
          <span v-if="s.includeInOutput" class="text-xs text-success shrink-0">output</span>
          <Toggle :model-value="s.active" @update:model-value="toggleActive(s)" />
          <button type="button" title="Edit" class="grid place-items-center w-8 h-8 rounded-lg text-secondary hover:text-primary hover:bg-amber-400/10 active:scale-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40 transition shrink-0" @click="editStep(s)">
            <PencilSquareIcon class="w-5 h-5" />
          </button>
          <button type="button" title="Delete" class="grid place-items-center w-8 h-8 rounded-lg text-secondary hover:text-error hover:bg-red-500/10 active:scale-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40 transition shrink-0" @click="removeStep(s)">
            <TrashIcon class="w-5 h-5" />
          </button>
        </div>
      </div>
    </template>

    <ConfirmDialog ref="confirmDialog" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { PlusIcon, PencilSquareIcon, TrashIcon, Bars2Icon } from '@heroicons/vue/24/outline'
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
const writeStep = (body) => $fetch(`${aiBase.value}/steps`, { method: 'POST', body })
const fetchSteps = async () => {
  try { steps.value = await $fetch(`${aiBase.value}/steps`) }
  catch (e) { toast.error('Failed to load steps', e.data?.error || e.message) }
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
