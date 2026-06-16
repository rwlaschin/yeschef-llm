<!-- Renders a blob of prompt/message text as collapsible sections, split on markdown headers
     (# … ######). Any text before the first header is shown as an un-headed intro. Used by the
     Message and Prompt tabs so a long assembled prompt becomes a navigable outline. -->
<template>
  <div class="space-y-0.5">
    <div v-for="s in sections" :key="s.id">
      <pre v-if="!s.header" class="text-xs whitespace-pre-wrap break-words font-mono opacity-90 m-0">{{ s.body }}</pre>
      <template v-else>
        <button type="button" @click="toggle(s.id)"
          class="w-full flex items-center gap-1.5 text-left text-xs font-mono text-amber-500/80 hover:text-amber-500 py-0.5 transition-colors">
          <ChevronRightIcon class="w-3.5 h-3.5 shrink-0 transition-transform" :class="isOpen(s.id) ? 'rotate-90' : ''" />
          <span class="truncate font-medium">{{ s.header }}</span>
          <span v-if="!isOpen(s.id)" class="text-gray-500 shrink-0">· {{ s.lines }} line{{ s.lines === 1 ? '' : 's' }}</span>
        </button>
        <pre v-show="isOpen(s.id)" class="text-xs whitespace-pre-wrap break-words font-mono opacity-90 pl-5 m-0">{{ s.body }}</pre>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive } from 'vue'
import { ChevronRightIcon } from '@heroicons/vue/24/outline'

const props = defineProps({ text: { type: String, default: '' } })

// Split into sections at any markdown header line; the leading run (before the first header) is a
// header-less intro section.
const sections = computed(() => {
  const out = []
  let cur = { header: null, body: [] }
  const flush = () => {
    const body = cur.body.join('\n').replace(/^\n+|\n+$/g, '')
    if (cur.header || body) out.push({ id: out.length, header: cur.header, body, lines: body ? body.split('\n').length : 0 })
  }
  for (const ln of (props.text || '').split('\n')) {
    if (/^#{1,6}\s+/.test(ln)) { flush(); cur = { header: ln.replace(/^#{1,6}\s+/, '').trim(), body: [] } }
    else cur.body.push(ln)
  }
  flush()
  return out
})

// Sections start EXPANDED (you see everything, same as before) — clicking a header collapses it.
const open = reactive({})
const isOpen = (id) => open[id] !== false
const toggle = (id) => { open[id] = !isOpen(id) }
</script>
