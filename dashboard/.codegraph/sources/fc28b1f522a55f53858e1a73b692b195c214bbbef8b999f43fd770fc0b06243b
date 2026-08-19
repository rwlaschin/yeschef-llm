import { ref, computed, watch, effectScope, onMounted, onBeforeUnmount, type Ref } from 'vue'
import { useEnvironment, type AppEnv } from './useEnvironment'

/**
 * THE health check. Single source of truth — within a tab AND across tabs.
 *
 * Within a tab:
 *  - Module-scoped state → one instance no matter how many components call useHealth().
 *  - Non-overlapping poll (next tick only after the current /api/health settles).
 *
 * Across tabs (the interesting part):
 *  - LEADER ELECTION via the Web Locks API. Every tab requests the same lock; the one
 *    that holds it is the leader and the ONLY tab that polls. The lock is released when
 *    that tab closes, so another tab is promoted automatically — no heartbeat needed.
 *  - The leader broadcasts each result over a BroadcastChannel; follower tabs render from
 *    those messages and never hit the network.
 *  - localStorage holds the last result, so a freshly-opened tab shows status instantly,
 *    before the next broadcast.
 *  - A follower's refresh()/env-change asks the leader to re-check (it owns the network).
 *  - No Web Locks (old browser) → graceful fallback: this tab polls on its own.
 *
 * Components only ever READ health/segments/statusColor from here.
 */

export interface HealthEntry { ok: boolean; error?: string; instances?: number }
export interface HealthState {
  databases: { mongodb: HealthEntry; firebase: HealthEntry; neo4j: HealthEntry }
  pubsub: HealthEntry
  orchestrator: HealthEntry
  models: Record<string, HealthEntry>
}

const INTERVAL_MS = 5000
const LOCK_NAME = 'yeschef-health-leader'
const CHANNEL_NAME = 'yeschef-health'
const LS_KEY = 'yeschef-health-state'

const offline = (error = ''): HealthState => ({
  databases: { mongodb: { ok: false, error }, firebase: { ok: false, error }, neo4j: { ok: false, error } },
  pubsub: { ok: false, error },
  orchestrator: { ok: false, error },
  models: {},
})

// ---- singleton state (module scope = one instance for the whole app) ----
const health = ref<HealthState>(offline())
const lastChecked = ref<number | null>(null)
const checking = ref(false)
const isLeader = ref(false)

let envRef: Ref<AppEnv> | null = null
let consumers = 0
let timer: ReturnType<typeof setTimeout> | null = null
let looping = false       // synchronous guard against starting two loops in the grant race
let running = false       // ≥1 mounted consumer in THIS tab
let wired = false
let channel: BroadcastChannel | null = null
let fetchAbort: AbortController | null = null

function applyState(state: HealthState, ts: number) {
  health.value = state
  lastChecked.value = ts
}

function persistAndBroadcast(ts: number) {
  // health.value is a Vue reactive PROXY — BroadcastChannel's structured clone can't serialize
  // it (DataCloneError). JSON round-trip → a plain, cloneable snapshot for both sinks.
  const payload = JSON.parse(JSON.stringify(health.value))
  try { localStorage.setItem(LS_KEY, JSON.stringify({ payload, ts })) } catch { /* quota/SSR */ }
  channel?.postMessage({ type: 'state', payload, ts })
}

async function fetchOnce() {
  // Followers don't touch the network — they ask the leader to re-check and wait for the
  // broadcast. (If we're standalone/leader, isLeader is true and we fall through.)
  if (!isLeader.value) { channel?.postMessage({ type: 'refresh' }); return }
  // Cancel any in-flight request (e.g. env switched mid-check).
  fetchAbort?.abort()
  fetchAbort = new AbortController()
  const signal = fetchAbort.signal
  checking.value = true
  try {
    // $fetch (Nuxt global) works outside setup — safe in the setTimeout tick.
    health.value = await $fetch<HealthState>(`/api/health?env=${envRef?.value ?? 'local'}`, { signal })
  } catch (e: any) {
    if ((e as any)?.name === 'AbortError' || signal.aborted) return // superseded — discard silently
    const msg = e?.status === 404 || String(e?.message).includes('fetch') ? 'Backend offline' : 'Check failed'
    health.value = offline(msg)
  } finally {
    if (!signal.aborted) {
      checking.value = false
      persistAndBroadcast(Date.now())
    }
  }
}

function loop() {
  if (!running || !isLeader.value) { looping = false; return }
  fetchOnce().finally(() => {
    if (running && isLeader.value) timer = setTimeout(loop, INTERVAL_MS)
    else looping = false
  })
}
function startLoop() {
  if (looping || !running || !isLeader.value) return
  looping = true
  loop()
}
function stopLoop() {
  looping = false
  if (timer) { clearTimeout(timer); timer = null }
}

// Run once per tab, client-side: seed from storage, wire the channel, contend for leadership.
function initCrossTab() {
  // Seed immediately from the last known result so a new tab isn't blank.
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) { const { payload, ts } = JSON.parse(raw); if (payload) applyState(payload, ts) }
  } catch { /* ignore */ }

  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME)
    channel.onmessage = (ev) => {
      const msg = ev.data
      if (msg?.type === 'state') applyState(msg.payload, msg.ts)
      else if (msg?.type === 'refresh' && isLeader.value) fetchOnce()
    }
  }

  const locks = (globalThis.navigator as any)?.locks
  if (locks?.request) {
    // The callback runs only WHEN this tab acquires the lock (becomes leader); returning a
    // never-settling promise holds the lock for the tab's lifetime. On close, the next
    // queued tab gets it and becomes the leader.
    locks.request(LOCK_NAME, { mode: 'exclusive' }, () => new Promise<void>(() => {
      isLeader.value = true
      startLoop() // begin polling now that we own the network (no-op if no consumers yet)
    }))
  } else {
    // No coordination available — degrade to per-tab polling.
    isLeader.value = true
    startLoop()
  }
}

// ---- derived: single source of truth for the meter / summary text / counts ----
// One FLAT list of every individual check (core services + each model), so the ring,
// the counts, and the color all agree. Generic: N grows/shrinks with the model list.
export interface HealthSegment { key: string; label: string; ok: boolean; error?: string }
const segments = computed<HealthSegment[]>(() => {
  const h = health.value
  const list: HealthSegment[] = [
    { key: 'mongodb', label: 'MongoDB', ok: h.databases.mongodb.ok, error: h.databases.mongodb.error },
    { key: 'firebase', label: 'Firebase', ok: h.databases.firebase.ok, error: h.databases.firebase.error },
    { key: 'neo4j', label: 'Neo4j', ok: h.databases.neo4j.ok, error: h.databases.neo4j.error },
    { key: 'pubsub', label: 'Pub/Sub', ok: h.pubsub.ok, error: h.pubsub.error },
    { key: 'orchestrator', label: 'Orchestrator', ok: h.orchestrator.ok, error: h.orchestrator.error },
  ]
  for (const [name, m] of Object.entries(h.models)) {
    list.push({ key: `model:${name}`, label: name, ok: m.ok, error: m.error })
  }
  return list
})
const healthy = computed(() => segments.value.filter((c) => c.ok).length)
const total = computed(() => segments.value.length)
const statusColor = computed(() =>
  healthy.value === total.value ? 'bg-green-500' : healthy.value === 0 ? 'bg-red-500' : 'bg-yellow-500')
const statusText = computed(() =>
  healthy.value === total.value ? 'All Services Online'
    : healthy.value === 0 ? 'No Services Online'
      : `${healthy.value}/${total.value} Services Online`)

export const useHealth = () => {
  // Wire env-change re-check + cross-tab coordination ONCE. Done in setup context (first
  // call), inside a detached scope so the watcher outlives the initiating component.
  if (!wired) {
    wired = true
    const { env } = useEnvironment()
    envRef = env
    effectScope(true).run(() => {
      watch(env, () => { if (running) fetchOnce() })
    })
    if (import.meta.client) initCrossTab()
  }

  // Ref-counted: track whether THIS tab has a live consumer. Only the leader actually
  // polls; followers just keep the shared state mounted.
  onMounted(() => { consumers++; if (consumers === 1) { running = true; startLoop() } })
  onBeforeUnmount(() => { consumers = Math.max(0, consumers - 1); if (consumers === 0) { running = false; stopLoop() } })

  return { health, segments, healthy, total, statusColor, statusText, lastChecked, checking, isLeader, refresh: fetchOnce }
}
