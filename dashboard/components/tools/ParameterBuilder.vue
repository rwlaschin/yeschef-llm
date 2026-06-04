<template>
  <div class="space-y-6">
    <!-- Header with Context -->
    <div>
      <h3 class="text-sm font-semibold text-gray-200 mb-2">Parameters</h3>
      <p class="text-xs text-gray-400">
        Define the inputs your tool accepts. These tell Ollama what information to send when calling this tool.
      </p>
    </div>

    <!-- Parameters List -->
    <div class="space-y-4">
      <div v-if="parameters.length === 0" class="p-4 rounded border border-dashed border-gray-600 text-center">
        <p class="text-xs text-gray-500">No parameters yet</p>
        <p class="text-xs text-gray-600 mt-1">Add parameters to define what your tool needs</p>
      </div>

      <!-- Each Parameter -->
      <div v-for="(param, idx) in parameters" :key="idx" class="p-4 rounded border border-amber-500/20 bg-amber-500/5 space-y-4">
        <!-- Name (Required) -->
        <div>
          <label class="text-xs font-semibold text-gray-300 block mb-2">
            Parameter Name <span class="text-red-400">*</span>
          </label>
          <input
            v-model="param.name"
            type="text"
            placeholder="e.g., query, ingredients, max_results"
            class="w-full px-3 py-2 rounded bg-gray-800 text-white border border-gray-700 text-xs focus:border-amber-500 focus:outline-none"
          />
          <p class="text-xs text-gray-500 mt-1">How Ollama will reference this input</p>
        </div>

        <!-- Type (Required) -->
        <div>
          <label class="text-xs font-semibold text-gray-300 block mb-2">
            Type <span class="text-red-400">*</span>
          </label>
          <select
            v-model="param.type"
            class="w-full px-3 py-2 rounded bg-gray-800 text-white border border-gray-700 text-xs focus:border-amber-500 focus:outline-none"
          >
            <option value="string">string — Text input</option>
            <option value="number">number — Decimal numbers</option>
            <option value="integer">integer — Whole numbers only</option>
            <option value="boolean">boolean — True/False</option>
            <option value="array">array — List of items</option>
          </select>
        </div>

        <!-- Description (Required) -->
        <div>
          <label class="text-xs font-semibold text-gray-300 block mb-2">
            Description <span class="text-red-400">*</span>
          </label>
          <textarea
            v-model="param.description"
            placeholder="Explain what this parameter is for. Ollama uses this to decide when to send it."
            class="w-full px-3 py-2 rounded bg-gray-800 text-white border border-gray-700 text-xs focus:border-amber-500 focus:outline-none resize-none"
            rows="3"
          />
          <p class="text-xs text-gray-500 mt-1">Be clear and specific so Ollama knows when to use this</p>
        </div>

        <!-- Required Checkbox -->
        <div class="flex items-start gap-3 p-3 rounded bg-gray-800/50">
          <input
            :id="`required-${idx}`"
            v-model="param.required"
            type="checkbox"
            class="w-4 h-4 rounded border-gray-600 bg-gray-900 mt-1 cursor-pointer"
          />
          <div>
            <label :for="`required-${idx}`" class="text-xs font-semibold text-gray-300 cursor-pointer block">
              Required
            </label>
            <p class="text-xs text-gray-500 mt-1">
              {{ param.required ? 'Ollama must provide this' : 'Ollama can skip this if not needed' }}
            </p>
          </div>
        </div>

        <!-- Remove Button -->
        <button
          type="button"
          @click="removeParameter(idx)"
          class="text-xs text-red-400 hover:text-red-300 transition font-medium"
        >
          ✕ Remove Parameter
        </button>
      </div>
    </div>

    <!-- Add Parameter Button -->
    <button
      type="button"
      @click="addParameter"
      class="w-full px-4 py-3 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 transition border border-gray-700 text-sm font-medium"
    >
      + Add Parameter
    </button>

    <!-- Error -->
    <div v-if="errors.parameters" class="p-3 rounded bg-red-900/30 border border-red-700 text-red-200 text-xs">
      {{ errors.parameters }}
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'

const props = defineProps({
  modelValue: {
    type: Object,
    required: true
  },
  errors: {
    type: Object,
    default: () => ({})
  }
})

const emit = defineEmits(['update:modelValue'])

const parameters = ref([])

// Initialize from modelValue
watch(
  () => props.modelValue,
  (newVal) => {
    if (newVal && newVal.properties) {
      parameters.value = Object.entries(newVal.properties).map(([name, prop]) => ({
        name,
        type: prop.type,
        description: prop.description,
        required: newVal.required?.includes(name) || false
      }))
    }
  },
  { immediate: true }
)

// Watch for changes and emit
watch(
  parameters,
  () => {
    const properties = {}
    const required = []

    parameters.value.forEach((param) => {
      if (param.name) {
        properties[param.name] = {
          type: param.type,
          description: param.description
        }
        if (param.required) {
          required.push(param.name)
        }
      }
    })

    emit('update:modelValue', {
      type: 'object',
      properties,
      required
    })
  },
  { deep: true }
)

const addParameter = () => {
  parameters.value.push({
    name: '',
    type: 'string',
    description: '',
    required: false
  })
}

const removeParameter = (idx) => {
  parameters.value.splice(idx, 1)
}
</script>
