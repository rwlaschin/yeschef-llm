<template>
  <div>
    <!-- Header -->
    <div class="flex justify-between items-center mb-3">
      <h2 class="text-lg font-serif text-primary">{{ isEditing ? `Edit Tool v${version}` : 'New Tool' }}</h2>
      <div class="flex items-center gap-2">
        <div class="flex items-center gap-1.5">
          <span :class="['text-xs', form.active ? 'text-emerald-400' : 'text-gray-400']">
            {{ form.active ? 'Active' : 'Inactive' }}
          </span>
          <Toggle v-model="form.active" />
        </div>
        <button @click="$emit('cancel')" class="p-0.5 text-gray-400 hover:text-white transition">
          <XMarkIcon class="w-4 h-4" />
        </button>
      </div>
    </div>

    <!-- Intro / Docs Banner -->
    <div class="flex items-start gap-2 mb-3 p-2 rounded bg-gray-800/40 border border-gray-700">
      <InformationCircleIcon class="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
      <p class="text-xs text-gray-300 leading-relaxed">
        A tool lets the model call out to your code or services. The model reads the
        <span class="text-gray-100 font-medium">name</span> + <span class="text-gray-100 font-medium">description</span>
        to decide when to use it, then sends the <span class="text-gray-100 font-medium">parameters</span> you define.
        <a href="https://docs.ollama.com/capabilities/tool-calling" target="_blank" class="text-amber-400 hover:text-amber-300 underline">Ollama tool-calling docs ↗</a>
      </p>
    </div>

    <form @submit.prevent="handleSubmit(false)" class="space-y-3">
      <!-- Row 1: Name + Type -->
      <div class="grid grid-cols-3 gap-2">
        <div class="col-span-2">
          <label class="text-xs font-semibold text-gray-300 block mb-0.5">Tool Name *</label>
          <input v-model="form.name" type="text" placeholder="search_recipes" class="w-full px-2 py-1 text-xs rounded bg-gray-800 text-white border border-gray-700 focus:border-amber-500" />
          <p class="text-[11px] text-gray-500 mt-0.5">snake_case identifier the model calls (e.g. <span class="font-mono">get_weather</span>)</p>
          <span v-if="errors.name" class="text-xs text-red-400">{{ errors.name }}</span>
        </div>
        <div>
          <label class="text-xs font-semibold text-gray-300 block mb-0.5">Type *</label>
          <Select v-model="form.type" :options="typeOptions" placeholder="Pick" />
          <p class="text-[11px] text-gray-500 mt-0.5">How it runs</p>
          <span v-if="errors.type" class="text-xs text-red-400">{{ errors.type }}</span>
        </div>
      </div>

      <!-- Row 2: Description -->
      <div>
        <label class="text-xs font-semibold text-gray-300 block mb-0.5">Description *</label>
        <textarea v-model="form.definition.description" placeholder="e.g. Search the recipe database by ingredients and dietary needs" class="w-full px-2 py-1 text-xs rounded bg-gray-800 text-white border border-gray-700 focus:border-amber-500 resize-none" rows="2" />
        <p class="text-[11px] text-gray-500 mt-0.5">The model reads this to decide <em>when</em> to call the tool — be specific.</p>
        <span v-if="errors.description" class="text-xs text-red-400">{{ errors.description }}</span>
      </div>

      <!-- Type-Specific Implementation Config -->
      <!-- Pick-a-type hint -->
      <div v-if="!form.type" class="border-t border-gray-700 pt-2">
        <p class="text-xs text-gray-500 italic">Pick a Type above to configure how this tool runs.</p>
      </div>

      <div v-if="form.type" class="border-t border-gray-700 pt-2 space-y-2">
        <!-- Section header (shared) -->
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-gray-300">{{ typeMeta.label }}</span>
          <a :href="typeMeta.docs" target="_blank" class="text-[11px] text-amber-400 hover:text-amber-300 underline">{{ typeMeta.docsLabel }} ↗</a>
        </div>
        <p class="text-[11px] text-gray-500">{{ typeMeta.help }}</p>

        <!-- API Call -->
        <div v-if="form.type === 'api_call'" class="space-y-2">
          <div>
            <label class="text-[11px] text-gray-400 block mb-0.5">Endpoint URL *</label>
            <input v-model="form.impl.endpoint" type="text" placeholder="https://api.example.com/search" class="w-full px-2 py-1 text-xs rounded bg-gray-800 text-white border border-gray-700 focus:border-amber-500" />
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="text-[11px] text-gray-400 block mb-0.5">Method</label>
              <Select v-model="form.impl.method" :options="['GET', 'POST', 'PUT', 'DELETE']" />
            </div>
            <div>
              <label class="text-[11px] text-gray-400 block mb-0.5">Auth</label>
              <Select v-model="form.impl.auth_type" :options="authOptions" />
            </div>
          </div>
          <div v-if="form.impl.auth_type !== 'none'">
            <label class="text-[11px] text-gray-400 block mb-0.5">{{ form.impl.auth_type === 'bearer' ? 'Bearer Token *' : 'API Key *' }}</label>
            <input v-model="form.impl.auth_value" type="password" placeholder="Stored securely" class="w-full px-2 py-1 text-xs rounded bg-gray-800 text-white border border-gray-700 focus:border-amber-500" />
          </div>
        </div>

        <!-- Database -->
        <div v-if="form.type === 'database'" class="space-y-2">
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="text-[11px] text-gray-400 block mb-0.5">Database</label>
              <Select v-model="form.impl.db_type" :options="['MongoDB', 'PostgreSQL', 'MySQL']" />
            </div>
            <div>
              <label class="text-[11px] text-gray-400 block mb-0.5">Collection / Table *</label>
              <input v-model="form.impl.collection" type="text" placeholder="recipes" class="w-full px-2 py-1 text-xs rounded bg-gray-800 text-white border border-gray-700 focus:border-amber-500" />
            </div>
          </div>
          <div>
            <label class="text-[11px] text-gray-400 block mb-0.5">Connection String *</label>
            <input v-model="form.impl.connection" type="password" placeholder="mongodb://… (stored securely)" class="w-full px-2 py-1 text-xs rounded bg-gray-800 text-white border border-gray-700 focus:border-amber-500" />
          </div>
        </div>

        <!-- Web Search -->
        <div v-if="form.type === 'web_search'" class="space-y-2">
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="text-[11px] text-gray-400 block mb-0.5">Search Service</label>
              <Select v-model="form.impl.service" :options="serviceOptions" />
            </div>
            <div v-if="form.impl.service === 'custom'">
              <label class="text-[11px] text-gray-400 block mb-0.5">Endpoint *</label>
              <input v-model="form.impl.endpoint" type="text" placeholder="https://…" class="w-full px-2 py-1 text-xs rounded bg-gray-800 text-white border border-gray-700 focus:border-amber-500" />
            </div>
          </div>
          <div>
            <label class="text-[11px] text-gray-400 block mb-0.5">API Key</label>
            <input v-model="form.impl.api_key" type="password" placeholder="Optional — leave blank if not required" class="w-full px-2 py-1 text-xs rounded bg-gray-800 text-white border border-gray-700 focus:border-amber-500" />
          </div>
        </div>

        <!-- Transform -->
        <div v-if="form.type === 'transform'">
          <label class="text-[11px] text-gray-400 block mb-0.5">Transformation Rules</label>
          <textarea v-model="form.impl.transform_rules" placeholder="e.g. map results[].name → title, results[].url → link" class="w-full px-2 py-1 text-xs rounded bg-gray-800 text-white border border-gray-700 focus:border-amber-500 resize-none" rows="2" />
        </div>

        <!-- Custom -->
        <div v-if="form.type === 'custom'">
          <label class="text-[11px] text-gray-400 block mb-0.5">Implementation Notes</label>
          <textarea v-model="form.impl.notes" placeholder="HTTP endpoint, serverless URL, or function name your code will dispatch to" class="w-full px-2 py-1 text-xs rounded bg-gray-800 text-white border border-gray-700 focus:border-amber-500 resize-none" rows="2" />
        </div>
      </div>

      <!-- Parameters (Compact) -->
      <div v-if="form.type" class="border-t border-gray-700 pt-2">
        <div class="flex items-center justify-between mb-0.5">
          <span class="text-xs font-semibold text-gray-300">Parameters</span>
          <button type="button" @click="addParameter" class="text-xs text-amber-400 hover:text-amber-300">+ Add</button>
        </div>
        <p class="text-[11px] text-gray-500 mb-1.5">Inputs the model fills in when calling the tool. Mark <span class="font-mono">req</span> for ones it must always provide.</p>

        <div v-if="parametersList.length > 0" class="space-y-1">
          <div v-for="(param, idx) in parametersList" :key="idx" class="grid grid-cols-6 gap-1 items-center text-xs">
            <input v-model="param.name" type="text" placeholder="name" class="col-span-2 px-1.5 py-1 rounded bg-gray-900 text-white border border-gray-700 focus:border-amber-500" />
            <div class="col-span-2">
              <Select v-model="param.type" :options="['string', 'number', 'integer', 'boolean', 'array']" />
            </div>
            <label class="flex items-center gap-1">
              <input v-model="param.required" type="checkbox" class="w-3 h-3" />
              <span class="text-gray-400">req</span>
            </label>
            <button type="button" @click="removeParameter(idx)" class="text-red-400 hover:text-red-300 justify-self-end">✕</button>
          </div>
        </div>
        <div v-else class="text-xs text-gray-500 italic py-1">None</div>
      </div>

      <!-- Errors -->
      <div v-if="Object.keys(errors).length > 0" class="p-2 rounded bg-red-900/30 border border-red-700 text-red-200 text-xs">
        <div v-for="(msg, key) in errors" :key="key">{{ msg }}</div>
      </div>

      <!-- Actions -->
      <div class="flex gap-2 justify-end pt-2 border-t border-gray-700">
        <button type="button" @click="$emit('cancel')" class="px-3 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 text-xs font-medium">Cancel</button>

        <!-- Create (new tool) -->
        <button v-if="!isEditing" type="submit" class="px-3 py-1 rounded bg-amber-500 text-gray-900 hover:bg-amber-600 text-xs font-medium">Create</button>

        <!-- Update split-button (editing) -->
        <Menu v-else as="div" class="relative inline-flex">
          <button type="submit" class="px-3 py-1 rounded-l bg-amber-500 text-gray-900 hover:bg-amber-600 text-xs font-medium">Update</button>
          <MenuButton type="button" class="px-1.5 py-1 rounded-r bg-amber-600 text-gray-900 hover:bg-amber-700 text-xs font-medium border-l border-amber-700/40 flex items-center">▾</MenuButton>
          <MenuItems class="absolute right-0 bottom-full mb-1.5 w-52 rounded-lg p-1 bg-gray-800 border border-gray-700 shadow-xl focus:outline-none z-50">
            <MenuItem v-slot="{ active }">
              <button type="button" @click="handleSubmit(true)" :class="['w-full text-left px-2.5 py-2 rounded text-xs font-medium transition', active ? 'bg-amber-500/20 text-amber-300' : 'text-gray-200']">
                Save as new version
                <span class="block text-[10px] font-normal text-gray-400 mt-0.5">Creates v{{ (version || 0) + 1 }}, keeps v{{ version }}</span>
              </button>
            </MenuItem>
          </MenuItems>
        </Menu>
      </div>
    </form>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { XMarkIcon, InformationCircleIcon } from '@heroicons/vue/24/outline'
import { Menu, MenuButton, MenuItems, MenuItem } from '@headlessui/vue'
import Toggle from '~/components/Toggle.vue'
import Select from '~/components/Select.vue'

const props = defineProps({ tool: Object })
const emit = defineEmits(['save', 'cancel'])

const isEditing = computed(() => !!props.tool?._id)
const version = computed(() => props.tool?.version || '')

// Dropdown options
const typeOptions = [
  { value: 'api_call', label: 'API Call' },
  { value: 'database', label: 'Database' },
  { value: 'web_search', label: 'Web Search' },
  { value: 'transform', label: 'Transform' },
  { value: 'custom', label: 'Custom' }
]
const authOptions = [
  { value: 'none', label: 'No Auth' },
  { value: 'api_key', label: 'API Key' },
  { value: 'bearer', label: 'Bearer' }
]
const serviceOptions = [
  { value: 'google', label: 'Google' },
  { value: 'duckduckgo', label: 'DuckDuckGo' },
  { value: 'bing', label: 'Bing' },
  { value: 'custom', label: 'Custom' }
]

// Per-type explanation + docs link
const TYPE_META = {
  api_call: {
    label: 'API Call',
    help: 'Calls an HTTP endpoint. The model\'s arguments are sent as query params or a JSON body.',
    docs: 'https://docs.ollama.com/capabilities/tool-calling',
    docsLabel: 'Tool-calling docs'
  },
  database: {
    label: 'Database Query',
    help: 'Runs a query against a database collection/table and returns matching records.',
    docs: 'https://www.mongodb.com/docs/manual/tutorial/query-documents/',
    docsLabel: 'Query docs'
  },
  web_search: {
    label: 'Web Search',
    help: 'Searches the web through a chosen service and returns result snippets.',
    docs: 'https://docs.ollama.com/capabilities/web-search',
    docsLabel: 'Web search docs'
  },
  transform: {
    label: 'Data Transform',
    help: 'Reshapes or reformats data — map fields, convert formats, no external call.',
    docs: 'https://docs.ollama.com/capabilities/tool-calling',
    docsLabel: 'Tool-calling docs'
  },
  custom: {
    label: 'Custom',
    help: 'Anything else. Your code dispatches on the tool name to run the implementation.',
    docs: 'https://docs.ollama.com/capabilities/tool-calling',
    docsLabel: 'Tool-calling docs'
  }
}
const typeMeta = computed(() => TYPE_META[form.value.type] || TYPE_META.custom)

const form = ref({
  name: '',
  type: '',
  active: true,
  impl: {
    endpoint: '',
    method: 'GET',
    auth_type: 'none',
    auth_value: '',
    db_type: 'MongoDB',
    collection: '',
    connection: '',
    service: 'google',
    api_key: '',
    transform_rules: '',
    notes: ''
  },
  definition: {
    name: '',
    description: '',
    parameters: { type: 'object', properties: {}, required: [] }
  }
})

const parametersList = ref([])
const errors = ref({})

// Define functions FIRST, before watch
const syncParametersFromDefinition = () => {
  if (form.value.definition.parameters?.properties) {
    parametersList.value = Object.entries(form.value.definition.parameters.properties).map(([name, prop]) => ({
      name,
      type: prop.type,
      required: form.value.definition.parameters.required?.includes(name) || false
    }))
  }
}

const syncDefinitionFromParameters = () => {
  const properties = {}
  const required = []
  parametersList.value.forEach((p) => {
    if (p.name) {
      properties[p.name] = { type: p.type, description: p.name }
      if (p.required) required.push(p.name)
    }
  })
  form.value.definition.parameters = { type: 'object', properties, required }
}

const addParameter = () => {
  parametersList.value.push({ name: '', type: 'string', required: false })
}

const removeParameter = (idx) => {
  parametersList.value.splice(idx, 1)
  syncDefinitionFromParameters()
}

// NOW use them in watch
watch(() => props.tool, (newTool) => {
  if (newTool) {
    form.value = {
      name: newTool.name,
      type: newTool.implementation?.type || newTool.type || 'custom',
      active: newTool.active,
      impl: { ...form.value.impl, ...(newTool.implementation || {}) },
      definition: newTool.definition
    }
    syncParametersFromDefinition()
  }
}, { immediate: true })

watch(parametersList, () => syncDefinitionFromParameters(), { deep: true })

const handleSubmit = async (asNewVersion = false) => {
  errors.value = {}
  if (!form.value.name.trim()) errors.value.name = 'Name required'
  if (!form.value.definition.description.trim()) errors.value.description = 'Description required'
  if (!form.value.type) errors.value.type = 'Type required'
  if (Object.keys(errors.value).length > 0) return

  form.value.definition.name = form.value.name
  emit('save', {
    name: form.value.name,
    type: form.value.type,
    active: form.value.active,
    definition: form.value.definition,
    implementation: form.value.impl
  }, { asNewVersion: asNewVersion === true })
}
</script>
