import { resolveEnv } from '../../utils/envConfig'
import { getMongoClient } from '../../utils/mongo'
import { gcpAccessToken } from '../../utils/gcpToken'

// Capacity scoreboard read model for pages/capacity.vue.
// Reads `region_capacity_state` (one doc/region) and aggregates
// `region_capacity_stats` (one doc per region+daypart+day, daypart = "mon-14")
// into a per-region × 24-hour view for the CURRENT day-of-week.
//
// Mongo-unreachable is returned as an { ok: false, error } payload (HTTP 200) so
// the page renders its error state instead of the request crashing (UC2 E1).

// Tuning params — mirror the controller defaults (plan §Scope/Controller). Only
// the ow/fw ratio affects ranking; surfaced here for the operator to review.
const OW = 1.95
const FW = 0.95
const WINDOW_DAYS = 30
const MAX_STOCKOUTS = parseInt(process.env.CAPACITY_MAX_STOCKOUTS || '', 10) || 3 // mirror controller: park a region after this many stockouts in a row
const LOW_SAMPLE = 5 // n below this dims the cell (low confidence)


// score = ow·Σok − fw·Σfail. Empty window (no rows) → null (no data / hatched).
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const score = (ok: number, fail: number) =>
  Math.round((OW * ok - FW * fail) * 100) / 100

type Cell = { hour: number; ok: number; fail: number; n: number; score: number }
type RegionRow = {
  region: string
  mode: 'on' | 'off' | null
  consecutiveStockouts: number // current stockouts-in-a-row streak (resets on any success)
  parked: boolean // streak has reached MAX_STOCKOUTS → excluded from exploit selection
  lastSuccessTs: string | null
  lastStockoutTs: string | null
  stockouts: number // in-window stockout (fail) count for the current day-of-week
  successes: number // in-window successful-create (ok) count for the current day-of-week
  currentScore: number | null
  boxes?: number // live MIG target size in this region (boxes up now); prod-only, 0 when idle/unknown
  hours: (Cell | null)[] // length 24, null = no data
}

const TIMELINE_WINDOWS = [7, 14, 30] // selectable rolling-timeline windows (days)

export default defineEventHandler(async (event) => {
  const { env, days: daysQ } = getQuery(event)
  const cfg = resolveEnv(env as string)

  // Rolling-timeline window (days). Only the whitelisted windows; default 7d.
  const reqDays = parseInt(String(daysQ), 10)
  const timelineDays = TIMELINE_WINDOWS.includes(reqDays) ? reqDays : 7

  // DB stores dayparts in UTC (store.js). Convert to the display timezone HERE so the UI shows local
  // hours + day while storage stays UTC. Whole-hour offset derived from the current instant.
  const tz = process.env.CAPACITY_TZ || 'America/Los_Angeles'
  const now = new Date()
  const wp = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const wpv = (t: string) => wp.find((p) => p.type === t)?.value || ''
  const wallAsUTC = Date.UTC(+wpv('year'), +wpv('month') - 1, +wpv('day'), +wpv('hour'), +wpv('minute'), +wpv('second'))
  const offsetH = Math.round((wallAsUTC - now.getTime()) / 3600000) // e.g. Pacific → -7
  const dow = wpv('weekday').toLowerCase()      // local day-of-week (label + summary day)
  const localDowIdx = DOW.indexOf(dow)
  let nowHour = +wpv('hour'); if (nowHour === 24) nowHour = 0 // local current hour
  const tzAbbr = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(now).find((p) => p.type === 'timeZoneName')?.value || tz
  // A LOCAL hour on the current local day → the UTC daypart key holding its bucket (handles day-wrap).
  const utcKeyForLocalHour = (localH: number) => {
    const raw = localH - offsetH
    const utcHour = ((raw % 24) + 24) % 24
    const utcDow = DOW[(((localDowIdx + Math.floor(raw / 24)) % 7) + 7) % 7]
    return `${utcDow}-${String(utcHour).padStart(2, '0')}`
  }

  try {
    const client = await getMongoClient(cfg.mongoUri!)
    const db = client.db(cfg.mongoDb)

    // Region filter (config) — validate the stored regex so a broken one surfaces in the UI rather
    // than silently steering everywhere/nowhere. Body is anchored ^(body), matching regions.js.
    const cfgDoc = await db.collection('region_capacity_meta').findOne({ _id: 'config' } as any)
    const regionFilter: string = (cfgDoc as any)?.regionFilter ?? 'us-'
    let regionFilterError: string | null = null
    try { new RegExp(`^(${regionFilter})`) } catch (e: any) {
      regionFilterError = `Invalid region filter /^(${regionFilter})/: ${e?.message || e}`
    }

    // Per-region state docs.
    const stateDocs = await db
      .collection('region_capacity_state')
      .find({})
      .toArray()

    // Aggregate the whole window by (region, UTC daypart). We remap to the current LOCAL day's 24
    // columns below via utcKeyForLocalHour — so early local hours can pull from the previous UTC day.
    const stats = await db
      .collection('region_capacity_stats')
      .aggregate([
        { $group: { _id: { region: '$region', daypart: '$daypart' }, ok: { $sum: '$ok' }, fail: { $sum: '$fail' } } },
      ])
      .toArray()

    // region -> UTC daypart key -> {ok, fail}
    const byRegion: Record<string, Record<string, { ok: number; fail: number }>> = {}
    for (const s of stats) {
      ;(byRegion[s._id.region as string] ||= {})[s._id.daypart as string] = { ok: s.ok || 0, fail: s.fail || 0 }
    }

    // Discovered L4 candidate set (region_capacity_meta/l4_regions) — the SAME topology the
    // controller scores against. Stored as the FULL global `[region, [zones]]` topology; take the
    // region name and keep only those matching the region filter, exactly as regions.js does. Included
    // so a candidate region with no outcomes yet still shows (as "no success yet"), instead of the
    // list silently undercounting vs the shadow decision.
    const l4Doc = await db.collection('region_capacity_meta').findOne({ _id: 'l4_regions' } as any)
    const rawTopology: any[] = Array.isArray((l4Doc as any)?.regions) ? (l4Doc as any).regions : []
    const filterRe = regionFilterError ? null : new RegExp(`^(${regionFilter})`)
    const discovered: string[] = rawTopology
      .map((e) => (Array.isArray(e) ? e[0] : e))
      .filter((r): r is string => typeof r === 'string' && (!filterRe || filterRe.test(r)))

    // Union of regions: discovered candidates + any seen in either collection.
    const regionNames = new Set<string>([
      ...discovered,
      ...stateDocs.map((d: any) => d.region).filter(Boolean),
      ...Object.keys(byRegion),
    ])

    const stateByRegion: Record<string, any> = {}
    for (const d of stateDocs) stateByRegion[d.region] = d

    const regions: RegionRow[] = [...regionNames].map((region) => {
      const st = stateByRegion[region] || {}
      const dp = byRegion[region] || {}
      let stockouts = 0
      let successes = 0
      const hours: (Cell | null)[] = []
      for (let L = 0; L < 24; L++) {
        const d = dp[utcKeyForLocalHour(L)] // local hour L → its UTC bucket
        if (!d) {
          hours.push(null)
          continue
        }
        stockouts += d.fail
        successes += d.ok
        hours.push({
          hour: L,
          ok: d.ok,
          fail: d.fail,
          n: d.ok + d.fail,
          score: score(d.ok, d.fail),
        })
      }
      return {
        region,
        mode: (st.mode as 'on' | 'off') ?? null,
        consecutiveStockouts: st.consecutiveStockouts ?? 0,
        parked: (st.consecutiveStockouts ?? 0) >= MAX_STOCKOUTS,
        lastSuccessTs: st.lastSuccessTs ? new Date(st.lastSuccessTs).toISOString() : null,
        lastStockoutTs: st.lastStockoutTs ? new Date(st.lastStockoutTs).toISOString() : null,
        stockouts,
        successes,
        currentScore: hours[nowHour]?.score ?? null,
        hours,
      }
    })

    // Mockup ordering: current-hour score desc (no-data last).
    regions.sort((a, b) => (b.currentScore ?? -Infinity) - (a.currentScore ?? -Infinity))

    // --- Rolling N-day timeline -------------------------------------------------
    // Continuous strip of the last `timelineDays` LOCAL days × 24 local hours (no
    // day-of-week collapsing). Buckets are stored per (region, UTC calendar date,
    // UTC hour); map each LOCAL (date, hour) slot to its UTC bucket using the same
    // whole-hour offset the grid uses (fixed at the current instant — DST shifts
    // inside the window are approximated, matching the grid's own convention).
    const DAY_MS = 86400000
    const baseLocalMs = Date.UTC(+wpv('year'), +wpv('month') - 1, +wpv('day')) // local today @ 00:00, as ms for date math only
    const ymd = (ms: number) => {
      const d = new Date(ms)
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    }
    // LOCAL (dayMs, hour) → "utcDate|hh" bucket key (handles day-wrap across the offset).
    const utcBucketKey = (localDayMs: number, localH: number) => {
      const raw = localH - offsetH
      const utcHour = ((raw % 24) + 24) % 24
      const utcDayMs = localDayMs + Math.floor(raw / 24) * DAY_MS
      return `${ymd(utcDayMs)}|${String(utcHour).padStart(2, '0')}`
    }

    // Ordered slots (oldest→newest). prevKey = same local clock-hour 24h earlier (x-ray underlay).
    const tlDates: string[] = []
    const slots: { date: string; hour: number; key: string; prevKey: string }[] = []
    for (let d = 0; d < timelineDays; d++) {
      const localDayMs = baseLocalMs - (timelineDays - 1 - d) * DAY_MS
      tlDates.push(ymd(localDayMs))
      for (let h = 0; h < 24; h++) {
        slots.push({
          date: ymd(localDayMs),
          hour: h,
          key: utcBucketKey(localDayMs, h),
          prevKey: utcBucketKey(localDayMs - DAY_MS, h),
        })
      }
    }

    // Raw per-day/hour rows (NOT the day-of-week aggregate above). Bound by the oldest
    // UTC date any slot (incl. its 24h-prior underlay) can reach; string compare is safe on YYYY-MM-DD.
    const cutoff = ymd(baseLocalMs - (timelineDays + 1) * DAY_MS)
    const rawStats = await db
      .collection('region_capacity_stats')
      .find({ day: { $gte: cutoff } } as any, { projection: { _id: 0, region: 1, daypart: 1, day: 1, ok: 1, fail: 1 } })
      .toArray()

    // region -> "utcDate|hh" -> {ok, fail}
    const tlByRegion: Record<string, Record<string, { ok: number; fail: number }>> = {}
    for (const s of rawStats as any[]) {
      const hh = String(s.daypart || '').split('-')[1] || '00'
      const key = `${s.day}|${hh}`
      const m = (tlByRegion[s.region] ||= {})
      const cur = m[key] || { ok: 0, fail: 0 }
      cur.ok += s.ok || 0
      cur.fail += s.fail || 0
      m[key] = cur
    }

    // Same region ordering as the grid. Each cell always emitted (empty → n:0, score:null → hatched).
    const timeline = regions.map((r) => {
      const m = tlByRegion[r.region] || {}
      const cells = slots.map((sl) => {
        const cur = m[sl.key]
        const prev = m[sl.prevKey]
        return {
          ts: `${sl.date} ${String(sl.hour).padStart(2, '0')}:00`,
          date: sl.date,
          hour: sl.hour,
          ok: cur?.ok ?? 0,
          fail: cur?.fail ?? 0,
          n: cur ? cur.ok + cur.fail : 0,
          score: cur ? score(cur.ok, cur.fail) : null,
          prevOk: prev?.ok ?? null,
          prevFail: prev?.fail ?? null,
          prevScore: prev ? score(prev.ok, prev.fail) : null,
        }
      })
      return { region: r.region, cells }
    })

    // Active regions — the DIRECT-INVENTORY truth: which regions currently hold boxes (MIG
    // targetSize > 0). There is NO single "active region": the controller runs many regions together,
    // and idle-shutdown can scale any of them down on its own — so the ONLY reliable source is the live
    // MIG sizes, read here (this is OBSERVATION, not a decision; the controller still owns steering).
    // Prod only (local runs workers in Docker, no MIGs). Best-effort: a compute error → no live
    // inventory, never a scoreboard crash.
    const boxesByRegion: Record<string, number> = {}
    if (cfg.env === 'production') {
      const projectId = (useRuntimeConfig() as any).gcpProjectId || process.env.GCP_PROJECT_ID
      if (projectId) {
        try {
          const { slugOf, MODELS } = (await import('#models')) as { slugOf: (m: any) => string; MODELS: any[] }
          const migNames = new Set(MODELS.map((m) => `ollama-${slugOf(m)}-mig`))
          const token = await gcpAccessToken()
          const url = `https://compute.googleapis.com/compute/v1/projects/${projectId}/aggregated/instanceGroupManagers`
          const res: any = await $fetch(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 })
          for (const [scope, val] of Object.entries<any>(res?.items ?? {})) {
            const region = scope.replace(/^.*\//, '').replace(/-[a-z]$/, '') // "regions/us-east1" | "zones/us-east1-b" → us-east1
            for (const mig of val?.instanceGroupManagers ?? []) {
              if (migNames.has(mig.name)) boxesByRegion[region] = (boxesByRegion[region] || 0) + (mig.targetSize ?? 0)
            }
          }
        } catch { /* non-fatal — no creds/perms → no live inventory, dash still renders */ }
      }
    }
    const activeRegions = Object.keys(boxesByRegion).filter((r) => boxesByRegion[r] > 0).sort()
    const activeRegion = activeRegions[0] ?? null // back-compat for older consumers
    for (const r of regions) (r as any).boxes = boxesByRegion[r.region] || 0

    // The recommendation is READ from the stored decision — the controller keeps wouldOpen fresh on
    // every event (enqueue/stockout/outcome all end by re-deciding and writing it), so the dashboard
    // computes nothing (plan §Principle: the controller is the brain, the UI is a dumb display). Take
    // the state doc with the newest decidedAt that carries a wouldOpen; wouldPark from that same doc
    // (falling back to "every other region" if the stored list is empty).
    const decided = stateDocs
      .filter((d: any) => d.wouldOpen && d.decidedAt != null)
      .sort((a: any, b: any) => (b.decidedAt as number) - (a.decidedAt as number))[0]
    const wouldOpen: string | null = (decided as any)?.wouldOpen ?? null
    const wouldPark: string[] =
      Array.isArray((decided as any)?.wouldPark) && (decided as any).wouldPark.length
        ? (decided as any).wouldPark
        : wouldOpen
          ? [...regionNames].filter((r) => r !== wouldOpen)
          : []

    const totalRows = stats.length
    // Least-bad: highest current-hour score even when all are ≤ 0.
    const ranked = regions.filter((r) => r.currentScore !== null)
    const leastBad = ranked[0] ?? null
    const allNegative = ranked.length > 0 && ranked.every((r) => (r.currentScore ?? 0) <= 0)

    return {
      ok: true,
      now: nowHour,
      dow,
      tz: tzAbbr,
      generatedAt: now.toISOString(),
      activeRegion,
      activeRegions,
      boxesByRegion,
      params: { ow: OW, fw: FW, windowDays: WINDOW_DAYS, maxStockouts: MAX_STOCKOUTS, lowSample: LOW_SAMPLE, max: 25 },
      regionFilter,
      regionFilterError,
      regions,
      phase: wouldOpen ? 1 : 2,
      wouldOpen,
      wouldPark,
      allNegative,
      leastBad: leastBad ? { region: leastBad.region, score: leastBad.currentScore } : null,
      dayOne: totalRows === 0,
      seedRegion: activeRegion ?? wouldOpen ?? regions[0]?.region ?? null,
      timeline: { days: timelineDays, hoursPerDay: 24, dates: tlDates, regions: timeline },
    }
  } catch (err: any) {
    console.error('Failed to read capacity scoreboard:', err)
    // Error payload, not a crash — the page shows its error state (UC2 E1).
    return {
      ok: false,
      error: `MongoDB unreachable: ${err?.message || String(err)}`,
      now: nowHour,
      dow,
      tz: tzAbbr,
    }
  }
})
