<template>
  <div class="flex flex-col gap-3">
    <!-- Copy all: Plan + every step's output, in run order. Only when there's something to copy. -->
    <div v-if="plan || executed.length" class="flex items-center justify-end">
      <button type="button" @click="copy(fullText(), 'all')"
        :title="copiedKey === 'all' ? 'Copied' : 'Copy everything'"
        class="flex items-center gap-1.5 text-xs text-muted hover:text-amber-400 transition px-2 py-1 rounded cursor-pointer active:scale-95">
        <component :is="copiedKey === 'all' ? CheckIcon : ClipboardDocumentIcon" class="w-4 h-4" />
        {{ copiedKey === 'all' ? 'Copied' : 'Copy all' }}
      </button>
    </div>

    <!-- Plan: the planner's raw output (displayAs:"plan"). Muted, collapsible. -->
    <div v-if="plan" class="rounded border-divider bg-black/5 dark:bg-white/5">
      <div class="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted">
        <button type="button" @click="togglePlan" class="flex items-center gap-1.5 shrink-0 text-left">
          <ChevronRightIcon class="w-3.5 h-3.5 shrink-0 transition-transform" :class="planOpen ? 'rotate-90' : ''" />
          <span class="font-medium">Plan</span>
        </button>
        <!-- Right-side columns, aligned across the Plan + every step row: failure · status · time · actions.
             failure is right-anchored via ml-auto (the auto margin eats the free space, so it hugs the
             status side instead of stretching from the label) and TRUNCATES (min-w-0 + truncate) only
             when genuinely too long. Empty on success → the margin still right-anchors the columns. -->
        <span class="ml-auto min-w-0 truncate text-error" :title="reasons(plan.outcome).join('\n')">{{ firstReason(plan.outcome) }}</span>
        <span v-if="reasons(plan.outcome).length > 1" class="shrink-0 tabular-nums text-error opacity-70" :title="reasons(plan.outcome).join('\n')">+{{ reasons(plan.outcome).length - 1 }}</span>
        <StepStatus :status="plan.status" class="shrink-0 opacity-50" />
        <span class="shrink-0 tabular-nums opacity-50">{{ fmtRuntime(planRuntime) }}</span>
        <!-- Copy just this section (the plan text). -->
        <button type="button" @click="copy(plan.response, 'plan')"
          :title="copiedKey === 'plan' ? 'Copied' : 'Copy plan'"
          class="grid place-items-center w-6 h-6 rounded-full text-muted transition hover:text-amber-400
                 hover:bg-amber-400/10 active:scale-90 cursor-pointer">
          <component :is="copiedKey === 'plan' ? CheckIcon : ClipboardDocumentIcon" class="w-4 h-4" />
        </button>
        <!-- Replay = RESTART (rebuild from existing planner output → run step 0). Always available
             (it's how you recover a stuck run); gated only by an in-flight click. -->
        <button v-if="hasPlanner" type="button" @click="runRebuild()" :disabled="busy"
          :title="planReady ? 'Replay — rebuild + run step 0' : 'Build plan + run step 0'"
          class="grid place-items-center w-6 h-6 rounded-full text-muted transition hover:text-amber-400
                 hover:bg-amber-400/10 active:scale-90 cursor-pointer disabled:opacity-40
                 disabled:cursor-not-allowed disabled:hover:bg-transparent">
          <PlayIcon class="w-4 h-4" :class="busy && 'opacity-50'" />
        </button>
      </div>
      <div v-show="planOpen" class="px-3 pb-3">
        <pre class="text-xs whitespace-pre-wrap break-words font-mono text-muted opacity-80">{{ plan.response || '…' }}</pre>
        <div v-if="plan.outcome" class="mt-2 text-xs text-error font-mono whitespace-pre-wrap break-words">{{ plan.outcome }}</div>
      </div>
    </div>

    <!-- Executed steps, in run order. Each is collapsible. "thinking" (not in the final output)
         is dimmed and auto-collapses once done; "output" stays open and emphasized. Each step's ▷
         runs the NEXT step (this step's output as input); the last step shows a stop square. -->
    <template v-for="s in executed" :key="s.index">
    <!-- The INPUT that produced the response below. ABOVE its own step, because a prompt rendered
         AFTER its step sits directly above the NEXT step's card and reads as that step's input —
         step 2's prompt was pasted as step 3's. Input then output, and every block names its own
         step so position can't be misread. Holds the prompt AS SENT: instructions, Pass/Fail and
         the status contract, variables already resolved (worker index.js writes `prompt` as the
         joined messages). Collapsed by default — 10-50k chars would bury the run.

         ONE BLOCK PER UNIT, never the joined string. A fanned step is N separate calls that each
         carry the same system preamble, so concatenating them reads as one document that repeats
         itself. Labelled `<kind> i/n` so the boundary is visible. -->
    <div v-for="(u, ui) in (s.units || [])" :key="`p-${u.id}`" v-show="u.prompt"
      class="rounded px-3 py-2 border-divider bg-black/5 dark:bg-white/5">
      <div class="flex items-center gap-2 text-xs text-muted">
        <button type="button" @click="togglePrompt(`${s.index}-${ui}`)" class="flex items-center gap-1.5 shrink-0 text-left">
          <ChevronRightIcon class="w-3.5 h-3.5 shrink-0 transition-transform" :class="promptOpen(`${s.index}-${ui}`) ? 'rotate-90' : ''" />
          <span class="truncate max-w-[16rem]">prompt sent · step {{ s.index }} · {{ s.subtype }}</span>
        </button>
        <span v-if="(s.units || []).length > 1" class="shrink-0 tabular-nums opacity-70">
          {{ s.kind || 'unit' }} {{ ui + 1 }}/{{ s.units.length }}
        </span>
        <span class="ml-auto shrink-0 tabular-nums opacity-70">{{ (u.prompt || '').length.toLocaleString() }} chars</span>
        <button type="button" @click="copy(u.prompt, `prompt-${s.index}-${ui}`)"
          :title="copiedKey === `prompt-${s.index}-${ui}` ? 'Copied' : 'Copy this prompt'"
          class="grid place-items-center w-6 h-6 rounded-full text-muted transition hover:text-amber-400
                 hover:bg-amber-400/10 active:scale-90 cursor-pointer">
          <component :is="copiedKey === `prompt-${s.index}-${ui}` ? CheckIcon : ClipboardDocumentIcon" class="w-4 h-4" />
        </button>
      </div>
      <!-- No card, no indent, no scroller: the step cards ARE the containers on this page, and every
           other block expands into the page's own scroll. Full opacity when open — this is read
           closely, and the dimmed treatment used for collapsed scaffolding makes it unreadable. -->
      <pre v-show="promptOpen(`${s.index}-${ui}`)"
        class="mt-1 text-xs whitespace-pre-wrap break-words font-mono"
        :class="isDark ? 'text-gray-100' : 'text-gray-900'"
      >{{ u.prompt }}</pre>
    </div>

    <!-- The model's WORKING, between the prompt that produced it and the deliverable it produced.
         splitOutcome strips this out of the response before storing, so without this block it is
         written and never seen — and it is the only record of HOW a row was decided, which is how
         we found the model landing on the wrong pool entry at all.
         Same treatment as the prompt above: per unit, collapsed by default, no card and no scroller,
         because the step cards ARE the containers on this page. -->
    <div v-for="(u, ui) in (s.units || [])" :key="`t-${u.id}`" v-show="u.thinking"
      class="rounded px-3 py-2 border-divider bg-black/5 dark:bg-white/5">
      <div class="flex items-center gap-2 text-xs text-muted">
        <button type="button" @click="toggleThinking(`${s.index}-${ui}`)" class="flex items-center gap-1.5 shrink-0 text-left">
          <ChevronRightIcon class="w-3.5 h-3.5 shrink-0 transition-transform" :class="thinkingOpen(`${s.index}-${ui}`) ? 'rotate-90' : ''" />
          <span class="truncate max-w-[16rem]">working · step {{ s.index }} · {{ s.subtype }}</span>
        </button>
        <span v-if="(s.units || []).length > 1" class="shrink-0 tabular-nums opacity-70">
          {{ s.kind || 'unit' }} {{ ui + 1 }}/{{ s.units.length }}
        </span>
        <span class="ml-auto shrink-0 tabular-nums opacity-70">{{ (u.thinking || '').length.toLocaleString() }} chars</span>
        <button type="button" @click="copy(u.thinking, `thinking-${s.index}-${ui}`)"
          :title="copiedKey === `thinking-${s.index}-${ui}` ? 'Copied' : 'Copy this working'"
          class="grid place-items-center w-6 h-6 rounded-full text-muted transition hover:text-amber-400
                 hover:bg-amber-400/10 active:scale-90 cursor-pointer">
          <component :is="copiedKey === `thinking-${s.index}-${ui}` ? CheckIcon : ClipboardDocumentIcon" class="w-4 h-4" />
        </button>
      </div>
      <pre v-show="thinkingOpen(`${s.index}-${ui}`)"
        class="mt-1 text-xs whitespace-pre-wrap break-words font-mono"
        :class="isDark ? 'text-gray-100' : 'text-gray-900'"
      >{{ u.thinking }}</pre>
    </div>

    <div
      class="rounded px-3 py-2"
      :class="s.displayAs === 'output' ? 'glass' : 'border-divider bg-black/5 dark:bg-white/5 opacity-60'"
    >
      <!-- Same row layout as the Plan header above — identical text size, chevron, and control. -->
      <div
        class="flex items-center gap-2 text-xs mb-1"
        :class="s.displayAs === 'output' ? 'text-amber-400/70' : 'text-muted'"
      >
        <button type="button" @click="toggleStep(s)" class="flex items-center gap-1.5 shrink-0 text-left">
          <ChevronRightIcon class="w-3.5 h-3.5 shrink-0 transition-transform" :class="stepOpen(s) ? 'rotate-90' : ''" />
          <span class="font-medium truncate max-w-[14rem]">step {{ s.index }} · {{ s.subtype }}</span>
        </button>
        <!-- Same right-side columns as the Plan header: failure · status · time · actions. Failure is
             right-anchored via ml-auto, showing only the FIRST reason (truncates when too long) with a
             +N count when more piled up. Full list is on hover (title) — the body stays clean. -->
        <span class="ml-auto min-w-0 truncate text-error" :title="reasons(s.outcome).join('\n')">{{ firstReason(s.outcome) }}</span>
        <span v-if="reasons(s.outcome).length > 1" class="shrink-0 tabular-nums text-error opacity-70" :title="reasons(s.outcome).join('\n')">+{{ reasons(s.outcome).length - 1 }}</span>
        <StepStatus :status="s.status" class="shrink-0" />
        <span class="shrink-0 tabular-nums opacity-70">{{ fmtRuntime(stepTime(s)) }}</span>
        <!-- Copy just this step's output. -->
        <button type="button" @click="copy(s.response, `step-${s.index}`)"
          :title="copiedKey === `step-${s.index}` ? 'Copied' : 'Copy this step'"
          class="grid place-items-center w-6 h-6 rounded-full text-muted transition hover:text-amber-400
                 hover:bg-amber-400/10 active:scale-90 cursor-pointer">
          <component :is="copiedKey === `step-${s.index}` ? CheckIcon : ClipboardDocumentIcon" class="w-4 h-4" />
        </button>
        <!-- DEBUG re-run of THIS step, in isolation (testing only — NOT the orchestrator flow;
             it won't advance the plan). The last plan step shows an inert red stop square to mark
             the end of the sequence. Disabled while this step is still streaming. -->
        <span v-if="isLastStep(s)"
          class="grid place-items-center w-6 h-6 text-error" title="End of sequence — last step">
          <StopIcon class="w-4 h-4" />
        </span>
        <button v-else type="button" @click="runStep(s.index + 1)" :disabled="busy || s.status === 'running'"
          :title="s.status === 'running' ? 'Step is running…' : `Run the next step (step ${s.index + 1}) — clears it + later steps; debug, no cascade`"
          class="grid place-items-center w-6 h-6 rounded-full text-muted transition hover:text-amber-400
                 hover:bg-amber-400/10 active:scale-90 cursor-pointer disabled:opacity-40
                 disabled:cursor-not-allowed disabled:hover:bg-transparent">
          <PlayIcon class="w-4 h-4" :class="busy && 'opacity-50'" />
        </button>
      </div>
      <pre
        v-show="stepOpen(s)"
        class="text-xs whitespace-pre-wrap break-words font-mono"
        :class="s.displayAs === 'output' ? '' : 'text-muted opacity-80'"
      >{{ s.response || '…' }}</pre>
    </div>

    </template>

    <!-- A step that failed BEFORE it dispatched has NO run doc, so it gets no card above and the
         reason is invisible — the job just stops with nothing to look at. That happens whenever
         dispatch rejects the upstream table (dispatch.js writes status/outcome on the JOB and
         returns without publishing a unit). Surface it where the missing step would have been. -->
    <div v-if="failedBeforeDispatch" class="rounded px-3 py-2 mt-1 glass border border-error/40">
      <div class="flex items-center gap-2 text-xs text-error">
        <span class="font-medium">step {{ failedStepIndex }}<template v-if="failedStepSubtype"> · {{ failedStepSubtype }}</template></span>
        <!-- The job's own status, not an interpretation of it. This card exists because the step
             has no run doc to carry one; inventing a phrase here would put words in the engine's
             mouth. The reason itself is job.outcome, printed verbatim below. -->
        <StepStatus :status="job.status" class="ml-auto shrink-0" />
        <button type="button" @click="copy(job.outcome, 'job-outcome')"
          :title="copiedKey === 'job-outcome' ? 'Copied' : 'Copy the failure'"
          class="grid place-items-center w-6 h-6 rounded-full transition hover:bg-error/10 active:scale-90 cursor-pointer">
          <component :is="copiedKey === 'job-outcome' ? CheckIcon : ClipboardDocumentIcon" class="w-4 h-4" />
        </button>
      </div>
      <pre class="mt-2 text-xs whitespace-pre-wrap break-words font-mono text-error">{{ job.outcome }}</pre>
    </div>

    <!-- Old one-shot jobs that streamed straight onto the job doc (no plan step). Also the empty
         state before anything runs. Hidden once steps execute (e.g. a composed plan has no planner
         run but does have step cards). -->
    <div v-if="!plan && !executed.length">
      <div v-if="job?.response" class="p-3 rounded text-xs whitespace-pre-wrap break-words font-mono overflow-auto glass">{{ job.response }}</div>
      <div v-else class="text-muted text-sm">{{ jobStatus === 'pending' ? 'Waiting for the planner…' : 'No output yet.' }}</div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import { ChevronRightIcon, PlayIcon, ClipboardDocumentIcon, CheckIcon } from '@heroicons/vue/24/outline'
import { StopIcon } from '@heroicons/vue/24/solid'
import { useJob } from '~/composables/useJob'

const props = defineProps({ jobId: { type: String, default: '' } })

const { job, plan, output, investigating, jobStatus, runtimeOf, bind } = useJob()

// Executed steps (those with a run), in plan order — one collapsible card each.
const executed = computed(() =>
  [...investigating.value, ...output.value].sort((a, b) => a.index - b.index)
)

const { isDark } = useTheme()

// Steps whose prompt reached the worker. A step that failed BEFORE dispatch has no run doc and so
// no prompt — it simply doesn't get a card here.
const withPrompts = computed(() => executed.value.filter((s) => s.prompt))

// The job failed at a step that produced NO RUN — the reason lives only on the job doc's `outcome`,
// so without this the UI shows a stopped job and no explanation anywhere.
//
// Do NOT gate this on `cursor`. A step can fail while DISPATCHING the NEXT one: rowItems rejects a
// malformed upstream row, dispatch.js writes status:"fail" + outcome and returns WITHOUT advancing,
// so `cursor` still points at the last step that ran. Measured on job 6be54418: cursor=3, outcome
// "step 4: step 3 unit 0: row … has 9 cell(s) — cannot fan out over its rows". Step 3 HAS runs, so
// a cursor-based guard hid the only explanation the user had — a bare "Fail" with nothing beside it.
// The rule is simply: the job failed, there is an outcome, and no step card is already showing it.
const failedBeforeDispatch = computed(() =>
  job.value?.status === 'fail' &&
  !!job.value?.outcome &&
  !executed.value.some((s) => s.outcome && String(s.outcome).includes(String(job.value.outcome)))
)
// WHICH step failed — read it from the outcome, not from `cursor`. dispatch.js prefixes the reason
// with "step N: " and does NOT advance the cursor when it rejects the next step's inputs, so cursor
// names the last step that RAN, not the one that failed. Labelling this card "step 3" for a "step 4:"
// outcome sent the reader to the wrong step. Fall back to cursor only when the outcome has no prefix.
const failedStepIndex = computed(() => {
  const m = String(job.value?.outcome || '').match(/^step (\d+):/)
  return m ? Number(m[1]) : job.value?.cursor
})
const failedStepSubtype = computed(() => job.value?.plan?.[failedStepIndex.value]?.subtype || '')

// Prompt-as-sent disclosure, per step index. Closed by default — see the template comment.
const promptOpenSet = reactive({})
const promptOpen = (i) => !!promptOpenSet[i]
const togglePrompt = (i) => { promptOpenSet[i] = !promptOpenSet[i] }

// The model's own working, stripped out of the deliverable before it was stored (worker
// steps/outcome.js splitOutcome). Collapsed by default and keyed per unit, exactly like the prompt
// above it — it is scaffolding, not output, and a fanned step has one per call.
const thinkingOpenSet = reactive({})
const thinkingOpen = (i) => !!thinkingOpenSet[i]
const toggleThinking = (i) => { thinkingOpenSet[i] = !thinkingOpenSet[i] }

// Copy to clipboard with a brief per-button "Copied" tick (keyed so only the clicked one flips).
const copiedKey = ref('')
let copyTimer = null
async function copy(text, key) {
  try {
    await navigator.clipboard.writeText(text || '')
    copiedKey.value = key
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copiedKey.value = '' }, 1200)
  } catch (e) {
    console.error('[ui/job] copy failed:', e)
  }
}
// Copy-all: Plan + every executed step, each under a heading, in run order.
const fullText = () => {
  const parts = []
  if (plan.value?.response) parts.push(`# Plan\n${plan.value.response}`)
  for (const s of executed.value) parts.push(`# step ${s.index} · ${s.subtype}\n${s.response || ''}`)
  return parts.join('\n\n')
}

// A step row's ▷ runs the NEXT step, so the LAST plan step has no next — it ends the sequence
// (an inert red stop square instead of a button).
const totalSteps = computed(() =>
  job.value?.stepCount || (Array.isArray(job.value?.plan) ? job.value.plan.length : executed.value.length)
)
const isLastStep = (s) => s.index >= totalSteps.value - 1

// A step's `outcome` is a "; "-joined accumulation of every failure reason. The header row shows
// only the FIRST reason, hard-capped so it can never run long; the expanded body lists them all.
const reasons = (o) => String(o || '').split(/;\s*/).map((r) => r.trim()).filter(Boolean)
const firstReason = (o) => {
  const first = reasons(o)[0] || ''
  return first.length > 80 ? first.slice(0, 79) + '…' : first
}

// Runtime label: seconds under a minute, else "Xm Ys". '' when unknown.
const fmtRuntime = (secs) => {
  if (secs == null) return ''
  if (secs < 60) return `${secs.toFixed(1)}s`
  return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`
}
// Live clock so a RUNNING step/plan shows elapsed time (now − createdAt) instead of blank; a
// finished one uses its recorded runtime (updatedAt − createdAt). Ticks once a second.
const now = ref(Date.now())
const ticker = setInterval(() => { now.value = Date.now() }, 1000)
onUnmounted(() => clearInterval(ticker))
const elapsed = (run, recorded) =>
  (run?.status === 'running' && run?.createdAt?.toMillis)
    ? Math.max(0, (now.value - run.createdAt.toMillis()) / 1000)
    : recorded
const stepTime = (s) => elapsed(s.run && { ...s.run, status: s.status }, s.runtime)
const planRuntime = computed(() => elapsed(plan.value, runtimeOf(plan.value)))

// Plan block expand: open while the planner works, auto-collapse once built.
const manualPlan = ref(undefined)
const planOpen = computed(() =>
  manualPlan.value !== undefined ? manualPlan.value : (plan.value?.status === 'running' || plan.value?.status === 'pending')
)
const togglePlan = () => { manualPlan.value = !planOpen.value }

// Per-step expand. Default: "thinking" steps auto-collapse once done (they're scaffolding);
// "output" steps stay open. Manual toggle overrides, per step.
const manualStep = reactive({})
const isDone = (s) => s.status === 'success' || s.status === 'fail'
const stepOpen = (s) =>
  s.index in manualStep ? manualStep[s.index] : (s.displayAs === 'output' ? true : !isDone(s))
const toggleStep = (s) => { manualStep[s.index] = !stepOpen(s) }

// ---- Run controls → backend /ai/resume/* + /ai/rebuild (server hard-deletes the right range,
// then dispatches). Client never deletes; only `jobId` is sent. ----
const cfg = useRuntimeConfig().public
const { env } = useEnvironment()
const aiBase = computed(() => String(env.value === 'production' ? cfg.aiBaseUrl : cfg.aiBaseUrlLocal).replace(/\/$/, ''))
const { getToken } = useAuth()
const authHdr = async () => ({ Authorization: `Bearer ${await getToken()}` })

const planReady = computed(() => Array.isArray(job.value?.plan) && job.value.plan.length > 0)
const hasPlanner = computed(() => !!plan.value)

const busy = ref(false)
async function call(path) {
  if (busy.value) return
  busy.value = true
  try {
    await $fetch(`${aiBase.value}/${path}`, { method: 'POST', timeout: 15000, body: { jobId: props.jobId }, headers: await authHdr() })
  } catch (e) {
    console.error(`[ui/job] ${path} failed:`, e)
  } finally {
    busy.value = false
  }
}
// DEBUG: RESTART from THIS step (POST /ai/run/{index}). Server wipes the now-stale runs AFTER this
// step, then re-runs this one with report:null — the worker writes it but never pings the
// orchestrator → no auto-advance, no cascade. A testing primitive, separate from the orchestrator's
// automatic flow: it does NOT drive the plan forward. (The orchestrator auto-runs on a job start / Plan ▷.)
const runStep = (index) => call(`run/${index}`)

async function runRebuild() {
  if (busy.value) return
  busy.value = true
  try {
    await $fetch(`${aiBase.value}/rebuild`, { method: 'POST', timeout: 15000, body: { jobId: props.jobId }, headers: await authHdr() })
  } catch (e) {
    console.error('[ui/job] rebuild failed:', e)
  } finally {
    busy.value = false
  }
}

watch(() => props.jobId, (id) => bind(id), { immediate: false })
onMounted(() => bind(props.jobId))
</script>
