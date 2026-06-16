<!-- Searchable single-select (headlessui Combobox). Same API as Select.vue ({modelValue, options,
     placeholder}) but type-to-filter — use when the list is long (e.g. ~400 timezones). The full
     list renders in a scrollable popover; typing narrows it. No cap (hiding rows hurts discovery). -->
<template>
  <Combobox :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
    <div class="relative">
      <div class="w-full rounded-lg min-h-[2.5rem] surface-2 border-divider flex items-center transition-colors hover:border-gray-400 dark:hover:border-gray-600 focus-within:ring-2 focus-within:ring-amber-500/40">
        <ComboboxInput
          class="w-full px-3 py-2 text-sm bg-transparent text-strong outline-none"
          :display-value="(v) => labelFor(v)"
          :placeholder="placeholder"
          @change="query = $event.target.value"
        />
        <ComboboxButton class="px-2 text-xs opacity-60">▼</ComboboxButton>
      </div>
      <transition
        leave-active-class="transition duration-75 ease-in" leave-from-class="opacity-100" leave-to-class="opacity-0"
        @after-leave="query = ''"
      >
        <ComboboxOptions class="absolute z-50 w-full mt-1 surface-overlay rounded-lg p-1 space-y-0.5 max-h-72 overflow-auto origin-top">
          <div v-if="!filtered.length" class="px-2 py-1 text-xs text-muted">No matches</div>
          <template v-for="g in grouped" :key="g.name">
            <!-- Region header (only when not searching, and only if options carry a `group`). -->
            <div v-if="g.name" class="px-2 pt-2 pb-0.5 text-[10px] uppercase tracking-wide text-muted sticky top-0 surface-overlay">{{ g.name }}</div>
            <ComboboxOption v-for="opt in g.items" :key="opt.value" :value="opt.value" v-slot="{ active, selected }">
              <div :class="['px-2 py-1 rounded cursor-pointer text-xs truncate', active ? 'bg-amber-500/20' : '', selected ? 'text-primary font-medium' : 'text-secondary']">
                {{ opt.label }}
              </div>
            </ComboboxOption>
          </template>
        </ComboboxOptions>
      </transition>
    </div>
  </Combobox>
</template>

<script setup>
import { ref, computed } from 'vue'
import { Combobox, ComboboxInput, ComboboxButton, ComboboxOptions, ComboboxOption } from '@headlessui/vue'

const props = defineProps({
  modelValue: [String, Number],
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: 'Search…' },
})
defineEmits(['update:modelValue'])

const query = ref('')
const normalized = computed(() => props.options.map((o) => (typeof o === 'object' ? o : { value: o, label: String(o) })))
// Full list renders and scrolls — no cap. Search just narrows it. A few hundred rows is nothing;
// hiding the rest behind an invisible cap was the discoverability bug.
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return q ? normalized.value.filter((o) => o.label.toLowerCase().includes(q)) : normalized.value
})
// Group by each option's `group` (in first-seen order) when browsing; while searching, one flat
// list so results aren't scattered under headers. Options with no `group` render ungrouped.
const grouped = computed(() => {
  if (query.value.trim()) return [{ name: '', items: filtered.value }]
  const order = [], map = new Map()
  for (const o of filtered.value) {
    const g = o.group || ''
    if (!map.has(g)) { map.set(g, []); order.push(g) }
    map.get(g).push(o)
  }
  return order.map((name) => ({ name, items: map.get(name) }))
})
const labelFor = (v) => normalized.value.find((o) => o.value === v)?.label || ''
</script>
