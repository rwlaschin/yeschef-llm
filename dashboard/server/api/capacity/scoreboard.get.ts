import { resolveEnv } from '../../utils/envConfig'
import { getMongoClient } from '../../utils/mongo'

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
const COOLDOWN_MIN = 10
const LOW_SAMPLE = 5 // n below this dims the cell (low confidence)


// score = ow·Σok − fw·Σfail. Empty window (no rows) → null (no data / hatched).
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const score = (ok: number, fail: number) =>
  Math.round((OW * ok - FW * fail) * 100) / 100

type Cell = { hour: number; ok: number; fail: number; n: number; score: number }
type RegionRow = {
  region: string
  mode: 'on' | 'off' | null
  cooldownUntil: string | null
  lastSuccessTs: string | null
  lastStockoutTs: string | null
  stockouts: number // in-window stockout (fail) count for the current day-of-week
  successes: number // in-window successful-create (ok) count for the current day-of-week
  currentScore: number | null
  hours: (Cell | null)[] // length 24, null = no data
}

export default defineEventHandler(async (event) => {
  const { env } = getQuery(event)
  const cfg = resolveEnv(env as string)

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
        cooldownUntil: st.cooldownUntil ? new Date(st.cooldownUntil).toISOString() : null,
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

    const activeRegion = stateDocs.find((d: any) => d.mode === 'on')?.region ?? null

    // Phase 1 records wouldOpen / wouldPark on state docs (observe-only). Read
    // them if present; wouldPark defaults to "every other known region".
    const decisionDoc: any = stateDocs.find((d: any) => d.wouldOpen) || {}
    const wouldOpen: string | null = decisionDoc.wouldOpen ?? null
    const wouldPark: string[] = wouldOpen
      ? decisionDoc.wouldPark ?? [...regionNames].filter((r) => r !== wouldOpen)
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
      params: { ow: OW, fw: FW, windowDays: WINDOW_DAYS, cooldownMin: COOLDOWN_MIN, lowSample: LOW_SAMPLE, max: 25 },
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
