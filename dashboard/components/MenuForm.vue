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
const loading = ref(false)

// Duration
const DURATIONS = [
  { label: '1 week', weeks: 1 }, { label: '2 weeks', weeks: 2 }, { label: '3 weeks', weeks: 3 },
  { label: '1 month', weeks: 4 }, { label: '6 weeks', weeks: 6 }, { label: '2 months', weeks: 8 },
  { label: '3 months', weeks: 12 },
]
const durationOptions = DURATIONS.map((d) => ({ value: d.weeks, label: d.label }))
const weeks = ref(2)
// "Weekdays" is the business_days flag (in the Options list), not a separate duration toggle.
const days = computed(() => weeks.value * (flags.business_days ? 5 : 7))

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
      values: Object.fromEntries(inputEntries.map((e) => [e.key, (chips[e.key] || []).join(',')])),
      duration: {
        weeks: weeks.value,
        businessDaysOnly: flags.business_days,
        days: days.value,
        startDate: start.value.format('YYYY-MM-DD'),
        endDate: end.value.format('YYYY-MM-DD'),
      },
      residents: residents.value,
      flags: { ...flags },
      costTier: costTier.value,
      location: location.value,
      // per-diet relative weights, only for the diets actually selected → server {{allocate}} split
      dietWeights: Object.fromEntries((chips.diets || []).map((d) => [d, Number(dietWeights[d]) || 0])),
      enabled: { ...enabled },
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
