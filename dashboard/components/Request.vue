<template>
  <div class="flex gap-4 h-screen">
    <!-- Left Panel: Request History -->
    <div class="w-64 panel backdrop-blur-md p-4 overflow-y-auto flex flex-col min-h-0">
      <button
        type="button"
        @click="newRequest"
        class="mb-3 w-full px-3 py-2 rounded bg-amber-500 text-gray-900 hover:bg-amber-600 text-sm font-medium"
      >
        + New request
      </button>
      <div class="space-y-2">
        <div v-if="activeRequests.length === 0" class="text-muted text-xs text-center py-4">
          No requests
        </div>
        <div
          v-for="req in activeRequests"
          :key="req.jobId"
          @click="selectRequest(req.jobId)"
          :class="[
            'group relative p-2 pr-6 rounded-lg cursor-pointer transition text-xs',
            selectedRequestId === req.jobId
              ? 'bg-amber-500/20 border border-amber-500'
              : 'hover:bg-amber-500/10 border border-transparent'
          ]"
        >
          <button
            type="button"
            @click.stop="deleteRequest(req.jobId)"
            title="Delete"
            class="absolute top-1 right-1 w-5 h-5 rounded flex items-center justify-center text-muted opacity-0 group-hover:opacity-100 hover:bg-error/20 hover:text-error transition"
          >×</button>
          <div class="text-primary font-mono">{{ req.jobId.slice(0, 8) }}</div>
          <div v-if="req.userPrompt" class="text-gray-400 truncate mt-0.5">{{ req.userPrompt }}</div>
          <div class="text-xs capitalize mt-0.5 flex items-center gap-1.5" :class="req.status === 'complete' ? 'text-success' : 'text-primary'">
            <span v-if="req.status === 'streaming'" class="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
            {{ req.status }}
          </div>
        </div>
      </div>
    </div>

    <!-- Right Panel: Settings + Query/Results -->
    <div class="flex-1 panel overflow-hidden flex flex-col min-h-0">
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
                <span>{{ selectedUser?.username || 'User' }}</span>
                <span class="text-xs opacity-60">▼</span>
              </ListboxButton>
              <ListboxOptions v-if="selectedCompanyId" :class="[
                'absolute z-50 w-full mt-1 rounded-lg p-2 space-y-1 border',
                isDark ? 'bg-gray-950 border-gray-700/60' : 'bg-white border-gray-300'
              ]">
                <ListboxOption v-for="u in filteredUsers" :key="u._id" :value="u._id" :class="[
                  'px-3 py-2 rounded cursor-pointer text-sm',
                  isDark ? 'hover:bg-amber-500/20' : 'hover:bg-gray-100'
                ]">
                  {{ u.username }} ({{ u.role }})
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
              v-if="selectedRequestData && selectedRequestData.status === 'streaming'"
              class="ml-1.5 inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse align-middle"
              title="Streaming…"
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
              <ListboxOptions class="absolute z-50 w-full mt-1 rounded-lg p-2 space-y-1 bg-gray-950 border border-gray-700/60 shadow-xl">
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
              <ListboxOptions class="absolute z-50 w-full mt-1 rounded-lg p-2 space-y-1 bg-gray-950 border border-gray-700/60 shadow-xl">
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

        <!-- Prompt Tab — live preview of what the worker will build (system + request) -->
        <div v-show="activeTab === 'prompt'" class="h-full flex flex-col">
          <div class="p-3 rounded text-xs whitespace-pre-wrap break-words font-mono overflow-auto flex-1 glass">{{ promptPreview }}</div>
        </div>

        <!-- Message Tab -->
        <div v-show="activeTab === 'message'" class="h-full flex flex-col">
          <div v-if="!selectedRequestId" class="text-gray-400 dark:text-gray-500 text-sm text-center flex items-center justify-center h-full">
            Select a request to view message
          </div>
          <div v-else-if="selectedRequestData" :class="[
            'p-3 rounded text-xs whitespace-pre-wrap break-words font-mono overflow-auto flex-1',
            isDark ? 'bg-black/20 text-gray-100' : 'bg-gray-100 text-gray-900 border border-gray-200'
          ]">
            {{ selectedRequestData.userPrompt || 'No message' }}
          </div>
        </div>

        <!-- Results Tab -->
        <div v-show="activeTab === 'results'" class="h-full flex flex-col">
          <div v-if="!selectedRequestId" class="text-gray-400 dark:text-gray-500 text-sm text-center flex items-center justify-center h-full">
            Select a request to view results
          </div>
          <div v-else-if="selectedRequestData" class="flex flex-col h-full min-h-0">
            <div v-if="selectedRequestData.status === 'pending'" class="text-primary text-sm">
              Waiting for worker...
            </div>
            <div v-else-if="selectedRequestData.status === 'streaming'" class="flex flex-col min-h-0 flex-1">
              <div class="text-primary text-xs font-medium mb-2">Streaming...</div>
              <div class="p-3 rounded text-xs whitespace-pre-wrap break-words font-mono overflow-auto flex-1 glass">
                {{ selectedRequestData.response }}
              </div>
            </div>
            <div v-else-if="selectedRequestData.status === 'complete'" class="flex flex-col min-h-0 flex-1">
              <div class="text-success text-xs font-medium mb-2">✓ Complete</div>
              <div class="p-3 rounded text-xs whitespace-pre-wrap break-words font-mono overflow-auto flex-1 glass">
                {{ selectedRequestData.response }}
              </div>
            </div>
            <div
              v-else-if="selectedRequestData.error"
              title="Hover to show the full error"
              class="text-error text-sm whitespace-pre-wrap break-words line-clamp-3 hover:line-clamp-none cursor-help overflow-auto"
            >
              Error: {{ selectedRequestData.error }}
            </div>
          </div>
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
      <div class="w-full max-w-sm mx-4 rounded-lg p-5 bg-gray-900 border border-amber-500/30">
        <h2 class="text-lg font-serif text-primary mb-3">New Company</h2>
        <input
          v-model="newCompanyName"
          type="text"
          placeholder="Company name"
          class="w-full px-3 py-2 rounded bg-gray-800 text-white border border-gray-700 focus:border-amber-500 focus:outline-none text-sm"
          @keyup.enter="createCompany"
        />
        <div class="flex gap-2 justify-end mt-4">
          <button type="button" @click="showCreateCompany = false" class="px-3 py-1.5 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 text-sm">Cancel</button>
          <button type="button" @click="createCompany" :disabled="!newCompanyName.trim()" class="px-3 py-1.5 rounded bg-amber-500 text-gray-900 hover:bg-amber-600 text-sm font-medium disabled:opacity-50">Create</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- Create User modal -->
  <Teleport to="body">
    <div v-if="showCreateUser" class="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]" @click.self="showCreateUser = false">
      <div class="w-full max-w-sm mx-4 rounded-lg p-5 bg-gray-900 border border-amber-500/30">
        <h2 class="text-lg font-serif text-primary mb-1">New User</h2>
        <p class="text-xs text-gray-400 mb-3">In {{ selectedCompany?.name || 'selected company' }}</p>
        <input
          v-model="newUsername"
          type="text"
          placeholder="Username"
          class="w-full px-3 py-2 rounded bg-gray-800 text-white border border-gray-700 focus:border-amber-500 focus:outline-none text-sm mb-2"
          @keyup.enter="createUser"
        />
        <select v-model="newUserRole" class="w-full px-3 py-2 rounded bg-gray-800 text-white border border-gray-700 focus:border-amber-500 focus:outline-none text-sm">
          <option value="chef">chef</option>
          <option value="rdn">rdn</option>
          <option value="admin">admin</option>
        </select>
        <div class="flex gap-2 justify-end mt-4">
          <button type="button" @click="showCreateUser = false" class="px-3 py-1.5 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 text-sm">Cancel</button>
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
import { collection, query, orderBy, limit, onSnapshot, doc } from 'firebase/firestore'
import { getDb } from '~/lib/firebase'

const { success, error: showError } = useToast()
const { isDark } = useTheme()

const companies = ref([])
const users = ref([])
const selectedCompanyId = ref('')
const selectedUserId = ref('')
const { env: currentEnv } = useEnvironment()
const models = ref([])
const selectedModel = ref('openclaw_v1')
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
const selectedRequestId = ref('')
const selectedRequestData = ref(null)
const activeTab = ref('request')

// Live preview of the FULL prompt the worker will build: the system prompt assembled
// from the current prompt_library (for the selected type) + the user request. This is
// NOT the worker's stored snapshot, so it always reflects your latest library edits.
const systemPrompt = ref('')
const promptPreview = computed(() => {
  const parts = []
  if (systemPrompt.value) parts.push(systemPrompt.value)
  if (userPrompt.value) parts.push(userPrompt.value)
  return parts.join('\n\n')
})

// Submit is enabled only with company + user + model + prompt. When a past request
// is selected, it stays disabled until the prompt is edited — then submitting it
// creates a NEW request (we never mutate an existing one).
const canSubmit = computed(() => {
  if (loading.value) return false
  if (!selectedCompanyId.value || !selectedUserId.value || !selectedModel.value || !userPrompt.value.trim()) return false
  if (selectedRequestId.value && selectedRequestData.value) {
    return userPrompt.value !== (selectedRequestData.value.userPrompt || '')
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
const selectedUser = computed(() => users.value.find(u => u._id === selectedUserId.value))
const filteredUsers = computed(() => users.value.filter(u => u.companyId === selectedCompanyId.value))

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
    selectedUserId.value = u._id           // select the new user
    showCreateUser.value = false
    newUsername.value = ''
    newUserRole.value = 'chef'
    success('User created', u.username)
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

const startHistory = () => {
  // Show optimistic items immediately (survives reload), then reconcile with Firestore.
  activeRequests.value = loadLocal()
  const q = query(collection(getDb(), resultsCollection()), orderBy('createdAt', 'desc'), limit(50))
  historyUnsub = onSnapshot(
    q,
    (snap) => {
      const remote = snap.docs.map((d) => {
        const x = d.data()
        return {
          jobId: x.jobId || d.id,
          type: x.type || 'query',
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
  loading.value = true
  try {
    const { jobId } = await $fetch('/api/llm/request', {
      method: 'POST',
      // Hard timeout so a stalled server-side publish/write can NEVER hang the UI.
      // The submit only POSTs here; the server does the Firestore write + Pub/Sub
      // publish, so if that stalls we surface an error instead of locking the button.
      timeout: 15000,
      body: {
        userId: selectedUserId.value,
        companyId: selectedCompanyId.value,
        type: selectedType.value,
        userPrompt: promptText,
        model: selectedModel.value,
        env: currentEnv.value,
        metadata: {},
      },
    })
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
    showError('Submit failed', err.message)
  } finally {
    loading.value = false
  }
}

// Reflect a request's saved company/user/model in the selectors.
const applySelectors = (data) => {
  if (!data) return
  if (data.companyId) selectedCompanyId.value = data.companyId
  if (data.userId) selectedUserId.value = data.userId
  if (data.model) selectedModel.value = data.model
  if (data.type) selectedType.value = data.type
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

  // Jump to Results for items that already have (or are producing) output; otherwise
  // show the Request tab so you can see/edit the inputs.
  activeTab.value = local && (local.status === 'complete' || local.status === 'streaming') ? 'results' : 'request'

  if (docUnsub) docUnsub()
  // Client-side real-time read enriches it (status/response/prompt) when the doc loads.
  docUnsub = onSnapshot(doc(getDb(), resultsCollection(), jobId), (snap) => {
    if (snap.exists()) {
      const data = snap.data()
      selectedRequestData.value = data
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

watch(activeTab, (tab) => {
  nextTick(() => updateUnderline())
  if (tab === 'prompt') loadSystemPrompt() // re-pull in case the library changed
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

// Assemble the system prompt for the current type from the live prompt_library.
const loadSystemPrompt = async () => {
  try {
    systemPrompt.value = await $fetch('/api/llm/system-prompt', { query: { type: selectedType.value } })
  } catch (err) {
    console.error('Failed to load system prompt:', err)
    systemPrompt.value = ''
  }
}
// Refresh when the type changes (selecting a past request also sets the type).
watch(selectedType, loadSystemPrompt)

onMounted(() => {
  loadModels()
  loadTypes()
  loadSystemPrompt()
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
