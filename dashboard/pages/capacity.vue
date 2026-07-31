<template>
  <div class="glass p-6">
    <div class="flex items-start justify-between gap-4 mb-6 flex-wrap">
      <div class="min-w-0">
        <h1 class="text-2xl font-serif text-primary whitespace-nowrap">Capacity Scoreboard</h1>
        <p class="text-sm text-muted mt-1 max-w-2xl">
          30-day sliding-window success score per region × hour
          <template v-if="view === 'dow'">for <span class="text-secondary">{{ dowLabel }}</span>.</template>
          <template v-else>over the last <span class="text-secondary">{{ windowDays }} days</span> (continuous, local time).</template>
          The controller opens one region (<code>mode=on</code>) and parks the rest. Score =
          <code>ow·Σok − fw·Σfail</code>.
        </p>

        <!-- View switcher (+ timeline-only window / x-ray controls). Left panel, per spec. -->
        <div class="flex flex-wrap items-center gap-3 mt-3 text-xs">
          <div class="flex rounded-lg overflow-hidden border border-white/10">
            <button
              v-for="opt in VIEW_OPTIONS"
              :key="opt.id"
              type="button"
              @click="view = opt.id"
              :class="view === opt.id ? 'bg-amber-500/20 text-amber-400' : 'text-secondary hover:text-primary'"
              class="px-2.5 py-1 transition inline-flex items-center gap-1.5"
            >
              <CalendarDaysIcon v-if="opt.id === 'dow'" class="w-3.5 h-3.5" />
              <Square2StackIcon v-else class="w-3.5 h-3.5" />
              {{ opt.label }}
            </button>
          </div>

          <template v-if="view === 'timeline'">
            <div class="flex items-center gap-1">
              <span class="text-muted mr-1">Window</span>
              <div class="flex rounded-lg overflow-hidden border border-white/10">
                <button
                  v-for="w in WINDOW_OPTIONS"
                  :key="w"
                  type="button"
                  @click="windowDays = w"
                  :class="windowDays === w ? 'bg-amber-500/20 text-amber-400' : 'text-secondary hover:text-primary'"
                  class="px-2 py-1 transition"
                >{{ w }}d</button>
              </div>
            </div>
            <button
              type="button"
              @click="xray = !xray"
              :class="xray ? 'bg-amber-500/20 text-amber-400 border-amber-500/40' : 'text-secondary hover:text-primary border-white/10'"
              class="px-2.5 py-1 rounded-lg border transition inline-flex items-center gap-1.5"
              title="Overlay the prior-day same-hour value as a ghosted underlay behind each cell"
            >
              <Square2StackIcon class="w-3.5 h-3.5" /> x-ray
            </button>
          </template>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <!-- Auto-refresh interval (persisted to localStorage). Off = manual only. -->
        <div class="flex items-center gap-1 text-xs">
          <span class="text-muted mr-1">Auto</span>
          <div class="flex rounded-lg overflow-hidden border border-white/10">
            <button
              v-for="opt in REFRESH_OPTIONS"
              :key="opt.ms"
              type="button"
              @click="refreshMs = opt.ms"
              :class="refreshMs === opt.ms ? 'bg-amber-500/20 text-amber-400' : 'text-secondary hover:text-primary'"
              class="px-2 py-1 transition"
            >{{ opt.label }}</button>
          </div>
        </div>
        <button
          type="button"
          @click="() => refresh()"
          class="flex items-center gap-1.5 px-3 py-1.5 text-xs btn-muted rounded-lg transition"
        >
          <ArrowPathIcon class="w-3.5 h-3.5" :class="{ 'animate-spin': pending }" />
          Refresh
        </button>
      </div>
    </div>

    <!-- Error state — Mongo unreachable (UC2 E1) -->
    <div
      v-if="data && data.ok === false"
      class="rounded-xl border border-red-500/40 bg-red-500/5 p-6 flex items-start gap-3"
    >
      <ExclamationTriangleIcon class="w-5 h-5 text-error shrink-0 mt-0.5" />
      <div>
        <p class="text-sm font-medium text-error">Can't read capacity state</p>
        <p class="text-xs text-muted mt-1 font-mono">{{ data.error }}</p>
      </div>
    </div>

    <template v-else-if="data && data.ok">
      <!-- Broken region filter (config regex won't compile) — surfaced, not silently ignored. -->
      <div
        v-if="data.regionFilterError"
        class="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 flex items-start gap-2"
      >
        <ExclamationTriangleIcon class="w-4 h-4 text-warning shrink-0 mt-0.5" />
        <div>
          <p class="text-xs font-medium text-warning">Region filter is invalid — steering falls back to the seed</p>
          <p class="text-[11px] text-muted mt-0.5 font-mono">{{ data.regionFilterError }}</p>
        </div>
      </div>

      <!-- Active region + params -->
      <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div class="flex items-center gap-3">
          <span class="text-[13px] text-secondary">Active regions</span>
          <span
            v-for="ar in (data.activeRegions || [])"
            :key="ar"
            class="text-[11px] px-2.5 py-0.5 rounded-full border inline-flex items-center gap-1.5"
            style="background: rgba(12,163,12,0.16); color:#5fd25f; border-color: rgba(12,163,12,0.45)"
          >
            <CheckCircleIcon class="w-3 h-3" /> {{ ar }}<span v-if="(data.boxesByRegion || {})[ar] > 1"> · {{ data.boxesByRegion[ar] }} boxes</span>
          </span>
          <span
            v-if="!(data.activeRegions || []).length"
            class="text-[11px] px-2.5 py-0.5 rounded-full border inline-flex items-center gap-1.5 tag-muted"
          >
            <PauseCircleIcon class="w-3 h-3" /> none active
          </span>
          <span class="text-[11px] text-muted">now: {{ hh(data.now) }}:00 {{ data.tz }}</span>
        </div>
        <div class="text-[11px] text-muted flex flex-wrap items-center gap-2 font-mono">
          <span>ow {{ data.params.ow }} · fw {{ data.params.fw }}</span>
          <span>·</span><span>window {{ data.params.windowDays }}d</span>
          <span>·</span><span>park at {{ data.params.maxStockouts }} stockouts</span>
        </div>
      </div>

      <!-- Heatmap: region × 24 hours. Fixed min-height so an empty scoreboard keeps its shape. -->
      <div v-if="view === 'dow'" class="overflow-x-auto relative" style="min-height: 170px">
        <table class="border-separate" style="border-spacing: 2px">
          <thead>
            <tr>
              <td></td>
              <td
                v-for="h in 24"
                :key="`h${h - 1}`"
                class="text-center align-bottom"
                :class="(h - 1) === data.now ? 'text-strong font-semibold' : 'text-muted'"
                style="font-size: 9px; height: 14px"
              >
                {{ (h - 1) % 3 === 0 || (h - 1) === data.now ? hh(h - 1) : '' }}
              </td>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in data.regions" :key="r.region">
              <td
                class="text-right pr-2 whitespace-nowrap"
                :class="isActive(r.region) ? '' : 'text-secondary'"
                :style="isActive(r.region) ? 'color:#5fd25f' : ''"
                style="font-size: 11px"
              >
                {{ r.region }}<span v-if="isActive(r.region)"> ●</span>
              </td>
              <td v-for="(cell, h) in r.hours" :key="`${r.region}-${h}`" style="padding: 0">
                <div
                  class="relative text-center"
                  :class="cellClass(r, cell, h)"
                  :style="cellStyle(r, cell, h)"
                  :title="cellTitle(r, cell, h)"
                  @mouseenter="hover = { r, cell, h }"
                  @mouseleave="hover = null"
                >
                  <span v-if="showNum(r, h) && cell">{{ cell.score }}</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div
          v-if="!data.regions.length"
          class="absolute inset-0 flex items-center justify-center text-xs text-muted pointer-events-none"
        >
          No regions yet — the scoreboard fills in as jobs run.
        </div>
      </div>

      <!-- Hover detail (day-of-week) -->
      <div v-if="view === 'dow'" class="h-5 mt-2 text-[11px] font-mono text-secondary">
        <template v-if="hover">
          <span class="text-strong">{{ hover.r.region }}</span>
          · {{ dowLabel }} {{ hh(hover.h) }}:00 {{ data.tz }} ·
          <template v-if="hover.cell">
            score <span class="text-strong">{{ hover.cell.score }}</span>
            · ok {{ hover.cell.ok }} · fail {{ hover.cell.fail }} · n {{ hover.cell.n }}
          </template>
          <template v-else>no data</template>
        </template>
      </div>

      <!-- Rolling N-day timeline: region × continuous (date, hour) strip. Horizontally scrollable;
           ~168 cells/row at 7d. Reuses .heatcell + the diverging scale. x-ray overlays the prior-day
           same-hour value as a faint underlay behind each cell. -->
      <div v-if="view === 'timeline' && data.timeline" class="overflow-x-auto relative" style="min-height: 170px">
        <table class="border-separate" style="border-spacing: 2px">
          <thead>
            <tr>
              <td></td>
              <td
                v-for="d in data.timeline.dates"
                :key="d"
                :colspan="24"
                class="text-left align-bottom text-muted tl-col-daystart"
                :class="d === tlToday ? 'text-strong font-semibold' : ''"
                style="font-size: 9px; padding: 0 0 2px 5px"
              >
                {{ tlDayLabel(d) }}
              </td>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rt in data.timeline.regions" :key="rt.region">
              <td
                class="text-right pr-2 whitespace-nowrap"
                :class="isActive(rt.region) ? '' : 'text-secondary'"
                :style="isActive(rt.region) ? 'color:#5fd25f' : ''"
                style="font-size: 11px"
              >
                {{ rt.region }}<span v-if="isActive(rt.region)"> ●</span>
              </td>
              <td
                v-for="(cell, i) in rt.cells"
                :key="i"
                class="tl-td"
                :class="{ 'tl-col-daystart': cell.hour === 0 }"
              >
                <div
                  :class="tlCellClass(cell)"
                  :title="tlTitle(rt.region, cell)"
                  @mouseenter="tlHover = { region: rt.region, cell }"
                  @mouseleave="tlHover = null"
                >
                  <span
                    v-if="xray && cell.prevScore !== null"
                    class="tl-ghost"
                    :style="{ background: bg(cell.prevScore) }"
                  ></span>
                  <span
                    v-if="cell.n > 0"
                    class="tl-cur"
                    :class="{ inset: xray && cell.prevScore !== null }"
                    :style="{ background: bg(cell.score) }"
                  >
                    <span v-if="isNowSlot(cell)" class="tl-num">{{ cell.score }}</span>
                  </span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div
          v-if="!data.timeline.regions.length"
          class="absolute inset-0 flex items-center justify-center text-xs text-muted pointer-events-none"
        >
          No regions yet — the scoreboard fills in as jobs run.
        </div>
      </div>

      <!-- Hover detail (timeline) -->
      <div v-if="view === 'timeline'" class="h-5 mt-2 text-[11px] font-mono text-secondary">
        <template v-if="tlHover">
          <span class="text-strong">{{ tlHover.region }}</span>
          · {{ tlHover.cell.ts }} {{ data.tz }} ·
          <template v-if="tlHover.cell.n > 0">
            score <span class="text-strong">{{ tlHover.cell.score }}</span>
            · ok {{ tlHover.cell.ok }} · fail {{ tlHover.cell.fail }} · n {{ tlHover.cell.n }}
          </template>
          <template v-else>no data</template>
          <template v-if="xray && tlHover.cell.prevScore !== null">
            · <span class="text-muted">prev-day {{ tlHover.cell.prevScore }} (ok {{ tlHover.cell.prevOk }} · fail {{ tlHover.cell.prevFail }})</span>
          </template>
        </template>
      </div>

      <!-- Legend + continuous colorbar -->
      <div class="flex flex-wrap items-center gap-4 mt-3 text-[10px] text-secondary">
        <div class="flex flex-col gap-1">
          <div
            class="rounded"
            style="width: 160px; height: 10px; background: linear-gradient(to right, var(--pole-neg), var(--mid), var(--pole-pos))"
          ></div>
          <div class="flex justify-between text-muted" style="width: 160px; font-size: 9px">
            <span>−{{ data.params.max }} fail</span><span>0</span><span>+{{ data.params.max }} success</span>
          </div>
        </div>
        <span class="inline-flex items-center gap-1.5">
          <span class="rounded inline-block align-middle nodata-swatch"></span> no data (eligible)
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="rounded inline-block align-middle nowband" style="width:14px;height:14px;background:var(--mid)"></span> current hour
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="rounded inline-block align-middle focal" style="width:14px;height:14px;background:var(--pole-pos)"></span> recommended
        </span>
        <span>dim = low sample count</span>
        <span v-if="view === 'timeline' && xray" class="inline-flex items-center gap-1.5">
          <span class="rounded inline-block align-middle" style="width:14px;height:14px;position:relative;background:var(--pole-pos);opacity:0.3">
            <span style="position:absolute;inset:3px;border-radius:2px;background:var(--pole-neg);opacity:1"></span>
          </span>
          x-ray · faint = prior day
        </span>
      </div>

      <!-- State cards -->
      <div class="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <!-- Observe-only (Phase 1) -->
        <div v-if="data.phase === 1 && data.wouldOpen" class="statecard" style="--accent:#3987e5">
          <span class="accent"></span>
          <span class="tag"><EyeIcon class="w-3 h-3" /> shadow mode · observing</span>
          <p class="herolabel">Next move on the next job</p>
          <div class="hero">
            <span style="color:#9cc2f2">Scale up {{ data.wouldOpen }}</span>
          </div>
          <p class="herolabel">Hold the other {{ data.wouldPark.length }} region{{ data.wouldPark.length === 1 ? '' : 's' }} at 0 workers</p>
          <div class="chiprow">
            <span class="rchip open"><CheckCircleIcon class="w-3 h-3" /> {{ data.wouldOpen }} · scale on</span>
            <span v-for="r in data.wouldPark" :key="r" class="rchip">○ {{ r }} · hold at 0</span>
          </div>
          <p class="note">
            Shadow mode: this is the plan it <em>would</em> execute — no autoscaler changes made yet.
            Turning workers on in one region and holding the rest at 0 is what stops a job fanning out across regions.
          </p>
        </div>

        <!-- All-negative: least-bad -->
        <div v-if="data.allNegative && data.leastBad" class="statecard" style="--accent:var(--warning)">
          <span class="accent"></span>
          <span class="tag"><ExclamationTriangleIcon class="w-3 h-3" /> capacity degraded</span>
          <p class="herolabel">Least-bad — all regions ≤ 0</p>
          <div class="hero">
            {{ data.leastBad.region }} <span class="score">{{ data.leastBad.score }}</span>
          </div>
          <div class="chiprow">
            <span
              v-for="(r, i) in rankedRegions"
              :key="r.region"
              class="rchip"
              :class="{ open: i === 0 }"
              :style="i === 0 ? 'background:rgba(250,178,25,0.16); border-color:rgba(250,178,25,0.5); color:#f5c26b' : ''"
            >
              <span v-if="i === 0">● </span>{{ r.region }} · {{ r.currentScore }}
            </span>
          </div>
          <p class="note">Park veto dropped; highest score wins. Never returns "nowhere".</p>
        </div>

        <!-- Collecting: no region actively steered yet → running on seed / last-known-good. Shows
             through the whole collecting phase, not just when the window is literally empty. -->
        <div v-if="!(data.activeRegions || []).length" class="statecard" style="--accent:#a3a3a0">
          <span class="accent"></span>
          <span class="tag"><ClockIcon class="w-3 h-3" /> collecting</span>
          <p class="herolabel">Running on seed / last-known-good</p>
          <div class="hero">{{ data.seedRegion || '—' }} <span class="arrow">seed</span></div>
          <div class="meter"><i :style="{ width: seedFill }"></i></div>
          <p class="note">
            {{ seedSamples }} outcome{{ seedSamples === 1 ? '' : 's' }} recorded ·
            {{ data.params.windowDays }}-day window · scoreboard fills in as jobs run.
          </p>
        </div>

        <!-- Per-region status (always) -->
        <div class="statecard" style="--accent:#5fd25f">
          <span class="accent"></span>
          <span class="tag"><ServerStackIcon class="w-3 h-3" /> regions · {{ data.regions.length }}</span>
          <div class="mt-3 space-y-1.5">
            <div
              v-for="r in data.regions"
              :key="r.region"
              class="flex items-center justify-between text-[11px] gap-3"
            >
              <span class="inline-flex items-center gap-1.5 font-mono text-secondary">
                <span
                  class="inline-block w-2 h-2 rounded-full"
                  :style="`background:${r.mode === 'on' ? '#0ca30c' : '#6b6b68'}`"
                ></span>
                {{ r.region }}
                <span class="text-muted">· {{ r.mode || 'unknown' }}</span>
              </span>
              <span class="text-muted font-mono">
                <span v-if="r.stockouts > 0" class="text-error">{{ r.stockouts }} stockouts · </span>
                <span :class="r.successes > 0 ? 'text-success' : ''">{{ r.successes > 0 ? `${r.successes} ok` : 'no success yet' }}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Initial load -->
    <div v-else class="text-sm text-muted py-12 text-center">Loading capacity state…</div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import {
  ArrowPathIcon,
  CheckCircleIcon,
  PauseCircleIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  ClockIcon,
  ServerStackIcon,
  CalendarDaysIcon,
  Square2StackIcon,
} from '@heroicons/vue/24/outline'

const DOW_LABELS = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' }

const { env } = useEnvironment()

// View + rolling-timeline controls. `windowDays` is part of the fetch query, so switching
// windows re-fetches (Nitro route serves the matching timeline). view/xray are client-only.
const VIEW_OPTIONS = [
  { id: 'dow', label: 'Day-of-week' },
  { id: 'timeline', label: 'Timeline' },
]
const WINDOW_OPTIONS = [7, 14, 30]
const view = ref('dow')
const windowDays = ref(7)
const xray = ref(false)

// Same data-fetching convention as the rest of the dashboard (Nitro route + useFetch),
// re-fetching whenever the dev/prod toggle flips or the timeline window changes.
const { data, pending, refresh } = await useFetch('/api/capacity/scoreboard', {
  query: { env, days: windowDays },
})

const hover = ref(null)
const tlHover = ref(null)

// Auto-refresh interval, persisted to localStorage. Off = manual refresh only.
const REFRESH_OPTIONS = [
  { label: 'Off', ms: 0 },
  { label: '30s', ms: 30_000 },
  { label: '1m', ms: 60_000 },
  { label: '2m', ms: 120_000 },
  { label: '5m', ms: 300_000 },
  { label: '10m', ms: 600_000 },
]
const REFRESH_KEY = 'yclCapacityRefreshMs'
const refreshMs = ref(0)
let refreshTimer = null
function applyRefreshTimer() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
  if (refreshMs.value > 0) refreshTimer = setInterval(() => refresh(), refreshMs.value)
}
onMounted(() => {
  const saved = parseInt(localStorage.getItem(REFRESH_KEY) || '', 10)
  if (REFRESH_OPTIONS.some((o) => o.ms === saved)) refreshMs.value = saved
  applyRefreshTimer()
})
watch(refreshMs, (ms) => {
  if (import.meta.client) localStorage.setItem(REFRESH_KEY, String(ms))
  applyRefreshTimer()
})
onBeforeUnmount(() => { if (refreshTimer) clearInterval(refreshTimer) })

const dowLabel = computed(() => DOW_LABELS[data.value?.dow] || '—')

// Buckets are already in the business timezone (recorder + route agree on CAPACITY_TZ), so render
// hour columns directly — no client-side shifting. data.tz is the zone abbreviation to label with.
// Collecting-card progress: total outcomes recorded across regions (current daypart view).
const seedSamples = computed(() =>
  (data.value?.regions || []).reduce((n, r) => n + (r.successes || 0) + (r.stockouts || 0), 0))
const seedFill = computed(() => `${Math.min(100, 3 + seedSamples.value * 2)}%`)
const rankedRegions = computed(() =>
  (data.value?.regions || []).filter((r) => r.currentScore !== null)
)

const hh = (h) => String(h).padStart(2, '0')

// Diverging blue↔red via color-mix, gray (--mid) at score≈0 — matches the mockup.
const bg = (s) => {
  const max = data.value?.params?.max ?? 25
  const t = Math.min(Math.abs(s) / max, 1)
  const pole = s >= 0 ? 'var(--pole-pos)' : 'var(--pole-neg)'
  return `color-mix(in oklab, ${pole} ${Math.round(t * 100)}%, var(--mid))`
}

const isActive = (region) => (data.value?.activeRegions || []).includes(region)
const isFocal = (r, h) => isActive(r.region) && h === data.value?.now
const isLowSample = (cell) => cell && cell.n < (data.value?.params?.lowSample ?? 5)

const cellClass = (r, cell, h) => {
  const c = ['heatcell']
  if (!cell) c.push('nodata')
  if (h === data.value?.now) c.push('nowband')
  if (isFocal(r, h)) c.push('focal')
  return c
}
const cellStyle = (r, cell, h) => {
  if (!cell) return {}
  const s = { background: bg(cell.score) }
  if (isLowSample(cell)) s.opacity = '0.5'
  return s
}
const cellTitle = (r, cell, h) =>
  cell
    ? `${r.region} ${hh(h)}:00 ${data.value?.tz || ''} — score ${cell.score} · ok ${cell.ok} · fail ${cell.fail} · n ${cell.n}`
    : `${r.region} ${hh(h)}:00 ${data.value?.tz || ''} — no data`

// Only the current-hour column (and the focal cell) shows its number, per the mockup.
const showNum = (r, h) => h === data.value?.now || isFocal(r, h)

// --- Timeline view helpers --------------------------------------------------
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// "2026-07-17" → "Fri 17" (parse as UTC to avoid a local-tz off-by-one on the date math).
const tlDayLabel = (d) => {
  const [y, m, day] = d.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, day))
  return `${WEEKDAY[dt.getUTCDay()]} ${String(day).padStart(2, '0')}`
}
// The newest local day in the window is "today"; its now-hour cell is the live one.
const tlToday = computed(() => {
  const dates = data.value?.timeline?.dates
  return dates?.length ? dates[dates.length - 1] : null
})
const isNowSlot = (cell) => cell.date === tlToday.value && cell.hour === data.value?.now
const tlEmpty = (cell) => cell.n === 0 && !(xray.value && cell.prevScore !== null)
const tlCellClass = (cell) => {
  const c = ['heatcell', 'tl']
  if (tlEmpty(cell)) c.push('nodata')
  if (cell.hour === 0) c.push('tl-daystart')
  if (isNowSlot(cell)) c.push('nowband')
  return c
}
const tlTitle = (region, cell) => {
  const base = `${region} ${cell.ts} ${data.value?.tz || ''}`
  const cur = cell.n > 0 ? `score ${cell.score} · ok ${cell.ok} · fail ${cell.fail} · n ${cell.n}` : 'no data'
  const prev = xray.value && cell.prevScore !== null ? ` · prev-day ${cell.prevScore} (ok ${cell.prevOk} · fail ${cell.prevFail})` : ''
  return `${base} — ${cur}${prev}`
}

const rel = (iso) => {
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const hr = Math.round(m / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.round(hr / 24)}d ago`
}
</script>

<style scoped>
/* Diverging-scale tokens (validated blue↔red poles on the dark surface), matching
   docs/mockups/capacity-scoreboard.html. Local to this page — the scoreboard is the
   only surface that uses the pos/neg poles. */
:root,
:global(html) {
  --pole-pos: #3987e5;
  --pole-neg: #e66767;
  --mid: #383835;
  --warning: #fab219;
}

.heatcell {
  width: 22px;
  height: 24px;
  border-radius: 4px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  line-height: 24px;
  color: var(--ink, #f4f4f2);
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.55);
}
.heatcell.nodata {
  /* Dark recessed fill so populated cells pop by contrast (even low-sample dim ones). */
  background: rgba(0, 0, 0, 0.4) !important;
  background-image: repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.09) 0 2px, transparent 2px 5px) !important;
  border: 1px solid rgba(255, 255, 255, 0.06);
}
.heatcell.nowband {
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35);
}
.heatcell.focal {
  outline: 2px solid var(--pole-pos);
  outline-offset: 1px;
  box-shadow: 0 0 10px rgba(57, 135, 229, 0.5);
}

.nodata-swatch {
  width: 14px;
  height: 14px;
  background: rgba(0, 0, 0, 0.4);
  background-image: repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.09) 0 2px, transparent 2px 5px);
  border: 1px solid rgba(255, 255, 255, 0.06);
}
.nowband {
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35);
}
.focal {
  outline: 2px solid var(--pole-pos);
  outline-offset: 1px;
}

/* Timeline cells: same .heatcell footprint, but layered so the x-ray underlay (prior day)
   can sit BEHIND the current value. Current block paints on top at full strength. */
.heatcell.tl {
  position: relative;
  background: transparent;
}
.tl-ghost {
  position: absolute;
  inset: 0;
  border-radius: 4px;
  opacity: 0.3; /* clearly secondary — never competes with the current cell */
  pointer-events: none;
}
.tl-cur {
  position: absolute;
  inset: 0;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}
/* When a ghost is present, inset the current block so the prior layer peeks around it (x-ray). */
.tl-cur.inset {
  inset: 3px;
  border-radius: 3px;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
}
.tl-num {
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  color: var(--ink, #f4f4f2);
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.6);
}
/* Current-hour ring (offset outline draws outside, so the layered spans don't cover it). */
.heatcell.tl.nowband {
  outline: 2px solid rgba(255, 255, 255, 0.6);
  outline-offset: 1px;
  box-shadow: none;
}
.tl-td {
  padding: 0;
}
/* Light day boundary so the continuous strip stays readable. */
.tl-col-daystart {
  border-left: 1px solid rgba(255, 255, 255, 0.16);
  padding-left: 4px;
}

/* State cards — accent bar + hero + chips, per the mockup. */
.statecard {
  position: relative;
  overflow: hidden;
  padding: 18px 18px 18px 22px;
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(38, 38, 36, 0.55);
  backdrop-filter: blur(10px);
}
.accent {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  background: var(--accent);
}
.statecard::after {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 120px;
  background: linear-gradient(90deg, color-mix(in oklab, var(--accent) 22%, transparent), transparent);
  pointer-events: none;
}
.tag {
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 3px 9px;
  border-radius: 9999px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: color-mix(in oklab, var(--accent) 16%, transparent);
  color: var(--accent);
  border: 1px solid color-mix(in oklab, var(--accent) 45%, transparent);
}
.herolabel {
  font-size: 11px;
  color: #6b6b68;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin: 12px 0 2px;
}
.hero {
  font-size: 24px;
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1.1;
}
.hero .arrow {
  color: #6b6b68;
  font-weight: 400;
  font-size: 15px;
}
.hero .score {
  color: var(--accent);
}
.chiprow {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.rchip {
  font-size: 11px;
  padding: 4px 9px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #a3a3a0;
  background: rgba(255, 255, 255, 0.03);
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.rchip.open {
  background: rgba(57, 135, 229, 0.18);
  border-color: rgba(57, 135, 229, 0.55);
  color: #9cc2f2;
  font-weight: 600;
}
.note {
  font-size: 11px;
  color: #6b6b68;
  margin-top: 8px;
}
.meter {
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.08);
  width: 220px;
  margin-top: 10px;
  overflow: hidden;
}
.meter > i {
  display: block;
  height: 100%;
  background: var(--accent);
}
</style>
