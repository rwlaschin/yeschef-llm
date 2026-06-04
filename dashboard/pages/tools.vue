<template>
  <div class="glass p-6">
    <!-- Header: Only show when NOT editing -->
    <div v-if="!editingTool" class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-serif text-primary">LLM Tools</h1>
      <div class="flex gap-2">
        <button
          @click="showImport = true"
          class="flex items-center gap-2 px-4 py-2 bg-gray-800 text-gray-300 rounded-lg font-medium hover:bg-gray-700 transition"
        >
          <ArrowDownTrayIcon class="w-4 h-4" />
          Import
        </button>
        <button
          @click="startCreate"
          class="flex items-center gap-2 px-4 py-2 bg-amber-500 text-gray-900 rounded-lg font-medium hover:bg-amber-600 transition"
        >
          <PlusIcon class="w-4 h-4" />
          New Tool
        </button>
      </div>
    </div>

    <!-- Create/Edit Form (inline) or Tools List -->
    <template v-if="editingTool">
      <ToolForm
        :tool="editingTool"
        @save="saveTool"
        @cancel="editingTool = null"
      />
    </template>
    <template v-else>
      <!-- Tools List -->
      <ToolsList :tools="tools" @edit="editTool" @delete="deleteTool" />
    </template>

    <!-- Import Modal -->
    <ToolImport
      v-if="showImport"
      @import="importTools"
      @cancel="showImport = false"
    />

    <!-- Confirmation Dialog -->
    <ConfirmDialog ref="confirmDialog" />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ArrowDownTrayIcon, PlusIcon } from '@heroicons/vue/24/outline'
import ToolsList from '~/components/tools/ToolsList.vue'
import ToolForm from '~/components/tools/ToolForm.vue'
import ToolImport from '~/components/tools/ToolImport.vue'
import ConfirmDialog from '~/components/ConfirmDialog.vue'

const tools = ref([])
const showImport = ref(false)
const editingTool = ref(null)
const confirmDialog = ref(null)

const fetchTools = async () => {
  try {
    const response = await $fetch('/api/admin/tools')
    tools.value = response
  } catch (error) {
    console.error('Failed to fetch tools:', error)
  }
}

const startCreate = () => {
  editingTool.value = {
    name: '',
    active: false,
    definition: {
      name: '',
      description: '',
      parameters: {
        properties: {},
        required: []
      }
    }
  }
}

const editTool = (tool) => {
  editingTool.value = JSON.parse(JSON.stringify(tool))
}

const deleteTool = async (id) => {
  const confirmed = await confirmDialog.value.open({
    title: 'Delete Tool',
    message: 'Are you sure you want to delete this tool? This action cannot be undone.',
    confirmText: 'Delete',
    isDangerous: true
  })

  if (!confirmed) return

  try {
    await $fetch(`/api/admin/tool?id=${id}`, { method: 'DELETE' })
    await fetchTools()
  } catch (error) {
    console.error('Failed to delete tool:', error)
  }
}

const saveTool = async (toolData, opts = {}) => {
  try {
    const isEdit = editingTool.value && editingTool.value._id
    // "Save as new version" → POST (auto-increments version, keeps the old one)
    const updateInPlace = isEdit && !opts.asNewVersion
    const endpoint = updateInPlace ? `/api/admin/tool?id=${editingTool.value._id}` : '/api/admin/tool'
    const method = updateInPlace ? 'PUT' : 'POST'
    await $fetch(endpoint, { method, body: toolData })
    await fetchTools()
    editingTool.value = null
  } catch (error) {
    console.error('Failed to save tool:', error)
  }
}

const importTools = async (toolsList) => {
  try {
    for (const tool of toolsList) {
      await $fetch('/api/admin/tool', { method: 'POST', body: tool })
    }
    await fetchTools()
    showImport.value = false
  } catch (error) {
    console.error('Failed to import tools:', error)
  }
}

onMounted(() => {
  fetchTools()
})
</script>
