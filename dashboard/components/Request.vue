<template>
  <div class="flex gap-4 h-screen">
    <!-- Left Panel: Request History -->
    <div class="w-64 panel backdrop-blur-md p-4 overflow-y-auto flex flex-col min-h-0" @scroll.passive="onHistoryScroll">
      <!-- New request + the plan/not-plan filter share ONE row — the filter gets no row of its own. -->
      <div class="mb-3 flex items-center gap-1.5">
        <button
          type="button"
          @click="newRequest"
          class="flex-1 min-w-0 px-2 py-2 rounded bg-amber-500 text-gray-900 hover:bg-amber-600 text-sm font-medium truncate"
        >
          + New request
        </button>
        <button
          v-for="k in KIND_FILTERS"
          :key="k.key"
          type="button"
          :title="k.title"
          @click="kindFilter = k.key"
          class="shrink-0 px-1.5 h-8 rounded text-[10px] leading-none text-muted hover:text-primary transition"
          :class="kindFilter === k.key ? 'bg-amber-500/20 ring-1 ring-amber-500 text-primary' : 'hover:bg-amber-500/10'"
        >{{ k.label }}</button>
      </div>
      <div class="space-y-2">
        <div v-if="shownRequests.length === 0" class="text-muted text-xs text-center py-4">
          {{ activeRequests.length ? 'None match' : 'No requests' }}
        </div>
        <div
          v-for="req in shownRequests"
          :key="req.jobId"
          @click="selectRequest(req.jobId)"
          :class="[
            'group relative p-2 rounded-lg cursor-pointer transition text-xs',
            selectedRequestId === req.jobId
              ? 'bg-amber-500/20 border border-amber-500'
              : 'hover:bg-amber-500/10 border border-transparent'
          ]"
        >
          <!-- Line 1: title + delete -->
          <div class="flex items-center gap-1">
            <div class="flex-1 min-w-0 truncate text-gray-400">{{ req.userPrompt || req.type }}</div>
            <button
              type="button"
              @click.stop="deleteRequest(req.jobId)"
              title="Delete"
              class="shrink-0 w-5 h-5 rounded flex items-center justify-center text-muted opacity-0 group-hover:opacity-100 hover:bg-error/20 hover:text-error active:scale-90 transition"
            >×</button>
          </div>
          <!-- Line 2: date -->
          <div class="text-[11px] text-muted mt-0.5">{{ fmtDate(req.createdAt) }}</div>
          <!-- Line 3: copy · id (grows) · status (far right) — copy kept LEFT, never between id and status -->
          <div class="mt-0.5 flex items-center gap-1.5">
            <button
              type="button"
              @click.stop="copy(req.jobId, 'Job ID copied')"
              title="Copy job ID"
              class="shrink-0 w-4 h-4 rounded flex items-center justify-center text-muted hover:text-amber-400 active:scale-90 transition"
            ><ClipboardDocumentIcon class="w-3.5 h-3.5" /></button>
            <span class="font-mono text-gray-50 flex-1 min-w-0">{{ req.jobId.slice(0, 8) }}</span>
            <span class="capitalize flex items-center gap-1 shrink-0"
              :class="statusFor(req) === 'success' ? 'text-success' : statusFor(req) === 'fail' ? 'text-error' : statusFor(req) === 'running' ? 'text-primary' : 'text-muted'">
              <span v-if="statusFor(req) === 'running'" class="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
              {{ statusFor(req) }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Right Panel: Settings + Query/Results -->
    <div class="flex-1 min-w-0 panel overflow-clip flex flex-col min-h-0">
      <!-- Settings Row: Company & User -->
      <div class="border-b border-divider p-4 flex gap-3">
        <!-- Company -->
        <div class="flex-1 min-w-40">
          <Listbox v-model="selectedCompanyId">
            <div class="relative">
              <ListboxButton class="w-full form-input border-0 text-left text-sm flex items-center justify-between">
                <span>{{ selectedCompany?.name || 'Company' }}</span>
                <span class="text-xs opacity-60">▼</span>
              </ListboxButton>
              <ListboxOptions :class="[
                'absolute z-50 w-full mt-1 rounded-lg p-2 space-y-1 border shadow-xl',
                isDark ? 'bg-gray-950 border-gray-700/60' : 'bg-white border-gray-300'
              ]">
                <ListboxOption v-for="c in companies" :key="c._id" :value="c._id" :class="[
                  'px-3 py-2 rounded cursor-pointer text-sm',
                  isDark ? 'hover:bg-amber-500/20' : 'hover:bg-gray-100'
                ]">
                  {{ c.name }}
                </ListboxOption>
                <div :class="['border-t pt-1 mt-1', isDark ? 'border-amber-500/10' : 'border-gray-200']">
                  <button type="button" @click="showCreateCompany = true" :class="[
                    'w-full text-left px-3 py-2 rounded text-xs',
                    isDark ? 'text-amber-500 hover:bg-amber-500/20' : 'text-amber-600 hover:bg-gray-100'
                  ]">
                    + Add
                  </button>
                </div>
              </ListboxOptions>
            </div>
          </Listbox>
        </div>

        <!-- User -->
        <div class="flex-1 min-w-40">
          <Listbox v-model="selectedUserId" :disabled="!selectedCompanyId">
            <div class="relative">
              <ListboxButton :class="['w-full form-input text-left text-sm flex items-center justify-between', !selectedCompanyId && 'opacity-50 cursor-not-allowed']">
                <span>{{ selectedUser?.name || selectedUser?.username || 'User' }}</span>
                <span class="text-xs opacity-60">▼</span>
              </ListboxButton>
              <ListboxOptions v-if="selectedCompanyId" :class="[
                'absolute z-50 w-full mt-1 rounded-lg p-2 space-y-1 border',
                isDark ? 'bg-gray-950 border-gray-700/60' : 'bg-white border-gray-300'
              ]">
                <ListboxOption v-for="u in filteredUsers" :key="u.uid" :value="u.uid" :class="[
                  'px-3 py-2 rounded cursor-pointer text-sm',
                  isDark ? 'hover:bg-amber-500/20' : 'hover:bg-gray-100'
                ]">
                  {{ u.name || u.username || `User ${u.uid?.slice(0, 6)}` }}{{ u.role ? ` (${u.role})` : '' }}
                </ListboxOption>
                <div :class="['border-t pt-1 mt-1', isDark ? 'border-amber-500/10' : 'border-gray-200']">
                  <button @click="showCreateUser = true" :class="[
                    'w-full text-left px-3 py-2 rounded text-xs',
                    isDark ? 'text-amber-500 hover:bg-amber-500/20' : 'text-amber-600 hover:bg-gray-100'
                  ]">
                    + Add
                  </button>
                </div>
              </ListboxOptions>
            </div>
          </Listbox>
        </div>
      </div>

      <!-- Tab Headers with Model -->
      <div class="flex px-4 items-center justify-between">
        <div class="flex relative">
          <!-- Sliding Underline -->
          <div
            class="absolute bottom-0 h-0.5 bg-amber-500 transition-all duration-300"
            :style="{
              left: underlineLeft + 'px',
              width: underlineWidth + 'px'
            }"
          />

          <button
            ref="requestBtn"
            @click="activeTab = 'request'"
            :class="[
              'px-4 py-2 text-sm font-medium transition-colors duration-300 relative z-10',
              activeTab === 'request' ? 'text-primary' : 'text-secondary hover:text-primary'
            ]"
          >
            Request
          </button>
          <button
            ref="resultsBtn"
            @click="activeTab = 'results'"
            :class="[
              'px-4 py-2 text-sm font-medium transition-colors duration-300 relative z-10',
              activeTab === 'results'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-gray-600 hover:text-gray-700 dark:text-gray-300 dark:hover:text-gray-200'
            ]"
          >
            Results
            <span
              v-if="selectedRequestId && liveStatus === 'running'"
              class="ml-1.5 inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse align-middle"
              title="Running…"
            ></span>
          </button>
          <button
            ref="messageBtn"
            @click="activeTab = 'message'"
            :class="[
              'px-4 py-2 text-sm font-medium transition-colors duration-300 relative z-10',
              activeTab === 'message'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-gray-600 hover:text-gray-700 dark:text-gray-300 dark:hover:text-gray-200'
            ]"
          >
            Message
          </button>
          <button
            ref="promptBtn"
            @click="activeTab = 'prompt'"
            :class="[
              'px-4 py-2 text-sm font-medium transition-colors duration-300 relative z-10',
              activeTab === 'prompt'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-gray-600 hover:text-gray-700 dark:text-gray-300 dark:hover:text-gray-200'
            ]"
          >
            Prompt
          </button>
        </div>

        <!-- Model -->
        <div class="w-48">
          <Listbox v-model="selectedModel">
            <div class="relative">
              <ListboxButton class="w-full form-input border-0 text-left text-sm flex items-center justify-between">
                <span class="truncate">{{ selectedModelLabel }}</span>
                <span class="text-xs opacity-60">▼</span>
              </ListboxButton>
              <ListboxOptions class="absolute z-50 w-full mt-1 rounded-lg p-2 space-y-1 bg-white border border-gray-200 dark:bg-gray-950 dark:border-gray-700/60 shadow-xl">
                <ListboxOption
                  v-for="m in models"
                  :key="m.value"
                  :value="m.value"
                  :class="[
                    'px-3 py-2 rounded cursor-pointer text-sm',
                    isDark ? 'hover:bg-amber-500/20' : 'hover:bg-gray-100'
                  ]"
                >{{ m.label }}</ListboxOption>
              </ListboxOptions>
            </div>
          </Listbox>
        </div>

        <!-- Message type (shared list — same source as the prompt editor) -->
        <div class="w-40">
          <Listbox v-model="selectedType">
            <div class="relative">
              <ListboxButton class="w-full form-input border-0 text-left text-sm flex items-center justify-between">
                <span class="truncate">{{ selectedType || 'Type' }}</span>
                <span class="text-xs opacity-60">▼</span>
              </ListboxButton>
              <ListboxOptions class="absolute z-50 w-full mt-1 rounded-lg p-2 space-y-1 bg-white border border-gray-200 dark:bg-gray-950 dark:border-gray-700/60 shadow-xl">
                <ListboxOption
                  v-for="t in messageTypes"
                  :key="t"
                  :value="t"
                  :class="['px-3 py-2 rounded cursor-pointer text-sm', isDark ? 'hover:bg-amber-500/20' : 'hover:bg-gray-100']"
                >{{ t }}</ListboxOption>
              </ListboxOptions>
            </div>
          </Listbox>
        </div>
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-auto p-4 min-h-0">
        <!-- Request Tab — always-editable compose box; prefilled when a request is selected -->
        <div v-show="activeTab === 'request'" class="h-full flex flex-col">
          <textarea
            v-model="userPrompt"
            @keydown="handleQueryKeydown"
            placeholder="What would you like to ask?"
            class="h-full form-input text-sm font-mono resize-y overflow-y-auto overflow-x-hidden transition-none"
          />
        </div>

        <!-- Prompt Tab — ONLY the ASSEMBLED prompt the worker sent to the model (system +
             tools + subtypes + request), per planner job then each step→unit. This is the
             model INPUT only — the response/output is NOT shown here (see the Results tab). -->
        <div v-show="activeTab === 'prompt'" class="h-full flex flex-col">
          <div v-if="!selectedRequestId" class="text-gray-400 dark:text-gray-500 text-sm text-center flex items-center justify-center h-full">
            Select a request to view the prompt
          </div>
          <div v-else class="overflow-auto flex-1 space-y-3">
            <div v-for="m in messageLog" :key="m.id" class="rounded glass overflow-hidden">
              <div class="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-white/10">
                <span class="text-[11px] font-mono text-amber-400 truncate" :title="m.id">
                  <span class="uppercase text-gray-500 mr-1">{{ m.kind }}</span>{{ m.id }}
                </span>
                <span class="text-[11px] font-mono shrink-0" :class="m.status === 'success' ? 'text-green-400' : m.status === 'fail' ? 'text-red-400' : 'text-gray-400'">{{ m.status }}</span>
              </div>
              <div class="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-500">{{ m.label }} — prompt sent</div>
              <CollapsibleSections :text="m.prompt" :class="['px-3 pb-2', isDark ? 'text-gray-100' : 'text-gray-900']" />
            </div>
          </div>
        </div>

        <!-- Message Tab — the REQUEST that was published to each worker: the planner's user
             prompt, then each step→unit's instructions. (The full assembled prompt the model
             received is shown in the Prompt tab.) -->
        <div v-show="activeTab === 'message'" class="h-full flex flex-col">
          <div v-if="!selectedRequestId" class="text-gray-400 dark:text-gray-500 text-sm text-center flex items-center justify-center h-full">
            Select a request to view messages
          </div>
          <div v-else class="overflow-auto flex-1 space-y-3">
            <div v-for="m in messageLog" :key="m.id" class="rounded glass overflow-hidden">
              <div class="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-white/10">
                <span class="text-[11px] font-mono text-amber-400 truncate" :title="m.id">
                  <span class="uppercase text-gray-500 mr-1">{{ m.kind }}</span>{{ m.id }}
                </span>
                <span class="text-[11px] font-mono shrink-0" :class="m.status === 'success' ? 'text-green-400' : m.status === 'fail' ? 'text-red-400' : 'text-gray-400'">{{ m.status }}</span>
              </div>
              <div class="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-500">{{ m.label }} — message sent</div>
              <CollapsibleSections :text="m.message" :class="['px-3 pb-2', isDark ? 'text-gray-100' : 'text-gray-900']" />
            </div>
          </div>
        </div>

        <!-- Results Tab -->
        <div v-show="activeTab === 'results'" class="min-h-full flex flex-col">
          <div v-if="!selectedRequestId" class="text-gray-400 dark:text-gray-500 text-sm text-center flex items-center justify-center h-full">
            Select a request to view results
          </div>
          <!-- Grows to content; the outer content wrapper (overflow-auto) does the scrolling,
               so the Plan opens to full height instead of into a nested inner scroll box. -->
          <JobResults v-else :jobId="selectedRequestId" />
        </div>
      </div>

    </div>
  </div>

  <!-- Floating Submit Button (Fixed) -->
  <button
    @click="submitRequest"
    :disabled="!canSubmit"
    class="fixed bottom-6 right-6 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-gray-900 font-bold p-4 rounded-full transition focus:outline-none focus:ring-2 focus:ring-amber-500 shadow-lg z-50"
    title="Submit query (Shift+Enter)"
  >
    <PaperAirplaneIcon class="w-6 h-6" />
  </button>

  <!-- Create Company modal -->
  <Teleport to="body">
    <div v-if="showCreateCompany" class="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]" @click.self="showCreateCompany = false">
      <div class="w-full max-w-sm mx-4 rounded-lg p-5 bg-white dark:bg-gray-900 border border-amber-500/30">
        <h2 class="text-lg font-serif text-primary mb-3">New Company</h2>
        <input
          v-model="newCompanyName"
          type="text"
          placeholder="Company name"
          class="w-full px-3 py-2 rounded bg-gray-100 text-gray-900 border border-gray-300 dark:bg-gray-800 dark:text-white dark:border-gray-700 focus:border-amber-500 focus:outline-none text-sm"
          @keyup.enter="createCompany"
        />
        <div class="flex gap-2 justify-end mt-4">
          <button type="button" @click="showCreateCompany = false" class="px-3 py-1.5 rounded btn-muted text-sm">Cancel</button>
          <button type="button" @click="createCompany" :disabled="!newCompanyName.trim()" class="px-3 py-1.5 rounded bg-amber-500 text-gray-900 hover:bg-amber-600 text-sm font-medium disabled:opacity-50">Create</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- Create User modal -->
  <Teleport to="body">
    <div v-if="showCreateUser" class="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]" @click.self="showCreateUser = false">
      <div class="w-full max-w-sm mx-4 rounded-lg p-5 bg-white dark:bg-gray-900 border border-amber-500/30">
        <h2 class="text-lg font-serif text-primary mb-1">New User</h2>
        <p class="text-xs text-gray-400 mb-3">In {{ selectedCompany?.name || 'selected company' }}</p>
        <input
          v-model="newUsername"
          type="text"
          placeholder="Username"
          class="w-full px-3 py-2 rounded bg-gray-100 text-gray-900 border border-gray-300 dark:bg-gray-800 dark:text-white dark:border-gray-700 focus:border-amber-500 focus:outline-none text-sm mb-2"
          @keyup.enter="createUser"
        />
        <select v-model="newUserRole" class="w-full px-3 py-2 rounded bg-gray-100 text-gray-900 border border-gray-300 dark:bg-gray-800 dark:text-white dark:border-gray-700 focus:border-amber-500 focus:outline-none text-sm">
          <option value="chef">chef</option>
          <option value="rdn">rdn</option>
          <option value="admin">admin</option>
        </select>
        <div class="flex gap-2 justify-end mt-4">
          <button type="button" @click="showCreateUser = false" class="px-3 py-1.5 rounded btn-muted text-sm">Cancel</button>
          <button type="button" @click="createUser" :disabled="!newUsername.trim()" class="px-3 py-1.5 rounded bg-amber-500 text-gray-900 hover:bg-amber-600 text-sm font-medium disabled:opacity-50">Create</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { Listbox, ListboxLabel, ListboxButton, ListboxOptions, ListboxOption } from '@headlessui/vue'
import { PaperAirplaneIcon } from '@heroicons/vue/20/solid'
import { ClipboardDocumentIcon } from '@heroicons/vue/24/outline'
import { collection, query, orderBy, limit, onSnapshot, doc } from 'firebase/firestore'
import { getDb } from '~/lib/firebase'

const { success, error: showError } = useToast()
const { copy } = useClipboard()
const { isDark } = useTheme()

const companies = ref([])
const users = ref([])
const selectedCompanyId = ref('')
const selectedUserId = ref('')
const { env: currentEnv } = useEnvironment()
const models = ref([])
const selectedModel = ref('openclaw_gemma4_12b_v1')
const selectedModelLabel = computed(
  () => models.value.find((m) => m.value === selectedModel.value)?.label || selectedModel.value
)
const messageTypes = ref([])           // shared list from /api/llm/types (no duplicate)
const selectedType = ref('query')
const userPrompt = ref('')
const loading = ref(false)
const showCreateCompany = ref(false)
const showCreateUser = ref(false)

const activeRequests = ref([])

// Plan / not-plan filter. Meal-plan builds, task lists and one-off requests all live in the SAME
// llmResults collection; the job doc's own `type` is the discriminator ("menu" = a meal-plan build,
// written by /ai/menu). `jobType` is that raw field — deliberately NOT `type`, which the local
// optimistic record overrides with the UI's Type selection.
const KIND_FILTERS = [
  { key: 'all',   label: 'All',   title: 'All requests' },
  { key: 'plan',  label: 'Plan',  title: 'Meal plan builds only' },
  { key: 'other', label: 'Other', title: 'Everything except meal plan builds' },
]
const kindFilter = ref('all')
const shownRequests = computed(() => (
  kindFilter.value === 'all'
    ? activeRequests.value
    : activeRequests.value.filter((r) => (kindFilter.value === 'plan' ? r.jobType === 'menu' : r.jobType !== 'menu'))
))

const selectedRequestId = ref('')
const selectedRequestData = ref(null)
const activeTab = ref('request')


// Live runs for the selected request — the SAME source the Results tab uses. Every LLM run
// (the planner + each step) is one uniform doc under steps/, so the Message tab is just the
// list of runs, each with its message (input), prompt (assembled), and response (output).
const { job: liveJob, runs: liveRuns, jobStatus: liveStatus, bind: bindJob, clear: clearJob } = useJob()
watch(selectedRequestId, (id) => { id ? bindJob(id) : clearJob() }, { immediate: true })

// Status to show for a history item. For the SELECTED request we trust the live, step-derived
// status (useJob.jobStatus) over the doc's `status` field, which goes stale after a debug re-run.
const statusFor = (req) => (req.jobId === selectedRequestId.value ? liveStatus.value : req.status)
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')

const messageLog = computed(() => {
  if (!selectedRequestId.value) return []
  // Order: planner first, then steps by index.
  const sortKey = (r) => (r.step === 'plan' ? -1 : Number(r.step))
  const list = [...(liveRuns.value || [])]
    .sort((a, b) => sortKey(a) - sortKey(b))
    .map((r) => ({
      id: r.id,
      kind: r.step === 'plan' ? 'planner' : 'step',
      label: r.step === 'plan' ? 'planner' : `step ${r.step}`,
      status: r.status || 'pending',
      message: r.message || '(no message yet)',     // input (Pub/Sub message)
      prompt: r.prompt || '(prompt not built yet)',  // assembled prompt sent to the LLM
      response: r.response || '',                    // output
    }))
  if (list.length) return list

  // No run docs under steps/ — covers legacy/one-shot jobs that streamed straight onto the
  // job doc, AND the worker cold-start window before the planner's run doc exists. Fall back
  // to the job doc's own message/prompt/response so the tabs aren't blank.
  const j = liveJob.value
  if (!j) return []
  return [{
    id: selectedRequestId.value,
    kind: j.type || 'request',
    label: j.type || 'request',
    status: j.status || 'pending',
    message: j.message || j.userPrompt || '(no message)',
    prompt: j.prompt || '(prompt not built yet)',
    response: j.response || '',
  }]
})

// Submit is enabled only with company + user + model + prompt. When a past request
// is selected, it stays disabled until SOMETHING changes from what was sent — any of
// prompt/company/user/model/type, not just the prompt — then submitting it creates a
// NEW request (we never mutate an existing one).
const canSubmit = computed(() => {
  if (loading.value) return false
  if (!selectedCompanyId.value || !selectedUserId.value || !selectedModel.value || !userPrompt.value.trim()) return false
  if (selectedRequestId.value && selectedRequestData.value) {
    const d = selectedRequestData.value
    return (
      userPrompt.value !== (d.userPrompt || '') ||
      selectedCompanyId.value !== (d.companyId || '') ||
      selectedUserId.value !== (d.userId || '') ||
      selectedModel.value !== (d.model || '') ||
      selectedType.value !== (d.type || '')
    )
  }
  return true
})

// Remove a history item: delete its Firestore doc (so onSnapshot won't re-add it),
// drop the optimistic copy, and prune the in-memory list. If it was selected,
// reset to a fresh request.
const deleteRequest = async (jobId) => {
  try {
    await $fetch(`/api/llm/${jobId}`, { method: 'DELETE' })
  } catch (err) {
    showError('Delete failed', err.message)
    return
  }
  saveLocal(loadLocal().filter((r) => r.jobId !== jobId))
  activeRequests.value = activeRequests.value.filter((r) => r.jobId !== jobId)
  if (selectedRequestId.value === jobId) newRequest()
}

// Clear everything for a fresh request: selection, prompt, company, user, model.
const newRequest = () => {
  if (docUnsub) { docUnsub(); docUnsub = null }
  selectedRequestId.value = ''
  selectedRequestData.value = null
  userPrompt.value = ''
  selectedCompanyId.value = ''
  selectedUserId.value = ''
  selectedModel.value = ''
  activeTab.value = 'request'
}

const requestBtn = ref(null)
const resultsBtn = ref(null)
const messageBtn = ref(null)
const promptBtn = ref(null)

const underlineLeft = ref(0)
const underlineWidth = ref(0)

const selectedCompany = computed(() => companies.value.find(c => c._id === selectedCompanyId.value))
const selectedUser = computed(() => users.value.find(u => u.uid === selectedUserId.value))
const filteredUsers = computed(() => users.value) // entities don't carry companyId — membership is separate

const loadCompanies = async () => {
  try {
    const res = await $fetch('/api/db/companies', { query: { env: currentEnv.value } })
    companies.value = res
  } catch (err) {
    showError('Failed to load companies', err.message)
  }
}

const loadUsers = async () => {
  try {
    const res = await $fetch('/api/db/users', { query: { env: currentEnv.value } })
    users.value = res
  } catch (err) {
    showError('Failed to load users', err.message)
  }
}

// --- Create company / user (the "+ Add" actions) ---
const newCompanyName = ref('')
const newUsername = ref('')
const newUserRole = ref('chef')

const createCompany = async () => {
  const name = newCompanyName.value.trim()
  if (!name) return
  try {
    const c = await $fetch('/api/db/companies', { method: 'POST', body: { name, env: currentEnv.value } })
    await loadCompanies()
    selectedCompanyId.value = c._id        // select the new company
    selectedUserId.value = ''              // company changed → clear user
    showCreateCompany.value = false
    newCompanyName.value = ''
    success('Company created', c.name)
  } catch (err) {
    showError('Create company failed', err.message)
  }
}

const createUser = async () => {
  if (!selectedCompanyId.value) {
    showError('Select a company first')
    return
  }
  const username = newUsername.value.trim()
  if (!username) return
  try {
    const u = await $fetch('/api/db/users', {
      method: 'POST',
      body: { username, role: newUserRole.value, companyId: selectedCompanyId.value, env: currentEnv.value },
    })
    await loadUsers()
    selectedUserId.value = u.uid ?? u._id
    showCreateUser.value = false
    newUsername.value = ''
    newUserRole.value = 'chef'
    success('User created', u.name || u.username)
  } catch (err) {
    showError('Create user failed', err.message)
  }
}

// Toggling local/production reloads the data for that environment.
watch(currentEnv, () => {
  selectedCompanyId.value = ''
  selectedUserId.value = ''
  loadCompanies()
  loadUsers()
  loadModels() // model list differs by env (dev shows only dev-capable tiers)
})

// --- History: optimistic localStorage + client-side Firestore (your pattern) ---
const HISTORY_KEY = 'yeschef-llm-history'
const loadLocal = () => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') } catch { return [] } }
const saveLocal = (a) => { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(a)) } catch { /* ignore */ } }
const addLocal = (item) => { const a = loadLocal().filter((x) => x.jobId !== item.jobId); a.unshift(item); saveLocal(a) }

const resultsCollection = () => useRuntimeConfig().public.firestoreCollectionResults || 'llmResults'

let historyUnsub = null
let docUnsub = null

const HISTORY_PAGE = 50
const historyLimit = ref(HISTORY_PAGE)
const historyHasMore = ref(false)

// Infinite scroll: grow the live listener's window. One extra doc per page tells us
// whether more exist without a count query.
const onHistoryScroll = (e) => {
  if (!historyHasMore.value) return
  const el = e.target
  if (el.scrollHeight - el.scrollTop - el.clientHeight > 200) return
  historyHasMore.value = false
  historyLimit.value += HISTORY_PAGE
  startHistory()
}

const startHistory = () => {
  // Show optimistic items immediately (survives reload), then reconcile with Firestore.
  if (!historyUnsub) activeRequests.value = loadLocal()
  else historyUnsub()
  const q = query(collection(getDb(), resultsCollection()), orderBy('createdAt', 'desc'), limit(historyLimit.value + 1))
  historyUnsub = onSnapshot(
    q,
    (snap) => {
      // type is UI-only (never sent to /ai/plan — see planSchema) — the local optimistic
      // record is the only place the ORIGINAL selection lives, so it always wins over
      // whatever unrelated `type` the backend happens to store on the job doc.
      const localByJobId = new Map(loadLocal().map((l) => [l.jobId, l]))
      historyHasMore.value = snap.docs.length > historyLimit.value
      const remote = snap.docs.slice(0, historyLimit.value).map((d) => {
        const x = d.data()
        const jobId = x.jobId || d.id
        return {
          jobId,
          type: localByJobId.get(jobId)?.type || x.type || 'query',
          jobType: x.type || '',   // the doc's own type — drives the plan/not-plan filter

          userPrompt: x.userPrompt || '',
          model: x.model || '',
          companyId: x.companyId || '',
          userId: x.userId || '',
          status: x.status || 'pending',
          createdAt: x.createdAt?.toMillis?.() ?? 0,
        }
      })
      // localStorage holds optimistic items not yet in Firestore — drop the confirmed ones.
      const remoteIds = new Set(remote.map((r) => r.jobId))
      const local = loadLocal().filter((l) => !remoteIds.has(l.jobId))
      saveLocal(local)
      activeRequests.value = [...local, ...remote].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    },
    (err) => showError('History read failed', err.message)
  )
}

const submitRequest = async () => {
  if (!selectedCompanyId.value || !selectedUserId.value || !userPrompt.value.trim()) {
    showError('Missing required fields')
    return
  }
  const promptText = userPrompt.value
  // Follow the local/production toggle — same switch as Pub/Sub emulator vs real GCP.
  const cfg = useRuntimeConfig().public
  const aiBaseUrl = currentEnv.value === 'production' ? cfg.aiBaseUrl : cfg.aiBaseUrlLocal
  const planUrl = `${aiBaseUrl.replace(/\/$/, '')}/plan`
  loading.value = true
  try {
    // The orchestrator REPLACES the old /api/llm/request: POST the request to /ai/plan,
    // which launches the planner and returns the jobId. Hard timeout so a stalled
    // publish/write can never hang the UI.
    // Minted HERE, before the POST: the jobId comes back only in the response, so it can't join a
    // request to the orchestrator log line that recorded receiving it. This can.
    const clientRequestId = crypto.randomUUID()
    console.log(`[ui/request] → POST ${planUrl}`, { clientRequestId, companyId: selectedCompanyId.value, userId: selectedUserId.value, model: selectedModel.value, promptLen: promptText.length })
    const { jobId } = await $fetch(planUrl, {
      method: 'POST',
      timeout: 15000,
      headers: { Authorization: `Bearer ${await useAuth().getToken()}` },
      body: {
        userId: selectedUserId.value,
        companyId: selectedCompanyId.value,
        userPrompt: promptText,
        model: selectedModel.value,
        metadata: { clientRequestId },
      },
    })
    console.log(`[ui/request] ✓ clientRequestId=${clientRequestId} jobId=${jobId} (watch Firestore llmResults/${jobId})`)
    success('Request submitted', `Job ID: ${jobId.slice(0, 8)}`)

    // Optimistic: persist to localStorage + show now; the Firestore snapshot
    // reconciles (and removes the local copy) once the doc appears.
    const item = { jobId, type: selectedType.value, userPrompt: promptText, model: selectedModel.value, companyId: selectedCompanyId.value, userId: selectedUserId.value, status: 'pending', createdAt: Date.now() }
    addLocal(item)
    activeRequests.value = [item, ...activeRequests.value.filter((r) => r.jobId !== jobId)]

    userPrompt.value = ''
    selectRequest(jobId)
    activeTab.value = 'results' // switch to Results so the response streams in view
  } catch (err) {
    console.error(`[ui/request] ✗ POST ${planUrl} failed:`, err?.message || err)
    showError('Submit failed', err.message)
  } finally {
    loading.value = false
  }
}

// Reflect a request's saved company/user/model in the selectors. `type` is deliberately
// NOT restored here — planSchema has no `type` field, so it's never sent to /ai/plan.
// Firestore's own `type` on the job doc means something backend-internal and unrelated;
// the UI's Type selection only ever lives in the local optimistic record.
const applySelectors = (data) => {
  if (!data) return
  if (data.companyId) selectedCompanyId.value = data.companyId
  if (data.userId) selectedUserId.value = data.userId
  if (data.model) selectedModel.value = data.model
}

const selectRequest = (jobId) => {
  selectedRequestId.value = jobId

  // Restore from the in-memory item immediately (so it works even if the live read
  // is slow): prefill the editable compose box + restore company/user/model.
  // Fall back to the optimistic localStorage copy, which always carries the prompt.
  const local = activeRequests.value.find((r) => r.jobId === jobId)
    || loadLocal().find((r) => r.jobId === jobId)
    || null
  selectedRequestData.value = local
  if (local?.userPrompt) userPrompt.value = local.userPrompt
  applySelectors(local)
  selectedType.value = local?.type || messageTypes.value[0] || 'query'

  // Jump to Results for items that already have (or are producing) output; otherwise
  // show the Request tab so you can see/edit the inputs.
  activeTab.value = local && (local.status === 'running' || local.status === 'success' || local.status === 'fail') ? 'results' : 'request'

  if (docUnsub) docUnsub()
  // Client-side real-time read enriches it (status/prompt) when the doc loads. `type` is
  // carried over from the local record, never from `data` — see applySelectors above.
  docUnsub = onSnapshot(doc(getDb(), resultsCollection(), jobId), (snap) => {
    if (snap.exists()) {
      const data = snap.data()
      selectedRequestData.value = { ...data, type: local?.type || data.type }
      if (data.userPrompt) userPrompt.value = data.userPrompt
      applySelectors(data)
    }
  }, (err) => showError('Could not read request', err.message))
}

const handleQueryKeydown = (event) => {
  if (event.shiftKey && event.key === 'Enter') {
    event.preventDefault()
    if (canSubmit.value) submitRequest()
  }
}

const updateUnderline = () => {
  const buttons = {
    request: requestBtn.value,
    results: resultsBtn.value,
    message: messageBtn.value,
    prompt: promptBtn.value
  }

  const activeBtn = buttons[activeTab.value]
  if (activeBtn) {
    underlineLeft.value = activeBtn.offsetLeft
    underlineWidth.value = activeBtn.offsetWidth
  }
}

watch(activeTab, () => {
  nextTick(() => updateUnderline())
})

const loadModels = async () => {
  try {
    models.value = await $fetch('/api/llm/models', { query: { env: currentEnv.value } })
    // Keep the selection valid: prod-only models aren't offered in dev, so if the
    // current pick isn't in the list, fall back to the first available model.
    if (!models.value.some((m) => m.value === selectedModel.value)) {
      selectedModel.value = models.value[0]?.value || ''
    }
  } catch (err) {
    console.error('Failed to load models:', err)
  }
}

// Message types come from the SAME shared endpoint the prompt editor uses — no
// duplicated list. /api/llm/types → config/models.js MESSAGE_TYPES.
const loadTypes = async () => {
  try {
    messageTypes.value = await $fetch('/api/llm/types')
    if (!messageTypes.value.includes(selectedType.value)) selectedType.value = messageTypes.value[0] || 'query'
  } catch (err) {
    console.error('Failed to load types:', err)
  }
}

onMounted(() => {
  loadModels()
  loadTypes()
  loadCompanies()
  loadUsers()
  startHistory()
  updateUnderline()
  window.addEventListener('resize', updateUnderline)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateUnderline)
  if (historyUnsub) historyUnsub()
  if (docUnsub) docUnsub()
})
</script>
