<template>
  <div class="glass h-full flex flex-col p-3 gap-2">
    <!-- Controls -->
    <div class="flex flex-wrap items-center gap-1.5">
      <!-- A native select inherits the OS palette and renders light-on-light in this dark theme,
           so: appearance-none plus explicit colours — and on the options too, which macOS styles
           separately from the closed control. -->
      <div class="relative">
        <select
          v-model="source"
          aria-label="Log source"
          class="appearance-none bg-slate-900/80 text-slate-100 border border-slate-600/60 pl-2.5 pr-7 py-1 rounded-md text-[11px] font-mono focus:outline-none focus:ring-2 focus:ring-amber-500"
        >
          <option v-for="s in sources" :key="s" :value="s" class="bg-slate-900 text-slate-100">{{ s }}</option>
        </select>
        <span class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-[10px]">▼</span>
      </div>

      <!-- Cumulative level filter (WRN shows warn+error) — how a tail is actually read. -->
      <div class="flex rounded-lg overflow-hidden border border-slate-600/60">
        <button
          v-for="l in LEVELS"
          :key="l.min"
          @click="minLevel = l.min"
          :class="[
            'px-2 py-1 text-[10px] font-mono transition',
            minLevel === l.min ? 'bg-amber-500/90 text-slate-900 font-bold' : 'bg-slate-900/60 text-slate-400 hover:text-slate-100',
          ]"
        >{{ l.label }}</button>
      </div>

      <input
        v-model="searchQuery"
        type="text"
        placeholder="filter…"
        class="flex-1 min-w-[8rem] bg-slate-900/80 text-slate-100 placeholder-slate-500 border border-slate-600/60
               px-2.5 py-1 rounded-md text-[11px] font-mono focus:outline-none focus:ring-2 focus:ring-amber-500"
      />

      <button
        @click="tailing = !tailing"
        :class="[
          'px-2 py-1 rounded-md text-[10px] font-mono border transition flex items-center gap-1.5',
          tailing ? 'bg-emerald-500/15 border-emerald-500/60 text-emerald-300' : 'bg-slate-900/60 border-slate-600/60 text-slate-400',
        ]"
        :title="tailing ? 'Following new lines — scroll up to pause' : 'Paused'"
      >
        <span :class="['w-1.5 h-1.5 rounded-full', tailing ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500']" />
        {{ tailing ? 'Live' : 'Paused' }}
      </button>

      <button
        @click="clearLogs"
        class="px-2 py-1 rounded-md text-[10px] font-mono bg-slate-900/60 border border-slate-600/60 text-slate-400 hover:text-slate-100 transition"
      >Clear</button>
    </div>

    <!-- Log rows -->
    <div
      ref="scroller"
      @scroll="onScroll"
      class="flex-1 overflow-y-auto rounded-lg bg-slate-950/50 border border-slate-700/40 font-mono text-[11px] leading-[1.45]"
    >
      <div v-if="!filteredLogs.length" class="text-center py-8 text-slate-500 text-xs">
        {{ logs.length ? 'No lines match' : 'No logs yet' }}
      </div>

      <div
        v-for="log in filteredLogs"
        :key="log.seq"
        class="group flex gap-1.5 px-2 border-l-2 hover:bg-slate-800/40 transition-colors"
        :class="levelBorder(log.level)"
      >
        <span class="text-slate-600 shrink-0 tabular-nums">{{ formatTime(log.timestamp) }}</span>
        <span
          v-if="source === ALL_SOURCE"
          class="shrink-0 w-[4.25rem] truncate font-semibold"
          :style="{ color: componentColor(log.module) }"
          :title="log.module"
        >{{ log.module }}</span>
        <span :class="['shrink-0 w-7 font-semibold', levelText(log.level)]">{{ getLevelName(log.level) }}</span>
        <!-- v-html is safe here: ansiHtml() HTML-escapes the text BEFORE inserting markup, and the
             only tags it ever emits are its own <span style="color:…">. -->
        <span class="whitespace-pre-wrap break-all text-slate-200" v-html="ansiHtml(log)" />
      </div>
    </div>

    <!-- Status bar -->
    <div class="flex items-center justify-between text-[10px] font-mono text-slate-500">
      <span>
        {{ matching.length }} / {{ logs.length }} lines
        <span v-if="hiddenCount" class="opacity-60">· showing last {{ filteredLogs.length }}</span>
      </span>
      <span v-if="source !== LOCAL_SOURCE" class="flex items-center gap-1.5">
        <span :class="['w-1.5 h-1.5 rounded-full', connected ? 'bg-emerald-400' : 'bg-red-400']" />
        {{ connected ? 'streaming' : 'collector offline' }}
      </span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'

const LEVELS = [
  { label: 'ALL', min: 0 },
  { label: 'INF', min: 30 },
  { label: 'WRN', min: 40 },
  { label: 'ERR', min: 50 },
]

const { sources } = useLogdSources()
const source = ref(ALL_SOURCE)
const { logs, clearLogs: clearLogsOrig, connected } = useLogs(source)
const { success } = useToast()

const searchQuery = ref('')
const minLevel = ref(0)
const tailing = ref(true)
const scroller = ref(null)

const clearLogs = () => {
  clearLogsOrig()
  success('Logs cleared')
}

// Only the tail is rendered. Holding 1000 lines is cheap; mounting 1000 DOM rows and re-rendering
// them on every frame is not — that is what pinned the main thread.
const RENDER_CAP = 300

const matching = computed(() => {
  const q = searchQuery.value.toLowerCase()
  return logs.value.filter(
    (l) => l.level >= minLevel.value && (!q || l.msg?.toLowerCase().includes(q) || l.module?.toLowerCase().includes(q)),
  )
})
const filteredLogs = computed(() => {
  const m = matching.value
  return m.length > RENDER_CAP ? m.slice(-RENDER_CAP) : m
})
const hiddenCount = computed(() => Math.max(0, matching.value.length - filteredLogs.value.length))

// Follow the tail, but never yank the view while someone reads history: scrolling away from the
// bottom pauses, returning to it resumes.
const onScroll = () => {
  const el = scroller.value
  if (!el) return
  tailing.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

watch([filteredLogs, tailing], async () => {
  if (!tailing.value) return
  await nextTick()
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
})

// ── ANSI → HTML ──────────────────────────────────────────────────────────────────────────────
// logd keeps the original terminal output in `raw` (colour codes intact) alongside an escape-free
// `msg` used for search. Render `raw` so `next dev`'s green ✓ and red ⨯ survive the trip.
// Tuned for a dark ground: the standard 30–37 codes are too dim, so the bright variants are used.
const SGR = {
  30: '#64748b', 31: '#f87171', 32: '#4ade80', 33: '#fbbf24',
  34: '#60a5fa', 35: '#c084fc', 36: '#22d3ee', 37: '#e2e8f0',
  90: '#64748b', 91: '#fca5a5', 92: '#86efac', 93: '#fcd34d',
  94: '#93c5fd', 95: '#d8b4fe', 96: '#67e8f9', 97: '#f8fafc',
}
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

const ansiHtml = (log) => {
  const src = log.raw ?? log.msg ?? ''
  if (!log.raw) return esc(src)                       // nothing to colour
  let out = ''
  let open = 0
  let last = 0
  // Only SGR (…m) is styled; every other escape is dropped, never printed.
  const re = /\u001b\[([0-9;]*)m|\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g
  let m
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index))
    last = re.lastIndex
    if (m[1] === undefined) continue                  // non-SGR escape — swallow it
    for (const part of (m[1] || '0').split(';')) {
      const code = Number(part || 0)
      if (code === 0 || code === 39) { out += '</span>'.repeat(open); open = 0 }
      else if (code === 1) { out += '<span style="font-weight:700">'; open++ }
      else if (code === 22) { if (open) { out += '</span>'; open-- } }
      else if (SGR[code]) { out += `<span style="color:${SGR[code]}">`; open++ }
    }
  }
  return out + esc(src.slice(last)) + '</span>'.repeat(open)
}

const getLevelName = (level) => ({ 10: 'TRC', 20: 'DBG', 30: 'INF', 40: 'WRN', 50: 'ERR', 60: 'FAT' }[level] || 'LOG')

const levelText = (level) =>
  level >= 50 ? 'text-red-400' : level === 40 ? 'text-amber-400' : level <= 20 ? 'text-slate-500' : 'text-sky-400'

const levelBorder = (level) =>
  level >= 50 ? 'border-red-500/70' : level === 40 ? 'border-amber-500/70' : 'border-transparent'

// Stable colour per component so the eye can group rows in the All view without a legend.
const componentColor = (name) => {
  let h = 0
  for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return `hsl(${h}, 65%, 68%)`
}

const formatTime = (ts) => {
  const d = new Date(ts)
  return isNaN(d.getTime()) ? '--:--:--' : d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}
</script>
