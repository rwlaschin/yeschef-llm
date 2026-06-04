<template>
  <div class="flex gap-4 h-screen">
    <!-- Left Panel: Request History -->
    <div class="w-64 panel backdrop-blur-md p-4 overflow-y-auto flex flex-col min-h-0">
      <div class="space-y-2">
        <div v-if="activeRequests.length === 0" class="text-muted text-xs text-center py-4">
          No requests
        </div>
        <div
          v-for="req in activeRequests"
          :key="req.jobId"
          @click="selectRequest(req.jobId)"
          :class="[
            'p-2 rounded-lg cursor-pointer transition text-xs',
            selectedRequestId === req.jobId
              ? 'bg-amber-500/20 border border-amber-500'
              : 'hover:bg-amber-500/10 border border-transparent'
          ]"
        >
          <div class="text-primary font-mono">{{ req.jobId.slice(0, 8) }}</div>
          <div class="text-xs capitalize" :class="req.status === 'complete' ? 'text-success' : 'text-primary'">
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
                isDark ? 'bg-gray-800 border-amber-500/20' : 'bg-white border-gray-300'
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
                isDark ? 'bg-gray-800 border-amber-500/20' : 'bg-white border-gray-300'
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
              isDark
                ? activeTab === 'results' ? 'text-amber-400' : 'text-gray-300 hover:text-gray-200'
                : activeTab === 'results' ? 'text-amber-600' : 'text-gray-600 hover:text-gray-700'
            ]"
          >
            Results
          </button>
          <button
            ref="messageBtn"
            @click="activeTab = 'message'"
            :class="[
              'px-4 py-2 text-sm font-medium transition-colors duration-300 relative z-10',
              isDark
                ? activeTab === 'message' ? 'text-amber-400' : 'text-gray-300 hover:text-gray-200'
                : activeTab === 'message' ? 'text-amber-600' : 'text-gray-600 hover:text-gray-700'
            ]"
          >
            Message
          </button>
          <button
            ref="promptBtn"
            @click="activeTab = 'prompt'"
            :class="[
              'px-4 py-2 text-sm font-medium transition-colors duration-300 relative z-10',
              isDark
                ? activeTab === 'prompt' ? 'text-amber-400' : 'text-gray-300 hover:text-gray-200'
                : activeTab === 'prompt' ? 'text-amber-600' : 'text-gray-600 hover:text-gray-700'
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
              <ListboxOptions class="absolute z-50 w-full mt-1 rounded-lg p-2 space-y-1 glass border-amber-500/20">
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
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-auto p-4 min-h-0">
        <!-- Request Tab -->
        <div v-show="activeTab === 'request'" class="h-full flex flex-col">
          <textarea
            v-model="userPrompt"
            @keydown="handleQueryKeydown"
            placeholder="What would you like to ask?"
            class="h-full form-input text-sm font-mono resize-y overflow-y-auto overflow-x-hidden transition-none"
          />
        </div>

        <!-- Prompt Tab -->
        <div v-show="activeTab === 'prompt'" class="h-full flex flex-col">
          <div v-if="!selectedRequestId" class="text-muted text-sm text-center flex items-center justify-center h-full">
            Select a request to view prompt
          </div>
          <div v-else-if="selectedRequestData" class="p-3 rounded text-xs whitespace-pre-wrap font-mono overflow-auto flex-1 glass">
            {{ selectedRequestData.prompt || selectedRequestData.userPrompt || 'No prompt' }}
          </div>
        </div>

        <!-- Message Tab -->
        <div v-show="activeTab === 'message'" class="h-full flex flex-col">
          <div v-if="!selectedRequestId" :class="isDark ? 'text-gray-500' : 'text-gray-400'" class="text-sm text-center flex items-center justify-center h-full">
            Select a request to view message
          </div>
          <div v-else-if="selectedRequestData" :class="[
            'p-3 rounded text-xs whitespace-pre-wrap font-mono overflow-auto flex-1',
            isDark ? 'bg-black/20 text-gray-100' : 'bg-gray-100 text-gray-900 border border-gray-200'
          ]">
            {{ selectedRequestData.userPrompt || 'No message' }}
          </div>
        </div>

        <!-- Results Tab -->
        <div v-show="activeTab === 'results'" class="h-full flex flex-col">
          <div v-if="!selectedRequestId" :class="isDark ? 'text-gray-500' : 'text-gray-400'" class="text-sm text-center flex items-center justify-center h-full">
            Select a request to view results
          </div>
          <div v-else-if="selectedRequestData" class="flex flex-col h-full min-h-0">
            <div v-if="selectedRequestData.status === 'pending'" class="text-primary text-sm">
              Waiting for worker...
            </div>
            <div v-else-if="selectedRequestData.status === 'streaming'" class="flex flex-col min-h-0 flex-1">
              <div class="text-primary text-xs font-medium mb-2">Streaming...</div>
              <div class="p-3 rounded text-xs whitespace-pre-wrap font-mono overflow-auto flex-1 glass">
                {{ selectedRequestData.response }}
              </div>
            </div>
            <div v-else-if="selectedRequestData.status === 'complete'" class="flex flex-col min-h-0 flex-1">
              <div class="text-success text-xs font-medium mb-2">✓ Complete</div>
              <div class="p-3 rounded text-xs whitespace-pre-wrap font-mono overflow-auto flex-1 glass">
                {{ selectedRequestData.response }}
              </div>
            </div>
            <div v-else-if="selectedRequestData.error" class="text-error text-sm">
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
    :disabled="loading || !selectedCompanyId || !selectedUserId || !userPrompt.trim()"
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
import { onSnapshot, doc } from 'firebase/firestore'
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
const userPrompt = ref('')
const loading = ref(false)
const showCreateCompany = ref(false)
const showCreateUser = ref(false)

const activeRequests = ref([])
const selectedRequestId = ref('')
const selectedRequestData = ref(null)
const activeTab = ref('request')

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
})

const submitRequest = async () => {
  if (!selectedCompanyId.value || !selectedUserId.value || !userPrompt.value.trim()) {
    showError('Missing required fields')
    return
  }

  loading.value = true
  try {
    const response = await $fetch('/api/llm/request', {
      method: 'POST',
      body: {
        userId: selectedUserId.value,
        companyId: selectedCompanyId.value,
        type: 'query',
        userPrompt: userPrompt.value,
        model: selectedModel.value,
        env: currentEnv.value,
        metadata: {},
      },
    })

    const { jobId } = response
    success('Request submitted', `Job ID: ${jobId.slice(0, 8)}`)

    activeRequests.value.unshift({
      jobId,
      type: 'query',
      status: 'pending',
    })

    userPrompt.value = ''
    selectRequest(jobId)
    activeTab.value = 'results'
  } catch (err) {
    showError('Submit failed', err.message)
  } finally {
    loading.value = false
  }
}

const selectRequest = (jobId) => {
  selectedRequestId.value = jobId
  activeTab.value = 'results'

  if (window.__requestUnsubscribe) {
    window.__requestUnsubscribe()
  }

  const db = getDb()
  const config = useRuntimeConfig()
  const collection_name = config.public.firestoreCollectionResults || 'llmResults'
  const docRef = doc(db, collection_name, jobId)

  window.__requestUnsubscribe = onSnapshot(docRef, (docSnap) => {
    if (docSnap.exists()) {
      const data = docSnap.data()
      selectedRequestData.value = data
      userPrompt.value = data.userPrompt || userPrompt.value

      const req = activeRequests.value.find(r => r.jobId === jobId)
      if (req) {
        req.status = data.status
      }
    }
  })
}

const handleQueryKeydown = (event) => {
  if (event.shiftKey && event.key === 'Enter') {
    event.preventDefault()
    submitRequest()
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
    models.value = await $fetch('/api/llm/models')
  } catch (err) {
    console.error('Failed to load models:', err)
  }
}

onMounted(() => {
  loadModels()
  loadCompanies()
  loadUsers()
  updateUnderline()
  window.addEventListener('resize', updateUnderline)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateUnderline)
})
</script>
