<template>
  <Listbox :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
    <div class="relative">
      <ListboxButton class="w-full px-2 py-1 text-xs rounded bg-gray-800 text-white border border-gray-700 text-left flex items-center justify-between focus:border-amber-500 focus:outline-none">
        <span :class="selectedLabel ? '' : 'text-gray-500'">{{ selectedLabel || placeholder }}</span>
        <span class="text-xs opacity-60 ml-1">▼</span>
      </ListboxButton>
      <ListboxOptions class="absolute z-50 w-full mt-1 rounded-lg p-1 space-y-0.5 bg-gray-950 border border-gray-700/60 shadow-xl max-h-60 overflow-auto">
        <ListboxOption
          v-for="opt in normalizedOptions"
          :key="opt.value"
          :value="opt.value"
          v-slot="{ active, selected }"
        >
          <div :class="['px-2 py-1 rounded cursor-pointer text-xs', active ? 'bg-amber-500/20' : '', selected ? 'text-primary font-medium' : 'text-gray-200']">
            {{ opt.label }}
          </div>
        </ListboxOption>
      </ListboxOptions>
    </div>
  </Listbox>
</template>

<script setup>
import { computed } from 'vue'
import { Listbox, ListboxButton, ListboxOptions, ListboxOption } from '@headlessui/vue'

const props = defineProps({
  modelValue: [String, Number, Boolean],
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: 'Select' }
})

defineEmits(['update:modelValue'])

// Allow options as strings or {value, label}
const normalizedOptions = computed(() =>
  props.options.map(opt =>
    typeof opt === 'object' ? opt : { value: opt, label: opt }
  )
)

const selectedLabel = computed(() => {
  const match = normalizedOptions.value.find(o => o.value === props.modelValue)
  return match?.label || ''
})
</script>
