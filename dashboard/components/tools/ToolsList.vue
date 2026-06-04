<template>
  <div class="tools-list space-y-4">
    <div v-if="!tools || tools.length === 0" class="text-center py-12 text-gray-400">
      No tools found
    </div>

    <!-- Tool Cards by Name (hidden when detail view is open) -->
    <div v-else class="space-y-4">
      <div v-if="!selectedTool" class="space-y-4">
      <div
        v-for="toolName in toolNamesList"
        :key="toolName"
        @click="selectedTool = selectedTool?.definition.name === toolName ? null : getCardTool(toolName)"
        class="border border-amber-500/20 rounded-lg p-4 bg-gradient-to-br from-amber-500/5 to-transparent hover:border-amber-500/40 transition cursor-pointer max-w-2xl"
        :class="selectedTool?.definition.name === toolName ? 'border-amber-500' : ''"
      >
        <!-- Header with Version Tabs -->
        <div class="flex items-start justify-between mb-4">
          <div class="flex-1">
            <h3 class="font-serif text-lg text-primary">{{ toolName }}</h3>

            <!-- Version Tabs -->
            <div class="flex gap-2 mt-3 flex-wrap">
              <button
                v-for="version in toolsByName[toolName]"
                :key="version._id"
                @click.stop="selectedTool = version"
                :class="[
                  'px-2 py-1 text-xs rounded font-medium transition',
                  version.active
                    ? 'bg-emerald-900/30 text-emerald-400'
                    : 'bg-gray-700/40 text-gray-400 hover:bg-gray-700/60',
                  selectedTool?._id === version._id ? 'ring-2 ring-amber-500' : ''
                ]"
              >
                v{{ version.version }}
              </button>
            </div>
          </div>

          <!-- Status Badge -->
          <button
            @click.stop="toggleActive(getCardTool(toolName))"
            :class="[
              'px-2.5 py-1 text-xs rounded font-medium whitespace-nowrap transition cursor-pointer hover:opacity-80',
              getCardTool(toolName).active
                ? 'bg-emerald-900/30 text-emerald-400'
                : 'bg-gray-700/40 text-gray-400 hover:bg-gray-700/60'
            ]"
            :title="`Click to ${getCardTool(toolName).active ? 'deactivate' : 'activate'}`"
          >
            {{ getCardTool(toolName).active ? 'Active' : 'Inactive' }}
          </button>
        </div>

        <!-- Description (collapsed view) -->
        <p class="text-sm text-gray-300 mb-4">{{ getCardTool(toolName).definition.description }}</p>

        <!-- Parameters (collapsed view) -->
        <div class="mb-4 space-y-2">
          <div v-if="getCardTool(toolName).definition.parameters.properties && Object.keys(getCardTool(toolName).definition.parameters.properties).length > 0">
            <p class="text-xs font-medium text-gray-400 mb-2">Parameters:</p>
            <div class="space-y-1">
              <div v-for="(param, key) in getCardTool(toolName).definition.parameters.properties" :key="key" class="text-xs text-gray-500">
                <span :class="getCardTool(toolName).definition.parameters.required.includes(key) ? 'font-semibold text-amber-400' : ''">
                  {{ key }}
                </span>
                <span class="text-gray-600">({{ param.type }})</span>
                <span v-if="getCardTool(toolName).definition.parameters.required.includes(key)" class="text-amber-400 ml-1">*</span>
              </div>
            </div>
          </div>
          <div v-else class="text-xs text-gray-500">No parameters</div>
        </div>

        <!-- Actions (Edit/Delete) -->
        <div class="flex gap-2 pt-2 border-t border-amber-500/10">
          <button
            @click.stop="$emit('edit', getCardTool(toolName))"
            class="flex-1 flex items-center justify-center px-3 py-2 rounded bg-amber-500 text-gray-900 hover:bg-amber-600 transition"
            title="Edit tool"
          >
            <PencilIcon class="w-5 h-5" />
          </button>
          <button
            @click.stop="$emit('delete', getCardTool(toolName)._id)"
            :disabled="getCardTool(toolName).active"
            class="flex-1 flex items-center justify-center px-3 py-2 rounded transition border"
            :class="getCardTool(toolName).active
              ? 'bg-gray-700/20 text-gray-500 cursor-not-allowed border-gray-700/20'
              : 'bg-red-900/30 text-red-400 hover:bg-red-900/50 border-red-900/30'"
            :title="getCardTool(toolName).active ? 'Cannot delete active tools' : 'Delete tool'"
          >
            <TrashIcon class="w-5 h-5" />
          </button>
        </div>
      </div>
      </div>

      <!-- Detail View (Expanded) - replaces card list -->
      <div v-else class="border border-amber-500/30 rounded-lg p-6 bg-amber-500/5">
        <div class="flex justify-between items-start mb-6">
          <div>
            <h2 class="font-serif text-2xl text-primary">{{ selectedTool.definition.name }}</h2>
            <p class="text-sm text-gray-400 mt-2">v{{ selectedTool.version }} • {{ selectedTool.active ? 'Active' : 'Inactive' }}</p>
          </div>
          <button
            @click="selectedTool = null"
            class="text-gray-400 hover:text-white transition"
          >
            ✕
          </button>
        </div>

        <!-- Status Badge -->
        <div class="mb-6">
          <button
            @click="toggleActive(selectedTool)"
            :class="[
              'px-3 py-1 text-sm rounded font-medium transition cursor-pointer hover:opacity-80',
              selectedTool.active
                ? 'bg-emerald-900/30 text-emerald-400'
                : 'bg-gray-700/40 text-gray-400 hover:bg-gray-700/60'
            ]"
          >
            {{ selectedTool.active ? 'Active' : 'Inactive' }}
          </button>
        </div>

        <!-- Description -->
        <div class="mb-6">
          <h3 class="text-xs font-semibold text-gray-400 uppercase mb-2">Description</h3>
          <p class="text-gray-300">{{ selectedTool.definition.description }}</p>
        </div>

        <!-- Parameters -->
        <div class="mb-6">
          <h3 class="text-xs font-semibold text-gray-400 uppercase mb-3">Parameters</h3>
          <div v-if="selectedTool.definition.parameters.properties && Object.keys(selectedTool.definition.parameters.properties).length > 0" class="space-y-4">
            <div v-for="(param, key) in selectedTool.definition.parameters.properties" :key="key" class="p-3 bg-gray-800/40 rounded border border-gray-700">
              <div class="flex items-center gap-2 mb-2">
                <span class="font-mono font-semibold text-amber-400">{{ key }}</span>
                <span class="text-xs text-gray-500">{{ param.type }}</span>
                <span v-if="selectedTool.definition.parameters.required.includes(key)" class="text-xs text-red-400 font-semibold">required</span>
              </div>
              <p v-if="param.description" class="text-xs text-gray-400">{{ param.description }}</p>
            </div>
          </div>
          <div v-else class="text-sm text-gray-500">No parameters</div>
        </div>

        <!-- Raw Definition -->
        <div class="mb-6">
          <h3 class="text-xs font-semibold text-gray-400 uppercase mb-2">Definition (JSON)</h3>
          <pre class="bg-gray-800/40 border border-gray-700 rounded p-3 overflow-x-auto text-xs text-gray-300 font-mono">{{ JSON.stringify(selectedTool.definition, null, 2) }}</pre>
        </div>

        <!-- Actions -->
        <div class="flex gap-2 pt-4 border-t border-amber-500/10">
          <button
            @click="$emit('edit', selectedTool)"
            class="flex-1 flex items-center justify-center px-4 py-2 rounded bg-amber-500 text-gray-900 hover:bg-amber-600 transition font-medium"
          >
            <PencilIcon class="w-4 h-4 mr-2" />
            Edit
          </button>
          <button
            @click="$emit('delete', selectedTool._id)"
            :disabled="selectedTool.active"
            class="flex-1 flex items-center justify-center px-4 py-2 rounded transition font-medium border"
            :class="selectedTool.active
              ? 'bg-gray-700/20 text-gray-500 cursor-not-allowed border-gray-700/20'
              : 'bg-red-900/30 text-red-400 hover:bg-red-900/50 border-red-900/30'"
          >
            <TrashIcon class="w-4 h-4 mr-2" />
            Delete
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { PencilIcon, TrashIcon } from '@heroicons/vue/24/outline'

const props = defineProps({
  tools: {
    type: Array,
    default: () => []
  }
})

defineEmits(['edit', 'delete'])

const selectedTool = ref(null)

// Group tools by name, sorted by version descending
const toolsByName = computed(() => {
  const groups = {}
  props.tools.forEach(tool => {
    const name = tool.definition.name
    if (!groups[name]) {
      groups[name] = []
    }
    groups[name].push(tool)
  })

  // Sort each group by version descending
  Object.keys(groups).forEach(name => {
    groups[name].sort((a, b) => b.version - a.version)
  })

  return groups
})

// Get unique tool names sorted
const toolNamesList = computed(() => {
  return Object.keys(toolsByName.value).sort()
})

// Get the active version for a specific tool name (for card display)
const getCardTool = (toolName) => {
  const versions = toolsByName.value[toolName]
  if (!versions || versions.length === 0) return null
  return versions.find(v => v.active) || versions[0]
}

// Get the latest active or first version for detail view
const currentTool = computed(() => {
  if (!selectedTool.value) return null
  const name = selectedTool.value.definition.name
  const versions = toolsByName.value[name]
  // Find active version, or use first (latest)
  return versions.find(v => v.active) || versions[0]
})

const toggleActive = async (tool) => {
  try {
    await $fetch(`/api/admin/tool?id=${tool._id}`, {
      method: 'PUT',
      body: {
        name: tool.name,
        active: !tool.active,
        definition: tool.definition
      }
    })
    tool.active = !tool.active
  } catch (error) {
    console.error('Failed to toggle active status:', error)
  }
}
</script>
