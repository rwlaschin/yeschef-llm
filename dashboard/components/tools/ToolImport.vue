<template>
  <Teleport to="body">
    <div class="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div class="glass p-6 rounded-lg max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
      <!-- Header -->
      <div class="flex justify-between items-center mb-6 pb-4 border-b border-gray-200 dark:border-gray-700">
        <h2 class="text-xl font-serif text-primary">Import Tools</h2>
        <button @click="$emit('cancel')" class="p-1 text-muted hover:text-strong hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition">
          <XMarkIcon class="w-6 h-6" />
        </button>
      </div>

      <div class="space-y-6">
        <!-- Method 1: Paste JSON -->
        <div class="space-y-3">
          <h3 class="text-sm font-semibold text-secondary">Method 1: Paste JSON</h3>
          <textarea
            v-model="jsonInput"
            class="w-full px-3 py-2 rounded bg-gray-100 text-gray-900 border border-gray-300 dark:bg-gray-800 dark:text-white dark:border-gray-700 focus:border-amber-500 focus:outline-none font-mono text-xs min-h-40"
            placeholder="[{&quot;name&quot;:&quot;search_recipes&quot;,&quot;active&quot;:true,&quot;definition&quot;:{...}}]"
          />
        </div>

        <!-- Divider -->
        <div class="relative">
          <div class="absolute inset-0 flex items-center">
            <div class="w-full border-t border-gray-200 dark:border-gray-700"></div>
          </div>
          <div class="relative flex justify-center text-sm">
            <span class="px-2 bg-white dark:bg-gray-950 text-gray-500">or</span>
          </div>
        </div>

        <!-- Method 2: File Upload -->
        <div class="space-y-3">
          <h3 class="text-sm font-semibold text-secondary">Method 2: Upload File</h3>
          <div class="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-8 text-center hover:border-amber-500 transition cursor-pointer" @click="triggerFileInput">
            <input
              ref="fileInput"
              type="file"
              accept=".json"
              style="display: none"
              @change="handleFileUpload"
            />
            <DocumentArrowDownIcon class="w-8 h-8 mx-auto mb-3 text-gray-400" />
            <p class="text-secondary text-sm">Click to select file or drag and drop</p>
            <p class="text-xs text-gray-500 mt-2">.json files only</p>
          </div>
        </div>

        <!-- Error Message -->
        <div v-if="error" class="p-3 rounded bg-red-900/30 border border-red-700 text-red-200 text-sm">
          <strong>Error:</strong> {{ error }}
        </div>

        <!-- Preview -->
        <div v-if="preview && preview.length > 0" class="p-4 rounded bg-green-900/20 border border-green-700/50">
          <div class="flex items-center gap-2 mb-2">
            <div class="w-2 h-2 rounded-full bg-green-400"></div>
            <span class="text-sm font-medium text-green-300">Ready to import: {{ preview.length }} tool(s)</span>
          </div>
          <ul class="mt-3 space-y-1 text-xs text-green-200">
            <li v-for="tool in preview" :key="tool.name || tool.definition.name" class="ml-4">
              {{ tool.name || tool.definition.name }}
            </li>
          </ul>
        </div>

        <!-- Action Buttons -->
        <div class="flex gap-3 justify-end pt-2">
          <button
            type="button"
            @click="$emit('cancel')"
            class="px-4 py-2 rounded btn-muted transition font-medium"
          >
            Cancel
          </button>
          <button
            type="button"
            @click="handleImport"
            :disabled="!preview || preview.length === 0"
            class="px-4 py-2 rounded bg-amber-500 text-gray-900 font-medium hover:bg-amber-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Import {{ preview ? preview.length : 0 }} Tool(s)
          </button>
        </div>
      </div>
    </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, watch } from 'vue'
import { XMarkIcon, DocumentArrowDownIcon } from '@heroicons/vue/24/outline'

const emit = defineEmits(['import', 'cancel'])

const jsonInput = ref('')
const fileInput = ref(null)
const error = ref('')
const preview = ref(null)

// Auto-preview when JSON is pasted
watch(jsonInput, () => {
  parseAndPreview()
})

const triggerFileInput = () => {
  fileInput.value.click()
}

const handleFileUpload = (event) => {
  const file = event.target.files[0]
  if (!file) return

  const reader = new FileReader()
  reader.onload = (e) => {
    jsonInput.value = e.target.result
    parseAndPreview()
  }
  reader.readAsText(file)
}

const parseAndPreview = () => {
  error.value = ''
  preview.value = null

  if (!jsonInput.value.trim()) {
    error.value = 'Please paste or upload JSON'
    return
  }

  try {
    const parsed = JSON.parse(jsonInput.value)

    if (!Array.isArray(parsed)) {
      error.value = 'JSON must be an array of tools'
      return
    }

    if (parsed.length === 0) {
      error.value = 'Array must contain at least one tool'
      return
    }

    // Basic validation: each item should have active and definition
    for (const tool of parsed) {
      if (typeof tool.active !== 'boolean') {
        error.value = 'Each tool must have an "active" boolean property'
        return
      }
      if (!tool.definition || !tool.definition.name) {
        error.value = 'Each tool must have a "definition" with a "name" property'
        return
      }
      // Add top-level name if missing (for backward compatibility)
      if (!tool.name) {
        tool.name = tool.definition.name
      }
    }

    preview.value = parsed
  } catch (e) {
    error.value = `Invalid JSON: ${e.message}`
  }
}

const handleImport = () => {
  if (preview.value && preview.value.length > 0) {
    emit('import', preview.value)
  }
}
</script>
