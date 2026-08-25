import { watch, readFileSync, existsSync, mkdirSync, type FSWatcher } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAllStartupStates } from '#devbox'

// Event-based fleet + startup-progress delivery: fs.watch on the two state files the
// detached devbox processes write — every change is pushed to every open page. The client
// never polls. While a stream is open AND the fleet has active boxes, this also keeps the
// snapshot fresh by kicking the detached refresher (a box deleted remotely — e.g. by its
// own idle watchdog — emits no local event otherwise).
const STARTUP_DIR = process.env.DEVBOX_STARTUP_DIR || join(process.env.HOME || '', '.yeschef-devbox-startup')
const FLEET_FILE = process.env.DEVBOX_FLEET_FILE || join(process.env.HOME || '', '.yeschef-devbox-fleet.json')
const REFRESH_MS = 20000

function devboxScript() {
  const candidates = [
    fileURLToPath(new URL('../../../../scripts/devbox.js', import.meta.url)),
    resolve(process.cwd(), '../scripts/devbox.js'),
    resolve(process.cwd(), 'scripts/devbox.js'),
  ]
  return candidates.find((c) => existsSync(c))
}

let refreshing = 0
function kickRefresh() {
  if (refreshing && Date.now() - refreshing < 60000) return
  const script = devboxScript()
  if (!script) return
  refreshing = Date.now()
  const child = spawn(process.execPath, [script, 'snapshot'], { stdio: 'ignore', detached: true })
  child.on('exit', () => { refreshing = 0 })
  child.unref()
}

const readJson = (path: string) => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
}

export default defineEventHandler((event) => {
  const stream = createEventStream(event)

  const pushProgress = () => {
    const state: Record<string, any> = readAllStartupStates()
    // Staleness means "writer died". hunting/installing write every few seconds, so 3 min
    // of silence is a dead writer; the model pull is ONE blocking exec for up to ~30 min,
    // so 'pulling' gets a TTL sized to the pull, not to the heartbeat.
    for (const [name, s] of Object.entries(state) as [string, any][]) {
      const ttl = s?.phase === 'pulling' ? 35 * 60000 : 180000
      if (Date.now() - (s?.timestamp || 0) > ttl) delete state[name]
    }
    stream.push(JSON.stringify({ progress: state })).catch(() => {})
  }

  // The fleet file changing IS the event "box status changed" — the client re-fetches once.
  const pushFleet = () => { stream.push(JSON.stringify({ fleet: true })).catch(() => {}) }

  const watchers: FSWatcher[] = []
  try {
    mkdirSync(STARTUP_DIR, { recursive: true })
    watchers.push(watch(STARTUP_DIR, (_e, fn) => {
      if (fn?.endsWith('.json')) pushProgress()
    }))
    watchers.push(watch(dirname(FLEET_FILE), (_e, fn) => {
      if (fn === basename(FLEET_FILE)) pushFleet()
    }))
  } catch { /* home dir unwatchable — the initial push below still serves current state */ }

  // Keep the snapshot honest while anything is active: a remotely-deleted box writes no
  // local event, so the refresher is the bridge — running only while a page is watching
  // and only while the last snapshot shows a non-stopped box or a start is in flight.
  const refresher = setInterval(() => {
    const fleet = readJson(FLEET_FILE)
    const active = (fleet?.boxes || []).some((b: any) => b.status && b.status !== 'STOPPED')
      || Object.keys(readAllStartupStates()).length > 0
    if (active) kickRefresh()
  }, REFRESH_MS)

  pushProgress()
  stream.onClosed(() => { watchers.forEach((w) => w.close()); clearInterval(refresher) })
  return stream.send()
})
