import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { allowCurrentIp, warmDevboxModel } from '#devbox'

function devboxScript() {
  const candidates = [
    fileURLToPath(new URL('../../../scripts/devbox.js', import.meta.url)),
    resolve(process.cwd(), '../scripts/devbox.js'),
    resolve(process.cwd(), 'scripts/devbox.js'),
  ]
  return candidates.find((c) => existsSync(c))
}

// Starter/stopper output ships into logd (component `script`, tagged per box) like every
// pm2 service — the Device Logs view streams it back out. Same sibling-repo walk as pm2-dev.mjs.
function logshipScript(from: string) {
  for (let dir = from, i = 0; i < 6; i++, dir = resolve(dir, '..')) {
    const guess = resolve(dir, '..', 'yeschef', 'tools', 'logd', 'logship.mjs')
    if (existsSync(guess)) return guess
  }
  return null
}

function spawnDevbox(script: string, args: string[], tag: string) {
  const ship = logshipScript(resolve(script, '..'))
  const child = ship
    ? spawn('bash', ['-c',
        `${JSON.stringify(process.execPath)} ${args.map(a => JSON.stringify(a)).join(' ')} 2>&1 | ` +
        `${JSON.stringify(process.execPath)} ${JSON.stringify(ship)} script ${tag}`,
      ], { stdio: 'ignore', detached: true })
    : spawn(process.execPath, args, { stdio: 'ignore', detached: true })
  child.unref()
}

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event).catch(() => ({}))
    const action = body?.action
    const box = body?.box
    const model = body?.model
    const timeoutMinutes = Number(body?.timeoutMinutes || 0)
    const clientIp = body?.ip || getHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim() || ''

    if (!action) {
      throw createError({ statusCode: 400, statusMessage: 'Action required' })
    }

    switch (action) {
      case 'start': {
        if (!box) throw createError({ statusCode: 400, statusMessage: 'Box name required' })
        // startDevbox is synchronous (execSync). Calling it here would block this worker for the
        // whole search, so no GET could be served and progress would be invisible. Run it as its
        // own detached process; it reports progress through the startup-state file.
        const script = devboxScript()
        if (!script) throw createError({ statusCode: 500, statusMessage: 'devbox.js not found' })
        const args = [script, 'start', box, '--rounds=5']
        if (model) args.push(`--model=${model}`)
        if (timeoutMinutes) args.push(`--timeout=${timeoutMinutes}`)
        spawnDevbox(script, args, `devbox-${box}`)
        return { ok: true, status: 'STARTING', message: `Capacity search for ${box} started (up to 5 rounds).` }
      }
      case 'stop': {
        if (!box) throw createError({ statusCode: 400, statusMessage: 'Box name required' })
        // Same hazard as start: the delete is execSync with a 300s timeout, so awaiting it here
        // froze the whole dashboard until GCP finished and the row could never leave RUNNING.
        const script = devboxScript()
        if (!script) throw createError({ statusCode: 500, statusMessage: 'devbox.js not found' })
        spawnDevbox(script, [script, 'stop', box], `devbox-${box}`)
        return { ok: true, status: 'STOPPING', message: `Deleting ${box}…` }
      }
      case 'allow': {
        const res = await allowCurrentIp(clientIp)
        return { ok: true, data: res }
      }
      case 'use':
      case 'warm': {
        if (!box || !model) throw createError({ statusCode: 400, statusMessage: 'Box name and model required' })
        const res = await warmDevboxModel(box, model)
        return { ok: true, data: res }
      }
      default:
        throw createError({ statusCode: 400, statusMessage: `Unknown action: ${action}` })
    }
  } catch (error: any) {
    throw createError({
      statusCode: error.statusCode || 500,
      statusMessage: error.message || 'Operation failed',
    })
  }
})
