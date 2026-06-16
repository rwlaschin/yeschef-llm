<!-- Multiselect chips with manual entry. `options` may be plain strings OR { value, label }
     objects (store the value, show the label — e.g. a step name shown as "name (subtype)").
     The control shows selected values as chips; clicking opens a searchable dropdown; typing a
     value that isn't an option adds it manually. v-model is a string[]. -->
<template>
  <div class="relative" :class="{ 'z-50': open }">
    <!-- Click-off backdrop: full-screen overlay at z-40 to catch outside clicks. The control and the
         dropdown panel both sit at z-50 (above this), so the cursor stays "over the menu" after opening
         — without that, this overlay paints over the static control and an immediate mouseleave fires. -->
    <div v-if="open" class="fixed inset-0 z-40" @click="open = false"></div>

    <!-- Control + dropdown are ONE hover group. `-m-2 p-2` enlarges the mouse-off catch area 0.5rem on
         every side (negative margin cancels the padding, so layout doesn't move) — brief cursor excursions
         during the open/close animation stay "over" and don't fire a premature mouseleave. The panel below
         bridges right up to the control (top-full + transparent pt-1), so there's no empty gap to cross.
         Closes when: you click off (backdrop), press Escape (search field), or move the mouse off this
         group for >1s (mouseenter cancels the timer). -->
    <div class="group -m-2 p-2" @mouseleave="scheduleClose" @mouseenter="cancelClose">
      <!-- Control: chips + chevron. `relative z-50` while open keeps it ABOVE the click-off backdrop
           (z-40) so the cursor stays over the control after opening — otherwise the backdrop paints over
           it and fires an immediate mouseleave that auto-closes the menu. -->
      <div
        class="form-input flex flex-wrap items-center gap-1.5 min-h-[2.5rem] cursor-pointer"
        :class="open ? 'relative z-50' : ''"
        @click="toggle"
      >
        <span
          v-for="chip in modelValue"
          :key="chip"
          class="inline-flex items-center gap-1 rounded-full bg-amber-500/20 text-primary px-2 py-0.5 text-xs"
          @click.stop
        >
          {{ chipLabel(chip) }}
          <button type="button" class="hover:text-white" @click.stop="removeValue(chip)">
            <XMarkIcon class="w-3 h-3" />
          </button>
        </span>
        <span v-if="!modelValue.length" class="text-muted text-sm">{{ placeholder }}</span>
        <!-- pointer-events-none: the glyph spins on open; if it could be hit-tested, the rotated box moving
             under a stationary cursor would fire a spurious mouseleave and auto-close the menu. Decorative
             only — the click handler lives on the control div. -->
        <span class="ml-auto text-xs opacity-60 transition-transform pointer-events-none" :class="open ? 'rotate-180' : ''">▼</span>
      </div>

      <!-- Dropdown. `top-full` anchors it to the control's bottom edge and the transparent `pt-1` is the
           BRIDGE — the visual gap lives inside the panel's own box (a descendant of the hover group), so
           moving from arrow → panel never leaves the group. Visible styling sits on the inner div. -->
      <div v-if="open" class="absolute top-full left-0 z-50 w-full pt-1 origin-top">
      <div class="surface-overlay rounded-lg p-1 max-h-64 overflow-auto">
        <input
          ref="search"
          v-model="query"
          type="text"
          placeholder="Search or type to add…"
          class="w-full form-input text-sm mb-1"
          @keydown.enter.prevent="enterAdd"
          @keydown.escape.prevent="open = false"
          @click.stop
        />
        <button
          v-for="opt in filtered"
          :key="optVal(opt)"
          type="button"
          class="w-full flex items-center justify-between px-2 py-1 rounded text-xs hover:bg-amber-500/20 transition"
          :class="isSelected(opt) ? 'text-primary font-medium' : 'text-secondary'"
          @click.stop="toggleOpt(opt)"
        >
          <span class="truncate">{{ optLabel(opt) }}</span>
          <CheckIcon v-if="isSelected(opt)" class="w-3.5 h-3.5 shrink-0" />
        </button>
        <button
          v-if="canAddManual"
          type="button"
          class="w-full text-left px-2 py-1 rounded text-xs text-amber-400 hover:bg-amber-500/20 transition"
          @click.stop="enterAdd"
        >+ Add "{{ query.trim() }}"</button>
        <div v-if="!filtered.length && !canAddManual" class="px-2 py-1 text-xs text-muted">No matches</div>
      </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onBeforeUnmount, watch } from 'vue'
import { XMarkIcon, CheckIcon } from '@heroicons/vue/24/solid'

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  placeholder: { type: String, default: 'Choose or type…' },
  options: { type: Array, default: () => [] }, // strings OR { value, label }
  max: { type: Number, default: 0 },           // 0 = unlimited; e.g. 1 for a chain's single source
})
const emit = defineEmits(['update:modelValue'])
const atMax = computed(() => props.max > 0 && props.modelValue.length >= props.max)

const open = ref(false)
const query = ref('')
const search = ref(null)

const optVal = (o) => (o && typeof o === 'object') ? o.value : o
const optLabel = (o) => (o && typeof o === 'object') ? o.label : String(o)
// A chip stores the value; show its option's label when there is one.
const chipLabel = (v) => { const m = props.options.find((o) => optVal(o) === v); return m ? optLabel(m) : v }

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return q ? props.options.filter((o) => optLabel(o).toLowerCase().includes(q)) : props.options
})
const isSelected = (o) => props.modelValue.includes(optVal(o))
const canAddManual = computed(() => {
  if (atMax.value) return false
  const q = query.value.trim()
  if (!q) return false
  const matches = props.options.some((o) => optLabel(o).toLowerCase() === q.toLowerCase() || String(optVal(o)).toLowerCase() === q.toLowerCase())
  return !matches && !props.modelValue.includes(q)
})

const addValue = (v) => { if (!atMax.value && !props.modelValue.includes(v)) emit('update:modelValue', [...props.modelValue, v]) }
const removeValue = (v) => emit('update:modelValue', props.modelValue.filter((x) => x !== v))
const toggleOpt = (o) => {
  const v = optVal(o)
  if (props.modelValue.includes(v)) return removeValue(v)
  if (props.max === 1) return emit('update:modelValue', [v]) // single-select: replace the current pick
  addValue(v)                                                 // guarded by atMax for max > 1
}

const enterAdd = () => {
  const q = query.value.trim()
  if (!q) return
  const m = props.options.find((o) => optLabel(o).toLowerCase() === q.toLowerCase() || String(optVal(o)).toLowerCase() === q.toLowerCase())
  addValue(m ? optVal(m) : q)
  query.value = ''
}
const toggle = () => { open.value = !open.value; if (open.value) nextTick(() => search.value?.focus()) }

// Auto-close when the mouse leaves the control+dropdown for >1s. Only armed while open, never while
// mid-typing a custom value, and ANY pending timer is cancelled the moment `open` changes — so a stale
// timer from a previous open can't slam shut a menu you've just reopened ("had to click twice").
let closeTimer = null
const cancelClose = () => { if (closeTimer) { clearTimeout(closeTimer); closeTimer = null } }
const scheduleClose = () => {
  cancelClose()
  if (!open.value || query.value.trim()) return
  closeTimer = setTimeout(() => { open.value = false }, 1000)
}
watch(open, cancelClose)
onBeforeUnmount(cancelClose)
</script>
