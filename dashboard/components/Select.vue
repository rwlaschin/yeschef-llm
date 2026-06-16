<template>
  <Listbox :model-value="modelValue" :disabled="disabled" @update:model-value="$emit('update:modelValue', $event)">
    <div class="relative">
      <!-- Theme-aware tokens (surface-2 / text-strong / border-divider) rather than a light
           default patched by `dark:` — the latter flashes near-white before the override resolves. -->
      <ListboxButton
        v-slot="{ open }"
        class="w-full px-3 py-2 text-sm rounded-lg min-h-[2.5rem] surface-2 text-strong border-divider text-left flex items-center justify-between transition-colors hover:border-gray-400 dark:hover:border-gray-600 focus:outline-none focus:ring-2 focus:ring-amber-500/40 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-divider"
      >
        <span :class="selectedLabel ? '' : 'text-muted'">{{ selectedLabel || placeholder }}</span>
        <span class="text-xs opacity-60 ml-1 transition-transform" :class="open ? 'rotate-180' : ''">▼</span>
      </ListboxButton>
      <transition
        enter-active-class="transition duration-100 ease-out" enter-from-class="opacity-0 scale-95" enter-to-class="opacity-100 scale-100"
        leave-active-class="transition duration-75 ease-in" leave-from-class="opacity-100 scale-100" leave-to-class="opacity-0 scale-95"
      >
        <ListboxOptions class="absolute z-50 w-full mt-1 surface-overlay rounded-lg p-1 space-y-0.5 max-h-60 overflow-auto origin-top">
          <div v-if="!normalizedOptions.length" class="px-2 py-1 text-xs text-muted">No options</div>
          <ListboxOption
            v-for="opt in normalizedOptions"
            :key="opt.value"
            :value="opt.value"
            v-slot="{ active, selected }"
          >
            <div :class="['px-2 py-1 rounded cursor-pointer text-xs truncate', active ? 'bg-amber-500/20' : '', selected ? 'text-primary font-medium' : 'text-secondary']">
              {{ opt.label }}
            </div>
          </ListboxOption>
        </ListboxOptions>
      </transition>
    </div>
  </Listbox>
</template>

<script setup>
import { computed } from 'vue'
import { Listbox, ListboxButton, ListboxOptions, ListboxOption } from '@headlessui/vue'

const props = defineProps({
  modelValue: [String, Number, Boolean],
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: 'Select' },
  disabled: { type: Boolean, default: false }
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
