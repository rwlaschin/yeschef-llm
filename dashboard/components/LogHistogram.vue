<template>
  <!-- A log EXPLORER graph, not a volume meter: binned counts broken down by a field, so you read the
       total AND what it is made of, then click into it. Modelled on what the tools that do this well do
       — Kibana Discover (histogram broken down by log.level), Loki (stacked bars by level, legend, and
       row colours that match the graph), Papertrail (scoped to the current search, fixed time windows,
       click a point to seek to those events).
       BARS, not an area: these are binned counts, and log traffic is bursty, so an area/line
       interpolates slopes across empty buckets and draws triangles that imply traffic that never
       happened. Bars grow from one baseline and an empty bucket reads as empty.
       The window is FIXED and anchored to now, not derived from the data's own min/max — one stale line
       in the ring would otherwise stretch the span to hours and pile everything into a single bar. -->
  <div class="shrink-0 select-none">
    <!-- Header stays mounted when collapsed: it is the only way back, so it must never be what gets
         hidden. -->
    <div class="flex items-center gap-2 text-[10px] font-mono mb-1">
      <button
        @click="setOpen(!open)"
        class="px-1 rounded text-slate-400 hover:text-slate-100 transition"
        :title="open ? 'Hide the graph' : 'Show the graph'"
      >{{ open ? '▾' : '▸' }} graph</button>

      <!-- The peak is direct-labelled on its own bar now, so repeating it here was the same number twice. -->
      <span class="text-slate-400">{{ props.lines.length }} lines</span>

      <span v-if="selected" class="flex items-center gap-1 text-amber-300">
        · showing {{ fmt(selected.from) }}–{{ fmt(selected.to) }} ·
        <button @click="clearSelection" class="underline hover:text-amber-200">clear</button>
      </span>

      <div v-if="open" class="ml-auto flex items-center gap-2 text-slate-600">
        <!-- Which field the bars break down by. Level answers "is it broken", source answers "who is
             talking" — both are the question at different moments. -->
        <div class="flex items-center gap-1">
          <button
            v-for="f in FIELDS"
            :key="f"
            @click="breakdown = f"
            :class="['px-1 rounded', breakdown === f ? 'text-amber-400 font-bold' : 'hover:text-slate-300']"
          >{{ f }}</button>
        </div>
        <span class="text-slate-700">|</span>
        <div class="flex items-center gap-1">
          <button
            v-for="w in WINDOWS"
            :key="w.ms"
            @click="pickWindow(w.ms)"
            :class="['px-1 rounded', windowMs === w.ms ? 'text-amber-400 font-bold' : 'hover:text-slate-300']"
          >{{ w.label }}</button>
        </div>
      </div>
      <span v-else class="ml-auto text-slate-600">hidden</span>
    </div>

    <!-- ClientOnly: every label below is derived from `now`, so the server stamps one second and the
         client stamps another — the "rendered on server 07:56:19 / expected on client 07:56:20"
         mismatch. A clock has no server-rendered meaning. -->
    <ClientOnly>
    <template v-if="open">
      <!-- gap-[2px] IS the surface gap that separates adjacent bars; the column is the hover hit target,
           full height so it clears the 24px minimum even where the bar itself is 1px. -->
      <div class="relative flex items-end gap-[2px] h-16 px-0.5 border-b border-slate-700/40">
        <div
          v-for="(stack, i) in stacks"
          :key="i"
          @mouseenter="hovered = i"
          @mouseleave="hovered = null"
          @click="toggleBucket(i)"
          :class="[
            'relative flex-1 min-w-px h-full flex flex-col justify-end cursor-pointer',
            selectedIndex === i ? 'bg-slate-700/40' : hovered === i ? 'bg-slate-700/20' : '',
          ]"
        >
          <!-- ONE direct label, on the tallest bar only. The skill's order is direct labels before
               gridlines: with a 400-vs-1 spread the peak is the only value that sets the scale, so
               naming it is what makes every other bar interpretable — no axis needed. -->
          <span
            v-if="i === peakIndex && peak > 1"
            class="absolute -top-3 left-1/2 -translate-x-1/2 text-[9px] font-mono text-slate-400 tabular-nums pointer-events-none"
          >{{ peak }}</span>
          <!-- Capped at 24px so a wide strip gets air instead of slabs; the column keeps the full
               width as the hit target. Segments render top-down (most severe / largest first) with a
               2px surface gap between them, so one error stays visible against a tall bar. -->
          <!-- h-full is load-bearing: the segments size in PERCENT, and a percentage height against an
               auto-height parent computes to zero — which rendered every bar invisible. -->
          <div class="w-full max-w-[24px] mx-auto h-full flex flex-col justify-end">
            <!-- min-height in PX, not percent: log volume is wildly skewed (one boot burst of 400+
                 beside buckets of 1), and 2% of a 48px plot is half a pixel — every quiet bucket was
                 invisible. 3px is the floor at which "one line" still reads as a mark. -->
            <div
              v-for="(s, k) in stack"
              :key="s.key"
              :class="k === 0 ? 'rounded-t-[4px]' : ''"
              :style="{ height: pct(s.n), minHeight: '3px', background: s.color, marginBottom: k === stack.length - 1 ? '0' : '2px' }"
            />
          </div>
        </div>

        <!-- One tooltip for the hovered bucket, listing EVERY series there — a total alone is the thing
             this graph was rebuilt to stop being. Anchored inside the strip and side-clamped at the
             edges so it can't be clipped. -->
        <div
          v-if="hovered !== null && tip"
          :class="[
            'absolute bottom-full mb-1 z-20 pointer-events-none whitespace-nowrap rounded-md border border-slate-600/60 bg-slate-900/95 px-2 py-1 text-[10px] font-mono shadow-lg',
            hovered < BUCKETS / 3 ? 'left-0' : hovered > (BUCKETS * 2) / 3 ? 'right-0' : 'left-1/2 -translate-x-1/2',
          ]"
        >
          <div class="text-slate-400">{{ fmt(tip.from) }}–{{ fmt(tip.to) }}</div>
          <div v-if="!tip.rows.length" class="text-slate-500">no lines</div>
          <!-- Value leads, series name follows, and the name wears a text token — the swatch beside it
               carries identity, never the text colour. -->
          <div v-for="r in tip.rows" :key="r.key" class="flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-sm shrink-0" :style="{ background: r.color }" />
            <span class="text-slate-100 font-bold tabular-nums w-8 text-right">{{ r.n }}</span>
            <span class="text-slate-400 truncate max-w-[10rem]">{{ r.label }}</span>
          </div>
        </div>
      </div>

      <!-- pt-1: the axis text sat directly on the baseline rule, touching the shortest bars. -->
      <div class="flex items-center justify-between text-[10px] font-mono text-slate-600 pt-1">
        <span>{{ fmt(t0) }}</span>
        <span>{{ Math.round(width / 1000) }}s buckets · click a bar to filter</span>
        <span>Right Now</span>
      </div>

      <!-- Legend is always present: with two or more series, identity must never be colour-alone. Each
           entry carries its own count, and clicking it drops that series out of the graph. -->
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[10px] font-mono">
        <button
          v-for="s in series"
          :key="s.key"
          @click="toggleSeries(s.key)"
          @mouseenter="hoverSeries = s.key"
          @mouseleave="hoverSeries = null"
          :class="['flex items-center gap-1.5 rounded px-0.5 transition', hidden.has(s.key) ? 'opacity-40 line-through' : 'hover:bg-slate-700/30']"
          :title="hidden.has(s.key) ? 'Show this series' : 'Hide this series'"
        >
          <span class="w-2 h-2 rounded-sm shrink-0" :style="{ background: s.color }" />
          <span class="text-slate-300 truncate max-w-[9rem]">{{ s.label }}</span>
          <span class="text-slate-500 tabular-nums">{{ totals[s.key] || 0 }}</span>
        </button>
        <span v-if="!series.length" class="text-slate-600">no lines in this window</span>
      </div>
    </template>
    </ClientOnly>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({ lines: { type: Array, required: true } })
// `select` narrows the row list to a time bucket; `highlight` leaves the list intact and only
// emphasises the lines the pointer is over — two different questions, so two different signals.
const emit = defineEmits(['select', 'highlight'])

const BUCKETS = 60
const FIELDS = ['level', 'source']
const WINDOWS = [
  { label: '5m', ms: 5 * 60_000 },
  { label: '15m', ms: 15 * 60_000 },
  { label: '1h', ms: 60 * 60_000 },
  { label: '6h', ms: 6 * 60 * 60_000 },
]

const STORE_KEY = 'yeschef-llm-loghist'

const breakdown = ref(FIELDS[0])
const windowMs = ref(WINDOWS[1].ms)
const hovered = ref(null)
const hoverSeries = ref(null)
const selectedIndex = ref(null)
const hidden = ref(new Set())
const open = ref(true)

// Same localStorage convention as the env toggle: hydrate once on the client, write on change.
onMounted(() => {
  if (window.localStorage.getItem(STORE_KEY) === 'closed') open.value = false
})
const setOpen = (v) => {
  open.value = v
  window.localStorage.setItem(STORE_KEY, v ? 'open' : 'closed')
  if (!v) { hovered.value = null; hoverSeries.value = null; selectedIndex.value = null }
}

// The right edge is "now", so it has to keep moving or the strip silently freezes while lines arrive.
const now = ref(Date.now())
let timer = null
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 5000) })
onBeforeUnmount(() => clearInterval(timer))

const width = computed(() => windowMs.value / BUCKETS)
const t0 = computed(() => now.value - windowMs.value)

// Auto-fit the window to the data ONCE, until the user picks one. The route's first load pulls a 6h
// page, so a 15m default drew an empty graph beside a list of 500 lines — the window and the data
// disagreed. Still one of the fixed presets (never a data-derived span, which is what collapsed
// everything into a single bar), just the smallest that actually holds most of what is loaded.
const userPicked = ref(false)
const pickWindow = (ms) => { userPicked.value = true; windowMs.value = ms }
const fit = () => {
  if (userPicked.value || !props.lines.length) return
  const ts = props.lines.map((l) => new Date(l.timestamp).getTime())
  const covered = (ms) => ts.filter((t) => t >= Date.now() - ms).length / ts.length
  windowMs.value = (WINDOWS.find((w) => covered(w.ms) >= 0.8) ?? WINDOWS[WINDOWS.length - 1]).ms
}
watch(() => props.lines.length, fit, { immediate: true })

const keyOf = (l) => (breakdown.value === 'level' ? levelKey(l.level) : l.module || '?')

// One pass: bucket index → per-key counts, plus the window-wide totals the legend shows. Hidden series
// are still counted (the legend keeps showing what you dropped) but excluded from the drawn stack.
const binned = computed(() => {
  const counts = Array.from({ length: BUCKETS }, () => ({}))
  const totals = {}
  const start = t0.value
  const w = width.value
  for (const l of props.lines) {
    const i = Math.floor((new Date(l.timestamp).getTime() - start) / w)
    if (i < 0 || i >= BUCKETS) continue        // outside the window — simply not shown
    const k = keyOf(l)
    counts[i][k] = (counts[i][k] || 0) + 1
    totals[k] = (totals[k] || 0) + 1
  }
  return { counts, totals }
})

const totals = computed(() => binned.value.totals)

// Fixed order for levels (severity, and the order the palette was validated in). Sources are listed by
// volume, but WHICH of them gets its own series is decided by the colour composable's slot ledger, not
// by rank here — a module that is coloured in the row list has to be a series in the graph, or the two
// disagree about what "other" means.
const series = computed(() => {
  const t = totals.value
  if (breakdown.value === 'level') {
    return LEVEL_SERIES.filter((s) => t[s.key]).map((s) => ({ key: s.key, label: s.label, color: s.color }))
  }
  const names = Object.keys(t).sort((a, b) => t[b] - t[a])
  const out = names.filter(hasColorSlot).map((n) => ({ key: n, label: n, color: componentColor(n) }))
  if (names.some((n) => !hasColorSlot(n))) out.push({ key: OTHER_KEY, label: OTHER_KEY, color: OTHER_COLOR })
  return out
})

// Series keys the tail collapses into, so the bars, the tooltip and the row highlighting all agree on
// what "other" contains.
const otherKeys = computed(() =>
  breakdown.value === 'level' ? [] : Object.keys(totals.value).filter((n) => !hasColorSlot(n)),
)

const countIn = (bucket, s) =>
  s.key === OTHER_KEY ? otherKeys.value.reduce((n, k) => n + (bucket[k] || 0), 0) : bucket[s.key] || 0

// Drawn top-down: the stack is built in series order then reversed, so the DOM's first child is the
// top segment and gets the 4px rounded data-end while the baseline stays square.
const stackOf = (bucket) =>
  series.value
    .filter((s) => !hidden.value.has(s.key))
    .map((s) => ({ ...s, n: countIn(bucket, s) }))
    .filter((s) => s.n > 0)
    .reverse()

const buckets = computed(() => binned.value.counts)
// Built once per data/legend change: the template reads the same array for the bars, the peak and the
// tooltip instead of re-stacking 60 buckets on every render.
const stacks = computed(() => buckets.value.map(stackOf))
const bucketTotals = computed(() => stacks.value.map((s) => s.reduce((n, x) => n + x.n, 0)))
const peak = computed(() => Math.max(1, ...bucketTotals.value))
// Which bucket carries the peak — the one bar that gets a direct value label.
const peakIndex = computed(() => bucketTotals.value.indexOf(peak.value))

// Floored at 2px so a single line is still a visible mark rather than rounding away to nothing.
const pct = (n) => `${Math.max(2, (n / peak.value) * 100)}%`

const fmt = (t) => new Date(t).toTimeString().slice(0, 8)

const rangeOf = (i) => ({ from: t0.value + i * width.value, to: t0.value + (i + 1) * width.value })

const tip = computed(() => {
  const i = hovered.value
  if (i === null) return null
  return { ...rangeOf(i), rows: stacks.value[i] }
})

const selected = computed(() => (selectedIndex.value === null ? null : rangeOf(selectedIndex.value)))

const toggleBucket = (i) => { selectedIndex.value = selectedIndex.value === i ? null : i }
const clearSelection = () => { selectedIndex.value = null }

const toggleSeries = (key) => {
  const next = new Set(hidden.value)
  next.has(key) ? next.delete(key) : next.add(key)
  hidden.value = next
}

// A bucket index is meaningless once the window slides or the bucket width changes — a stale selection
// would silently filter to the wrong seconds.
watch([windowMs, breakdown], clearSelection)

watch(selected, (v) => emit('select', v))

// One highlight payload the list can test cheaply: a time range and/or a series, never a per-line
// broadcast. `keys` is expanded here because only this component knows what "other" folded up.
const highlight = computed(() => {
  const range = hovered.value === null ? null : rangeOf(hovered.value)
  const key = hoverSeries.value
  if (!range && !key) return null
  const keys = key === OTHER_KEY ? otherKeys.value : key ? [key] : null
  return { ...(range || {}), field: breakdown.value, keys }
})
watch(highlight, (v) => emit('highlight', v))
</script>
