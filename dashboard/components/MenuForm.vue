<!-- Menu Plan form. Wide layout to match the Request page's working panel: a settings row
     (company / user) across the top, then a two-column body (inputs | duration+residents+
     steps), then Generate. Entry metadata + defaults come from the SAME registry the endpoint
     composes from (#menu-plan), so fields and seeds can't drift from what runs. -->
<template>
  <div class="space-y-6 max-w-4xl">
    <!-- Settings row: company / user. Model is NOT here — each step picks its own model in the Plan
         Library (def.model); there is no run-level model. -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <span class="text-xs text-muted block mb-1">Company</span>
        <Select v-model="companyId" :options="companyOptions" placeholder="Choose company…" />
      </div>
      <div>
        <span class="text-xs text-muted block mb-1">User</span>
        <Select v-model="userId" :options="userOptions" placeholder="Choose user…" />
      </div>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-6">
      <!-- Left column: input entries (chips) -->
      <div class="space-y-4">
        <div v-for="e in inputEntries" :key="e.key" class="space-y-1">
          <div class="flex items-center justify-between">
            <span class="text-xs text-muted">{{ e.label }}</span>
            <div class="flex items-center gap-2">
              <!-- Stub: will query the LLM for suggested values. Not wired yet. -->
              <button
                type="button"
                :title="`Ask Remy to suggest ${e.label.toLowerCase()} (coming soon)`"
                class="grid place-items-center w-6 h-6 rounded-full text-muted transition hover:text-amber-400 hover:bg-amber-400/10 active:scale-90"
                @click="fetchDefaults(e)"
              >
                <SparklesIcon class="w-4 h-4" />
              </button>
              <Toggle v-model="enabled[e.key]" />
            </div>
          </div>
          <ChipInput
            v-if="enabled[e.key]"
            v-model="chips[e.key]"
            :options="e.options || []"
            :placeholder="`Add ${e.label.toLowerCase()} — Enter to add`"
          />

          <!-- Diet mix — relative weights → the server splits residents into per-diet batch counts.
               Live preview shows each diet's share and headcount so the numbers are sane before launch. -->
          <div v-if="e.key === 'diets' && enabled.diets && (chips.diets || []).length" class="mt-2 rounded-lg border border-divider">
            <button type="button" class="w-full flex items-center justify-between px-2 py-1.5 text-left hover:bg-amber-500/5 transition rounded-lg" @click="showDietMix = !showDietMix">
              <span class="text-[11px] text-muted">Diet mix — relative weights, split across {{ residents || 0 }} residents</span>
              <span class="text-xs opacity-60 transition-transform" :class="showDietMix ? 'rotate-180' : ''">▼</span>
            </button>
            <div v-show="showDietMix" class="px-2 pb-2 space-y-1">
              <div v-for="d in chips.diets" :key="d" class="flex items-center gap-2">
                <span class="text-xs flex-1 truncate" :title="d">{{ d }}</span>
                <input v-model.number="dietWeights[d]" type="number" min="0" step="1" class="form-input w-16 text-xs py-1 text-right" />
                <span class="text-[11px] text-muted w-24 text-right tabular-nums">{{ dietPct(d) }}% · ~{{ dietCount(d) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Protein rotation — the categorization step FILLS this list from the selected diets; the
             chef only orders it (priority) and weights it (share of the cycle). Zero-weight rows are
             dropped at submit, so a 0 reads as "not in this rotation". It sits at the foot of the
             inputs column, which the taller settings column would otherwise leave as dead space. -->
        <div class="space-y-1">
          <div class="flex items-center justify-between">
            <span class="text-xs text-muted">Proteins</span>
            <button
              type="button"
              title="Ask Remy again which proteins suit these diets"
              :disabled="proteinsPending"
              class="grid place-items-center w-6 h-6 rounded-full text-muted transition hover:text-amber-400 hover:bg-amber-400/10 active:scale-90 disabled:opacity-40"
              @click="fetchProteins()"
            >
              <SparklesIcon class="w-4 h-4" :class="proteinsPending ? 'animate-pulse text-amber-400' : ''" />
            </button>
          </div>
          <ProteinWeights
            v-model="proteinRows"
            :loading="proteinsPending && !proteinRows.length"
            :refreshing="proteinsPending && proteinRows.length > 0"
            :adding="addingProtein"
            @add="addProtein"
            @remove="removeProtein"
          />
        </div>
      </div>

      <!-- Right column: duration, residents, step toggles -->
      <div class="space-y-5">
        <!-- Location (optional) — IANA timezone; drives region, season (hemisphere) and current date/time -->
        <div class="space-y-1">
          <span class="text-xs text-muted">Location <span class="opacity-60">(optional)</span></span>
          <SearchableSelect v-model="location" :options="locationOptions" placeholder="Timezone — optional (e.g. Los Angeles)" />
        </div>

        <!-- Duration → range object -->
        <div class="space-y-1">
          <span class="text-xs text-muted">Duration</span>
          <Select v-model="weeks" :options="durationOptions" />
          <div class="flex items-center justify-between">
            <span class="text-xs text-muted">{{ durationHuman }}</span>
            <div v-if="weekdaysFlag" class="flex items-center gap-2">
              <span class="text-sm">{{ weekdaysFlag.label }}</span>
              <Toggle v-model="flags[weekdaysFlag.key]" />
            </div>
          </div>
        </div>

        <!-- Residents -->
        <div class="space-y-1">
          <span class="text-xs text-muted">Residents</span>
          <input
            v-model.number="residents"
            type="number"
            min="1"
            class="form-input w-full"
            placeholder="e.g. 300"
          />
        </div>

        <!-- Cost tier — budget/quality label (not a $ figure) -->
        <div class="space-y-1">
          <span class="text-xs text-muted">Cost tier</span>
          <Select v-model="costTier" :options="costOptions" />
          <textarea
            v-model="costTierDescription"
            rows="2"
            maxlength="4000"
            class="form-input w-full text-sm"
            placeholder="What that tier means here — optional"
          ></textarea>
        </div>

        <!-- Dishes per meal, per course position. 1 is not a menu, so the range skips it; 0 removes
             the course. Left at the seeded values the field is still sent — it matches the server's
             own default. -->
        <div class="space-y-2">
          <div class="text-xs text-muted">Dishes per course</div>
          <div v-for="c in COURSE_POSITIONS" :key="c.key" class="flex items-center justify-between gap-2">
            <span class="text-sm">{{ c.label }}</span>
            <div class="w-28">
              <Select v-model="courseCounts[c.key]" :options="courseCountOptions" />
            </div>
          </div>
        </div>

        <!-- Prep/texture flags — constraints applied to the menu, NOT separate diets -->
        <div v-if="MENU_FLAGS.length" class="space-y-2">
          <div class="text-xs text-muted">Options</div>
          <div v-for="f in MENU_FLAGS.filter((x) => x.key !== 'business_days')" :key="f.key" class="flex items-center justify-between">
            <span class="text-sm" :title="f.help">{{ f.label }}</span>
            <Toggle v-model="flags[f.key]" />
          </div>
        </div>

        <!-- Body entries — toggle to include/skip -->
        <div class="space-y-2">
          <div class="text-xs text-muted">Steps</div>
          <div v-for="e in bodyEntries" :key="e.key" class="flex items-center justify-between">
            <span class="text-sm">{{ e.label }}</span>
            <Toggle v-model="enabled[e.key]" />
          </div>
        </div>
      </div>

    </div>

    <div class="flex justify-end">
      <button
        type="button"
        :disabled="!canSubmit || loading"
        class="px-5 py-2 rounded bg-amber-500 text-gray-900 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-amber-600 transition"
        @click="submit"
      >
        {{ loading ? (mode === 'rerun' ? 'Rerunning…' : 'Generating…') : (mode === 'rerun' ? 'Rerun' : 'Generate') }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import dayjs from 'dayjs'
import { MENU_ENTRIES, MENU_FLAGS, COST_TIERS, LOCATIONS } from '#menu-plan'
import { SparklesIcon } from '@heroicons/vue/24/outline'
import ChipInput from '~/components/ChipInput.vue'
import Select from '~/components/Select.vue'
import SearchableSelect from '~/components/SearchableSelect.vue'
import ProteinWeights from '~/components/ProteinWeights.vue'
import { useJob } from '~/composables/useJob'
import { findCachedProteinsJob } from '~/composables/useProteinsCache'

const emit = defineEmits(['created', 'rerun'])
const props = defineProps({ preset: { type: Object, default: null } })
const { success, error: showError } = useToast()
const { env } = useEnvironment()
const cfg = useRuntimeConfig().public
const aiBase = computed(() => String(env.value === 'production' ? cfg.aiBaseUrl : cfg.aiBaseUrlLocal).replace(/\/$/, ''))
const { getToken } = useAuth()

const inputEntries = MENU_ENTRIES.filter((e) => e.group === 'input')
const bodyEntries = MENU_ENTRIES.filter((e) => e.group === 'body')

// State — seeded with the registry's reasonable defaults
const companyId = ref('')
const userId = ref('')
const chips = reactive(Object.fromEntries(inputEntries.map((e) => [e.key, [...(e.default || [])]])))
const enabled = reactive(Object.fromEntries(MENU_ENTRIES.map((e) => [e.key, e.defaultEnabled])))

// Per-diet RELATIVE weights → the statistical mix the server's {{allocate}} helper uses to split
// residents into per-diet batch counts (LLMs can't be trusted with that arithmetic). Seeded from the
// diets entry's default mix; any newly-picked diet without a weight defaults to an equal-ish 5.
const DIETS_ENTRY = inputEntries.find((e) => e.key === 'diets')
const dietWeights = reactive({ ...(DIETS_ENTRY?.weights || {}) })
watch(() => [...(chips.diets || [])], (sel) => {
  for (const d of sel) if (dietWeights[d] == null) dietWeights[d] = DIETS_ENTRY?.weights?.[d] ?? 5
}, { immediate: true })
const showDietMix = ref(false) // collapsed by default — it's an advanced override, not a primary field
const dietWeightSum = computed(() => (chips.diets || []).reduce((s, d) => s + (Number(dietWeights[d]) || 0), 0))
const dietPct = (d) => (dietWeightSum.value ? Math.round((Number(dietWeights[d]) || 0) / dietWeightSum.value * 100) : 0)
const dietCount = (d) => (dietWeightSum.value ? Math.ceil((Number(residents.value) || 0) * (Number(dietWeights[d]) || 0) / dietWeightSum.value) : 0)
const flags = reactive(Object.fromEntries(MENU_FLAGS.map((f) => [f.key, f.defaultEnabled])))
const weekdaysFlag = MENU_FLAGS.find((f) => f.key === 'business_days')
const residents = ref(300)

// Location = an IANA timezone (the single source of truth) — OPTIONAL. When set, the server derives
// region, hemisphere (season) and current date/time from it; when blank, those stay empty.
const location = ref('')
// Likely zones surfaced under a "Common" group first; the rest grouped by region (Africa, America,
// Asia, …). Each label carries the zone's CURRENT UTC offset so you don't have to know them.
const COMMON_TZ = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Europe/London', 'Europe/Paris', 'Asia/Tokyo', 'Australia/Sydney',
]
// "UTC-8" / "UTC+5:30" for the zone right now (DST-aware). Offset is absolute per zone, so it's
// the same server- or client-side — no hydration mismatch.
const tzOffset = (tz) => {
  try {
    const v = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value || ''
    return v.replace('GMT', 'UTC')
  } catch { return '' }
}
const enrich = (o, group) => ({ value: o.value, group, label: `${o.label}${tzOffset(o.value) ? ` (${tzOffset(o.value)})` : ''}` })
const locationOptions = (() => {
  const commonSet = new Set(COMMON_TZ)
  const common = COMMON_TZ
    .map((tz) => LOCATIONS.find((o) => o.value === tz))
    .filter(Boolean)
    .map((o) => enrich(o, 'Common'))
  const rest = LOCATIONS.filter((o) => !commonSet.has(o.value)).map((o) => enrich(o, o.value.split('/')[0].replace(/_/g, ' ')))
  return [...common, ...rest]
})()
// Default to the user's detected timezone — client-only (no SSR hydration mismatch), still optional
// (they can clear it), and a preset/rerun value wins (the guard skips when already set).
onMounted(() => {
  if (location.value) return
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (tz && LOCATIONS.some((o) => o.value === tz)) location.value = tz
})

// Cost tier override (default = institution-implied) — a budget/quality label.
const costTier = ref(COST_TIERS[0].key)
const costOptions = COST_TIERS.map((t) => ({ value: t.key, label: t.label }))
const costTierDescription = ref('')

// The chef's protein rotation. The list is PRODUCED by the categorization step (see fetchProteins);
// addedProteins holds only the names the chef typed, because that is what the step consumes.
const proteinRows = ref([])
const addedProteins = ref([])
const removedProteins = ref([]) // remembered so a later re-fetch can't hand a removed protein back
const proteinsPending = ref(false)
const addingProtein = ref(false)

// Course positions and their seeds mirror DEFAULT_COURSE_COUNTS in functions/entry/ai/menu.js —
// the server applies exactly these when courseCounts is absent, so the form must not show something
// else. 1 is omitted from the range on purpose: one dish is not a course.
const COURSE_POSITIONS = [
  { key: 'appetizer', label: 'Appetizer', default: 3 },
  { key: 'entree', label: 'Entrée', default: 2 },
  { key: 'side', label: 'Side', default: 3 },
]
const courseCountOptions = [{ value: 0, label: 'Not served' }, ...[2, 3, 4, 5, 6, 7].map((n) => ({ value: n, label: String(n) }))]
const courseCounts = reactive(Object.fromEntries(COURSE_POSITIONS.map((c) => [c.key, c.default])))
const loading = ref(false)

// Duration
const DURATIONS = [
  // TEST-ONLY: a 2-day span, so a run costs 2 days × diets units instead of a full week. Expressed
  // as a fraction of a week because the option value IS `weeks`; `days` below rounds it back to 2.
  { label: '2 days (TEST)', weeks: 2 / 7 },
  { label: '1 week', weeks: 1 }, { label: '2 weeks', weeks: 2 }, { label: '3 weeks', weeks: 3 },
  { label: '1 month', weeks: 4 }, { label: '6 weeks', weeks: 6 }, { label: '2 months', weeks: 8 },
  { label: '3 months', weeks: 12 },
]
const durationOptions = DURATIONS.map((d) => ({ value: d.weeks, label: d.label }))
const weeks = ref(2)
// "Weekdays" is the business_days flag (in the Options list), not a separate duration toggle.
const days = computed(() => Math.round(weeks.value * (flags.business_days ? 5 : 7)))

// Range built with dayjs: starts today, spans `days` calendar days (or weekdays when
// businessDaysOnly). dayjs gives the human-readable label and the start/end the plan range needs.
const start = ref(dayjs())
const end = computed(() => {
  if (!flags.business_days) return start.value.add(days.value - 1, 'day')
  let date = start.value, counted = 1
  while (counted < days.value) {
    date = date.add(1, 'day')
    const dow = date.day()
    if (dow !== 0 && dow !== 6) counted++ // skip Sat/Sun
  }
  return date
})
const durationHuman = computed(() =>
  `${start.value.format('ddd, MMM D')} → ${end.value.format('ddd, MMM D, YYYY')} · ${days.value} ${flags.business_days ? 'business ' : ''}days`
)

// Options
const { companies, users, companyOptions, userOptions, load: loadOptions } = useOrgData()

const loadAndDefault = async () => {
  try {
    await loadOptions()
    if (!companyId.value && companies.value[0]) companyId.value = companies.value[0]._id
    if (!userId.value && users.value[0]) userId.value = users.value[0].uid
  } catch (e) {
    showError('Failed to load options', e.message)
  }
}
onMounted(loadAndDefault)
watch(env, loadAndDefault)
watch(companyId, () => { if (!users.value.some((u) => u.uid === userId.value)) userId.value = users.value[0]?.uid || '' })

const canSubmit = computed(() =>
  !!companyId.value && !!userId.value && MENU_ENTRIES.some((e) => enabled[e.key])
)

// Stub — will eventually ask Remy (the AI) for suggested values for this entry. Not wired up yet.
const fetchDefaults = (e) => {
  success('Remy', `Remy suggestions for ${e.label.toLowerCase()} aren't wired up yet`)
}

const duration = computed(() => ({
  weeks: weeks.value,
  businessDaysOnly: flags.business_days,
  days: days.value,
  startDate: start.value.format('YYYY-MM-DD'),
  endDate: end.value.format('YYYY-MM-DD'),
}))
const valuesWire = () => Object.fromEntries(inputEntries.map((e) => [e.key, (chips[e.key] || []).join(',')]))
const dietWeightsWire = () => Object.fromEntries((chips.diets || []).map((d) => [d, Number(dietWeights[d]) || 0]))

// ── Protein list ── The chef never types a protein's diets: the `protein_dietary_categorization`
// step works them out. So the list is FILLED by running that step on its own, mid-form — a separate
// job from Generate. `enabled` gates by subtype and a step is only dropped on an explicit false, so
// every other key must be named false to keep this to ONE step.
const proteinJob = useJob()
// Only the NEWEST request may bind. Two fetches can overlap (a diet edit while one is in flight, or
// a hot reload), and the responses can come back out of order — binding whichever replied last left
// the list watching a job that was already superseded, waiting forever while a newer one finished.
let proteinFetchSeq = 0
const fetchProteins = async (extra = addedProteins.value) => {
  // Nothing to categorize against without diets — and no job without an owner.
  if (!companyId.value || !userId.value || !(chips.diets || []).length) return
  const seq = ++proteinFetchSeq
  // Minted before the POST so the orchestrator log can be joined to the request that caused it —
  // the jobId only exists in the reply, which is too late to correlate the way in.
  const clientRequestId = crypto.randomUUID()
  proteinsPending.value = true
  try {
    const { jobId } = await $fetch(`${aiBase.value}/menu`, {
      method: 'POST', timeout: 15000, headers: { Authorization: `Bearer ${await getToken()}` },
      body: {
        userId: userId.value,
        companyId: companyId.value,
        values: valuesWire(),
        duration: duration.value,
        residents: residents.value,
        flags: { ...flags },
        dietWeights: dietWeightsWire(),
        costTier: costTier.value,
        costTierDescription: costTierDescription.value,
        location: location.value,
        enabled: {
          protein_dietary_categorization: true, protein_grid: false, recipes: false, courses: false,
          nutrients: false, compliance: false, menu: false, recipe: false, nutrition: false,
          inventory: false, order_form: false,
        },
        addedProteins: [...extra],
        metadata: { clientRequestId },
      },
    })
    if (seq !== proteinFetchSeq) return // a newer fetch already owns the list — this reply is stale
    proteinJob.bind(jobId) // bind() clears the previous job's runs synchronously — no stale parse
  } catch (e) {
    if (seq !== proteinFetchSeq) return
    proteinsPending.value = false
    addingProtein.value = false
    showError('Protein list failed', e.data?.error || e.message)
  }
}

// The step answers with a pipe table. The HEADER names the columns (the model reorders them), and
// `protein` is the current name for the first column while `type` is the older one — accept either so
// an in-flight prompt change can't blank the list.
const parseProteinTable = (text) => {
  const lines = String(text || '').split('\n').map((l) => l.trim())
    .filter((l) => l.includes('|') && !l.startsWith('```'))
    .map((l) => l.split('|').map((c) => c.trim()))
    .filter((cells) => !cells.every((c) => !c || /^:?-{2,}:?$/.test(c)))
  const h = lines.findIndex((cells) => cells.some((c) => /^(protein|type)$/i.test(c)))
  if (h < 0) return []
  const header = lines[h].map((c) => c.toLowerCase())
  const iType = header.indexOf('protein') >= 0 ? header.indexOf('protein') : header.indexOf('type')
  const iCut = header.indexOf('cut'), iDiets = header.indexOf('diets')
  return lines.slice(h + 1)
    .map((cells) => ({
      protein: (cells[iType] ?? '').trim(),
      cut: iCut >= 0 ? (cells[iCut] ?? '').trim() : '',
      diets: iDiets >= 0 ? (cells[iDiets] ?? '').split(',').map((d) => d.trim()).filter(Boolean) : [],
      weight: 0,
    }))
    .filter((r) => r.protein && !/^(protein|type)$/i.test(r.protein)) // models re-quote the header line
}

// MERGE, never replace. A re-fetch (a diet or location change) must not discard the chef's curation:
// existing proteins keep their weight AND their position, only their diets refresh. Genuinely new
// proteins land at the bottom on weight 0 — visible, but out of the rotation until the chef weights
// them. First load only: nothing to preserve, so seed a descending pre-ranking to adjust from.
const mergeProteins = (fresh) => {
  const gone = new Set(removedProteins.value.map((p) => p.toLowerCase()))
  const seen = new Map(fresh.filter((r) => !gone.has(r.protein.toLowerCase())).map((r) => [r.protein.toLowerCase(), r]))
  const prev = proteinRows.value
  if (!prev.length) {
    const seed = [...seen.values()]
    proteinRows.value = seed.map((r, i) => ({ ...r, weight: Math.max(1, seed.length * 2 - i * 2) }))
    return
  }
  const kept = prev.map((p) => {
    const f = seen.get(p.protein.toLowerCase())
    seen.delete(p.protein.toLowerCase())
    return f ? { ...p, diets: f.diets, cut: f.cut || p.cut } : p
  })
  proteinRows.value = [...kept, ...seen.values()]
}

// The worker STREAMS a run's response, so `runs` updates many times while the table is still being
// written. Taking the first update that parsed kept row one and dropped the rest, because clearing
// the pending flag made every later chunk fall out of this watch. Wait for the run to be terminal.
const TERMINAL = new Set(['success', 'fail', 'error'])
watch(proteinJob.runs, (runs) => {
  if (!proteinsPending.value && !addingProtein.value) return
  const stepRuns = runs.filter((r) => r.step !== 'plan')
  if (!stepRuns.length || !stepRuns.every((r) => TERMINAL.has(r.status))) return
  const rows = parseProteinTable(stepRuns.map((r) => r.response || '').filter(Boolean).join('\n'))
  if (!rows.length) return
  mergeProteins(rows)
  proteinsPending.value = false
  addingProtein.value = false
}, { deep: true })

// A failed job never writes a parseable table, so the pending flags would otherwise spin forever.
watch(proteinJob.jobStatus, (s) => {
  if (s !== 'fail') return
  proteinsPending.value = false
  addingProtein.value = false
  showError('Protein list failed', 'Remy could not categorize these proteins — try again')
})

// The list is derived from the DIETS and the LOCATION (region drives availability), so it re-fetches
// when either changes — a stale list would offer proteins the new diets or region can't use.
// Keyed on a signature, not a boolean, and compared SYNCHRONOUSLY — a flag that only flips once
// could never re-fetch, and the synchronous compare is what stops a load-time race kicking several
// jobs at once. Mirrors the app's own trigger (CreatePlanPage.tsx:847-857): the list derives from the
// DIETS and the LOCATION, so those two alone key it.
const proteinsKey = computed(() => `${[...(chips.diets || [])].sort().join(',')}|${location.value}`)
let lastProteinsKey = null
// Watches the OWNER too, not just the key: the diets are seeded at init, so keying on them alone
// meant the first fetch waited for a change that never came. immediate:true covers the case where
// company and user are already resolved on mount.
// Coalesced: swapping a diet is a REMOVE then an ADD, two key changes a moment apart, and each one
// firing straight through launched its own job — the first already superseded before it was answered.
let proteinsSettle
watch([proteinsKey, companyId, userId], ([key]) => {
  if (!companyId.value || !userId.value || !(chips.diets || []).length) return
  if (lastProteinsKey === key) return
  clearTimeout(proteinsSettle)
  proteinsSettle = setTimeout(async () => {
    const settled = proteinsKey.value
    if (lastProteinsKey === settled) return
    lastProteinsKey = settled
    // REUSE BEFORE REBUILD. The guard above only suppresses repeats WITHIN this component instance;
    // `lastProteinsKey` is null again on every mount, so a reload or a hot reload re-asked a question
    // already answered. Bind a past success on this exact key instead — proteinJob.bind() feeds the
    // same parse whether the runs landed a second ago or this morning. Only a miss builds.
    proteinsPending.value = true
    const cached = await findCachedProteinsJob(settled, addedProteins.value, { fake: false }, companyId.value).catch(() => null)
    // The key can move while the lookup is in flight (a diet edit). Binding a job for the OLD key
    // would show a list the form no longer asked for, so drop a result that is no longer current.
    if (lastProteinsKey !== settled) return
    if (cached) { proteinJob.bind(cached); return }
    proteinsPending.value = false // fetchProteins owns the spinner from here
    void fetchProteins()
  }, 600)
}, { immediate: true })

const addProtein = (name) => {
  const k = name.toLowerCase()
  // Guard BOTH lists: a protein the step hasn't returned yet is in addedProteins but not in the
  // rows, so checking the rows alone let a second add through and the prompt read "Moose, Moose".
  if (proteinRows.value.some((p) => p.protein.toLowerCase() === k)) return
  if (addedProteins.value.some((p) => p.toLowerCase() === k)) return
  removedProteins.value = removedProteins.value.filter((p) => p.toLowerCase() !== k) // re-adding must bring it back
  addedProteins.value = [...addedProteins.value, name]
  addingProtein.value = true
  void fetchProteins(addedProteins.value)
}

// Local only — removing NEVER re-runs the step. Recorded so a later re-fetch can't hand it back, and
// dropped from addedProteins if the chef had typed it in.
const removeProtein = (name) => {
  const k = name.toLowerCase()
  if (!removedProteins.value.some((p) => p.toLowerCase() === k)) removedProteins.value = [...removedProteins.value, name]
  addedProteins.value = addedProteins.value.filter((p) => p.toLowerCase() !== k)
  proteinRows.value = proteinRows.value.filter((p) => p.protein.toLowerCase() !== k)
}

// Wire shape. A weight of 0 means "not in this rotation", so those rows are dropped; order is kept
// because it carries priority. Diets pass through as the categorization step wrote them — they are
// the model's answer, not a chef's tagging, so re-filtering them here would silently drop rows.
const proteinWeightsWire = computed(() =>
  proteinRows.value
    .filter((p) => p.protein?.trim() && (Number(p.weight) || 0) > 0)
    .map((p) => ({
      protein: p.protein.trim(),
      ...(p.cut?.trim() ? { cut: p.cut.trim() } : {}),
      diets: [...(p.diets || [])],
      weight: Number(p.weight) || 0,
    }))
)

// ── Load a saved plan (from history) into the form, then track whether it's been edited. ──
// preset = { jobId, input } (input = the blob /ai/menu saved to menuPlans). Hydrate every field, then
// snapshot the signature: the button reads "Rerun" while the form still matches the loaded plan and
// flips to "Generate" the moment anything changes. Rerun reuses the same job; Generate makes a new one.
const loadedJobId = ref(null)
const loadedSig = ref(null)
const currentSig = computed(() => JSON.stringify({
  companyId: companyId.value, userId: userId.value,
  values: Object.fromEntries(inputEntries.map((e) => [e.key, (chips[e.key] || []).join(',')])),
  weeks: weeks.value, businessDaysOnly: flags.business_days, residents: residents.value,
  flags: { ...flags }, costTier: costTier.value, location: location.value,
  dietWeights: Object.fromEntries((chips.diets || []).map((d) => [d, Number(dietWeights[d]) || 0])),
  proteinWeights: proteinWeightsWire.value, addedProteins: addedProteins.value,
  courseCounts: { ...courseCounts }, costTierDescription: costTierDescription.value,
  enabled: { ...enabled },
}))
const dirty = computed(() => loadedSig.value != null && currentSig.value !== loadedSig.value)
const mode = computed(() => (loadedJobId.value && !dirty.value) ? 'rerun' : 'generate')

const hydrate = (input) => {
  if (!input) return
  for (const e of inputEntries) {
    const raw = input.values?.[e.key]
    chips[e.key] = typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : []
  }
  if (input.duration?.weeks != null) weeks.value = input.duration.weeks
  if (input.residents != null) residents.value = input.residents
  if (input.flags) Object.assign(flags, input.flags)
  if (input.costTier != null) costTier.value = input.costTier
  if (input.location != null) location.value = input.location
  if (input.dietWeights) Object.assign(dietWeights, input.dietWeights)
  if (input.costTierDescription != null) costTierDescription.value = input.costTierDescription
  proteinRows.value = (input.proteinWeights || []).map((p) => ({ protein: p.protein, cut: p.cut || '', diets: [...(p.diets || [])], weight: p.weight ?? 0 }))
  addedProteins.value = [...(input.addedProteins || [])]
  // A loaded plan already carries its protein list. Claim the key it would produce so the watch
  // treats this as seen — otherwise the load itself launches a job that merges over what was saved.
  if (proteinRows.value.length) lastProteinsKey = proteinsKey.value
  if (input.courseCounts) Object.assign(courseCounts, input.courseCounts)
  if (input.enabled) Object.assign(enabled, input.enabled)
}
watch(() => props.preset, (p) => {
  if (!p) { loadedJobId.value = null; loadedSig.value = null; return }
  hydrate(p.input)
  loadedJobId.value = p.jobId || null
  loadedSig.value = currentSig.value // snapshot AFTER hydration → the loaded form starts "clean"
}, { immediate: true })

const submit = async () => {
  if (!canSubmit.value || loading.value) return
  // Rerun = recompose from the CURRENT form (so toggle/diet edits ARE honored), reuse the same job,
  // wipe its old runs, re-launch. Generate = same but a new job. Both POST /menu; rerun adds jobId.
  const reran = mode.value === 'rerun'
  // An enabled input entry with no values would run blind — block and say which.
  const empty = inputEntries.filter((e) => enabled[e.key] && !(chips[e.key] || []).length)
  if (empty.length) {
    showError('Empty field', `${empty.map((e) => e.label).join(', ')} ${empty.length > 1 ? 'are' : 'is'} enabled but empty — add values or turn it off`)
    return
  }
  loading.value = true
  try {
    const body = {
      userId: userId.value,
      companyId: companyId.value,
      // every input entry's chips → comma-delimited string, keyed by entry key (spaces kept)
      values: valuesWire(),
      duration: duration.value,
      residents: residents.value,
      flags: { ...flags },
      costTier: costTier.value,
      location: location.value,
      // per-diet relative weights, only for the diets actually selected → server {{allocate}} split
      dietWeights: dietWeightsWire(),
      enabled: { ...enabled },
      // Each of these is OMITTED when empty rather than sent blank, so the server's own defaults
      // still apply (absent courseCounts = DEFAULT_COURSE_COUNTS).
      ...(proteinWeightsWire.value.length ? { proteinWeights: proteinWeightsWire.value } : {}),
      ...(addedProteins.value.length ? { addedProteins: [...addedProteins.value] } : {}),
      ...(Object.keys(courseCounts).length ? { courseCounts: { ...courseCounts } } : {}),
      ...(costTierDescription.value.trim() ? { costTierDescription: costTierDescription.value.trim() } : {}),
      ...(reran ? { jobId: loadedJobId.value } : {}), // rerun → recompose & re-run THIS job in place
    }
    const { jobId } = await $fetch(`${aiBase.value}/menu`, { method: 'POST', timeout: 15000, body, headers: { Authorization: `Bearer ${await getToken()}` } })
    success(reran ? 'Rerun started' : 'Menu plan launched', `${reran ? 'Plan' : 'Job'} ${jobId.slice(0, 8)}…`)
    emit(reran ? 'rerun' : 'created', jobId)
    // The form now matches the saved plan again → button flips back to Rerun (clean).
    loadedJobId.value = jobId
    loadedSig.value = currentSig.value
  } catch (e) {
    showError(reran ? 'Rerun failed' : 'Failed to launch', e.data?.error || e.message)
  } finally {
    loading.value = false
  }
}
</script>
