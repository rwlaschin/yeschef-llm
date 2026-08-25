import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { readFleetSnapshot } from '#devbox'
import { devModels, subscriptionOf, parallelOf } from '#models'
import { handleAuthGet } from './devbox/auth.get.ts'

// getFleetStatus makes ~6 blocking execSync gcloud calls. Running it in this handler saturates the
// single Nitro worker and wedges the whole dashboard, so this route only ever READS a snapshot and
// asks a detached process to refresh it. The handler must stay non-blocking.
const STALE_MS = 4000
let refreshing = 0

function devboxScript() {
  const candidates = [
    fileURLToPath(new URL('../../../scripts/devbox.js', import.meta.url)),
    resolve(process.cwd(), '../scripts/devbox.js'),
    resolve(process.cwd(), 'scripts/devbox.js'),
  ]
  return candidates.find((c) => existsSync(c))
}

function kickRefresh() {
  // One refresher at a time — but the next may start the moment it exits, so the snapshot tracks
  // roughly one gcloud round-trip behind live. The 60s cap only frees a hung child.
  if (refreshing && Date.now() - refreshing < 60000) return
  const script = devboxScript()
  if (!script) return
  refreshing = Date.now()
  const child = spawn(process.execPath, [script, 'snapshot'], { stdio: 'ignore', detached: true })
  child.on('exit', () => { refreshing = 0 })
  child.unref()
}

export default defineEventHandler(async () => {
  const snap = readFleetSnapshot()
  if (!snap || snap.ageMs > STALE_MS) kickRefresh()

  // Auth comes from ADC (in-process), never from the snapshot's gcloud session state.
  const auth = await handleAuthGet()

  const workers = devModels().map((m: any) => ({
    name: `b-${m.model.replace(/[^a-zA-Z0-9]/g, '-')}`,
    model: m.model,
    subscription: subscriptionOf(m),
    parallel: parallelOf(m),
    topic: m.topic,
    status: 'IDLE',
  }))

  if (!snap) {
    const defaultBoxes = ['001', '002', '003', '004'].map((name) => ({
      name,
      vm: `yc-ollama-${name}`,
      status: 'STOPPED',
      machine: 'g2-standard-8',
      gpuPercent: null,
      vram: { usedGb: '0.0', totalGb: 24, percent: 0, formatted: '0.0 / 24 GB (0%)' },
      todayCost: 0,
      todayCostFormatted: '$0.00',
      runCost: 0,
      runCostFormatted: '$0.00',
      upSeconds: 0,
      serving: false,
      startupProgress: null,
      models: [],
      loadedModels: [],
    }))
    return { ok: true, pending: true, auth, firewall: null, boxes: defaultBoxes, workers, ageMs: null }
  }

  return {
    ok: true,
    pending: false,
    ageMs: snap.ageMs,
    stale: snap.ageMs > STALE_MS,
    auth,
    firewall: snap.firewall,
    boxes: snap.boxes,
    workers,
  }
})
