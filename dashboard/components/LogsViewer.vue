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
        {{ bucket ? `No lines in ${bucketLabel}` : logs.length ? 'No lines match' : 'No logs yet' }}
      </div>

      <!-- Highlight is emphasis, not a filter. No ring/border: an inset ring on every matched row drew a
           box around each line and the text underneath became the hardest thing on screen to read. The
           signal is carried by RECEDING the rest instead — unmatched rows drop to 25% and desaturate, so
           the matched lines are the only fully legible thing without altering them at all. -->
      <div
        v-for="log in filteredLogs"
        :key="log.seq"
        class="group flex gap-1.5 px-2 border-l-2 hover:bg-slate-800/40 transition-colors"
        :class="isHighlighted ? (isHighlighted(log) ? '' : 'opacity-25 saturate-0') : ''"
        :style="{ borderLeftColor: log.level >= 40 ? levelBar(log.level) : 'transparent' }"
      >
        <span class="text-slate-600 shrink-0 tabular-nums">{{ formatTime(log.timestamp) }}</span>
        <!-- The module name keeps its colour — that IS the colour coding, and dropping it to a grey
             token left the list unreadable at a glance. -->
        <span
          v-if="showModule"
          class="shrink-0 truncate font-semibold w-[5rem]"
          :title="log.module"
          :style="{ color: componentColor(log.module) }"
        >{{ log.module }}</span>
        <!-- Every level keeps its colour so severity is readable, but only WRN/ERR get weight: a level
             that is 99% of the rows should not shout as loudly as the exceptions. -->
        <span
          :class="['shrink-0 w-7', log.level >= 40 ? 'font-semibold' : 'opacity-70']"
          :style="{ color: levelColor(log.level) }"
        >{{ getLevelName(log.level) }}</span>
        <!-- v-html is safe here: ansiHtml() HTML-escapes the text BEFORE inserting markup, and the
             only tags it or tagHtml() ever emit are their own <span style="color:…">. tagHtml runs on
             already-escaped output, so a `[tag]` can never carry markup back in. -->
        <span class="whitespace-pre-wrap break-all text-slate-200" v-html="messageHtml(log)" />
      </div>
    </div>

    <!-- Below the rows, where it has always been. Driven off `matching`, so it tracks source, level and
         search; hands back a picked time bucket (which narrows the rows) and a hover payload (which
         only highlights them). -->
    <LogHistogram :lines="matching" @select="bucket = $event" @highlight="highlight = $event" />

    <!-- Status bar -->
    <div class="flex items-center justify-between text-[10px] font-mono text-slate-500">
      <span>
        {{ selected.length }} / {{ logs.length }} lines
        <span v-if="bucket" class="text-amber-300">· bucket {{ bucketLabel }}</span>
        <span v-if="hiddenCount" class="opacity-60">· showing last {{ filteredLogs.length }}</span>
      </span>
      <!-- ClientOnly: this label depends on the env toggle, which hydrates from localStorage AFTER the
           server render — so SSR said "collector offline" (env defaults to local) and the client then
           said "unreachable", a guaranteed hydration mismatch. Nothing here is meaningful server-side. -->
      <ClientOnly>
        <span v-if="source !== LOCAL_SOURCE" class="flex items-center gap-1.5">
          <span :class="['w-1.5 h-1.5 rounded-full', connected === null ? 'bg-slate-500 animate-pulse' : connected ? 'bg-emerald-400' : 'bg-red-400']" />
          {{ connected === null ? 'connecting' : connected ? (isCloud ? 'polling' : 'streaming') : (isCloud ? 'unreachable' : 'collector offline') }}
        </span>
      </ClientOnly>
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

// Production reads Cloud Logging, which has no push channel — hence polled, not streamed. The env
// toggle owns this, so the viewer just reflects it.
const { env } = useEnvironment()
const isCloud = computed(() => env.value === 'production')
// Cloud Logging mixes several services (ai, capacity, gce_instance), so it needs the module column for
// the same reason the All view does.
const showModule = computed(() => source.value === ALL_SOURCE || isCloud.value)

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

// Clicking a bar answers "what are those lines?" by narrowing the list to that bucket's seconds. The
// histogram still gets `matching`, NOT this — scoping the graph to the bar you just picked would
// collapse it to a single column and there would be no way back.
const bucket = ref(null)
const inBucket = (l, b) => {
  const t = new Date(l.timestamp).getTime()
  return t >= b.from && t < b.to
}
const selected = computed(() => (bucket.value ? matching.value.filter((l) => inBucket(l, bucket.value)) : matching.value))

const filteredLogs = computed(() => {
  const m = selected.value
  return m.length > RENDER_CAP ? m.slice(-RENDER_CAP) : m
})
const hiddenCount = computed(() => Math.max(0, selected.value.length - filteredLogs.value.length))

// Hover/legend highlighting leaves the list intact and only emphasises the lines the pointer is over,
// so you can see WHICH lines a spike is made of without losing the context around them.
// One predicate rebuilt when the histogram's payload changes — not a watcher or a flag per line. Per-
// line reactivity over a MAX_LINES ring is exactly what stalled the main thread before.
const highlight = ref(null)
const matchesHighlight = computed(() => {
  const h = highlight.value
  if (!h) return null
  const keys = h.keys ? new Set(h.keys) : null
  return (l) =>
    (h.from === undefined || inBucket(l, h)) &&
    (!keys || keys.has(h.field === 'level' ? levelKey(l.level) : l.module || '?'))
})
// Only emphasise when at least one RENDERED row matches. Hovering the peak bar otherwise dimmed all 300
// rows and lit none — its lines are older than the rendered tail, so the effect was a dead grey list
// with no explanation. 300 rows is cheap to test; the alternative is a per-line flag, which is what
// stalled the main thread before.
const highlightHits = computed(() => {
  const f = matchesHighlight.value
  return f ? filteredLogs.value.reduce((n, l) => n + (f(l) ? 1 : 0), 0) : 0
})
const isHighlighted = computed(() => (highlightHits.value > 0 ? matchesHighlight.value : null))

const bucketLabel = computed(() => {
  const b = bucket.value
  const at = (t) => new Date(t).toTimeString().slice(0, 8)
  return b ? `${at(b.from)}–${at(b.to)}` : ''
})

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

// Colour a leading `[tag]` run — `[orchestrator]`, `[worker]`, `[capacity/reconcile]`. Several
// subsystems log into ONE component (the `ai` function emits `[orchestrator]` lines from its Pub/Sub
// setup and `[capacity]` lines from the control loop), so the component colour alone can't separate
// them. Same stable hash as componentColor, so a tag keeps one colour everywhere it appears.
const tagHtml = (html) =>
  html.replace(/^(?:\[[^\]]+\]\s*)+/, (run) =>
    run.replace(/\[([^\]]+)\]/g, (_, name) =>
      `<span style="color:${componentColor(name)};font-weight:600">[${name}]</span>`))

const messageHtml = (log) => tagHtml(ansiHtml(log))

const getLevelName = (level) => ({ 10: 'TRC', 20: 'DBG', 30: 'INF', 40: 'WRN', 50: 'ERR', 60: 'FAT' }[level] || 'LOG')

// Level colours come from useLogColors, the same source the histogram stacks from, so a red segment in
// the graph and a red row in the list are literally the same colour — the whole point of the rebuild.
// Only warn and error earn a left bar; below that every row would have one and it stops meaning
// anything. The level NAME is always spelled out, so nothing here is carried by colour alone.
const levelBar = (level) => (level >= 40 ? levelColor(level) : 'transparent')

const formatTime = (ts) => {
  const d = new Date(ts)
  return isNaN(d.getTime()) ? '--:--:--' : d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}
</script>
