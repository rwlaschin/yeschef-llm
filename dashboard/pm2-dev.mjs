#!/usr/bin/env node
// Exists ONLY so pm2 can report this repo's version.
//
// pm2 reads the version column from the package.json sitting next to `script` — verified: with
// cwd in one repo and script in another, it reports the SCRIPT's repo. A bash-wrapped command
// resolves to /bin/bash, where there is no package.json, so every app showed N/A. Pointing pm2 at
// this file instead makes it find the package.json beside it.
//
// It does nothing else: spawn the real command, tee it into logd, forward the exit code.
//   node pm2-dev.mjs "<shell command>" <component> <abs path to logship.mjs>
import { spawn } from 'node:child_process'

const [cmd, name, ship] = process.argv.slice(2)
if (!cmd || !name || !ship) {
  console.error('usage: pm2-dev.mjs "<command>" <component> <logship.mjs>')
  process.exit(2)
}

const child = spawn('bash', ['-c', `${cmd} 2>&1 | node ${JSON.stringify(ship)} ${name}`], { stdio: 'inherit' })
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
