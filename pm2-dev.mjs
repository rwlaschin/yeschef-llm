#!/usr/bin/env node
// Exists ONLY so pm2 can report this repo's version.
//
// pm2 reads the version column from the package.json sitting next to `script` — verified: with
// cwd in one repo and script in another, it reports the SCRIPT's repo. A bash-wrapped command
// resolves to /bin/bash, where there is no package.json, so every app showed N/A. Pointing pm2 at
// this file instead makes it find the package.json beside it.
//
// It does nothing else: spawn the real command, tee it into logd, forward the exit code.
//   node pm2-dev.mjs "<shell command>" <component>
//
// logship is resolved HERE rather than passed in: pm2 persists an app's args, so a path baked in
// at `pm2 start` time outlives the checkout that produced it — delete that worktree and every
// saved entry is poisoned for good. Resolving per spawn means every restart re-resolves.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// logd lives in the yeschef repo, a sibling of this one — but this file can sit one level deeper
// (dashboard/), so walk up until a sibling yeschef with logship in it appears.
function findShip(from) {
  for (let dir = from, i = 0; i < 6; i++, dir = path.dirname(dir)) {
    const guess = path.join(path.dirname(dir), 'yeschef', 'tools', 'logd', 'logship.mjs')
    if (existsSync(guess)) return guess
  }
  return null
}
const SHIP = findShip(path.dirname(fileURLToPath(import.meta.url)))

const [cmd, name, tag] = process.argv.slice(2)
if (!cmd || !name) {
  console.error('usage: pm2-dev.mjs "<command>" <component> [run-label]')
  process.exit(2)
}

// Losing the tee is not worth losing the process: run bare and say so.
if (!SHIP) console.error(`pm2-dev: no sibling yeschef/tools/logd/logship.mjs — running ${name} untee'd`)
// The tag is how a stream gets its own identity without inventing a logd component: the devbox
// agents all ship as `script`, tagged ollama-a..d, and `npm run logs -- script --tag ollama-a`
// pulls one box back out.
const tee = SHIP ? ` 2>&1 | node ${JSON.stringify(SHIP)} ${name}${tag ? ` ${tag}` : ''}` : ''

// detached puts bash and everything it spawns in their own process group, so the signal below can
// reach the WHOLE pipeline. Signalling bash alone is not enough: bash -c running a pipeline does not
// propagate SIGTERM to its members, so `pm2 stop` used to leave an orphaned worker draining Pub/Sub.
const child = spawn('bash', ['-c', `${cmd}${tee}`], { stdio: 'inherit', detached: true })
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  try { process.kill(-child.pid, sig) } catch { /* group already gone */ }
})
