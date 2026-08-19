// pm2 map for the GCE Ollama devboxes. SEPARATE FROM yeschef/ecosystem.config.cjs ON PURPOSE:
// that file is started bare (`pm2 start ecosystem.config.cjs`) to bring the dev stack up, and any
// app living in it comes up with it. A GPU VM must never boot as a side effect of starting the
// dev stack — so these live here, and you name the one you want.
//
//   pm2 start ecosystem.devbox.cjs --only ollama-001   boot box "001"  (~$0.85/hr while up)
//   pm2 stop  ollama-001                               POWER THE VM OFF
//   pm2 list                                           boxes appear beside web/dash/ai
//   pm2 logs  ollama-001                               boot progress, URL, health changes
//
// Add a box: flip its "enabled" to true in config/devboxes.json. THE APP LIST BELOW IS GENERATED
// FROM THAT FILE — there is no hand-written list here to fall out of step with the boxes that exist.
//
// autorestart:false is NOT optional. These agents power a GPU VM up on start; a crash-loop would be
// a restart loop on billable hardware. If one exits, it exits — read the log and start it yourself.
const path = require('path')
const HERE = __dirname
// JSON, not config/devboxes.js: pm2 require()s this file as CommonJS while the repo is
// "type": "module", so an ESM accessor is unreachable from here. Both halves read the same JSON.
const REGISTRY = require('./config/devboxes.json')
// require() of an ESM module — Node ≥22.12, which this repo already requires. models.js is pure data
// with no top-level await, so it loads synchronously here. Reading the real registry is the point:
// a hand-copied model list in this file is exactly the drift the devbox registry was built to kill.
const { devModels, subscriptionOf, parallelOf } = require('./config/models.js')

// Runs through pm2-dev.mjs — the same shim `bare` uses — so the agent's output reaches logd instead
// of only ~/.pm2/logs. logd's component list is closed (yeschef/tools/logd/components.mjs), so a box
// is NOT its own component: all four ship as `script`, tagged ollama-001..004.
//   npm run logs -- script --tag ollama-001 --follow
const devbox = (name) => ({
  name: `ollama-${name}`,
  cwd: HERE,
  script: 'pm2-dev.mjs',
  args: [`node ${path.join(HERE, 'scripts', 'devbox-agent.mjs')} ${name}`, 'script', `ollama-${name}`],
  autorestart: false,
  // Boot installs Ollama and pulls a model on a cold box; the agent polls until it answers.
  kill_timeout: 120000,   // give the SIGINT handler time to actually stop the VM before pm2 SIGKILLs
  watch: false,
  max_restarts: 0,
})

// The BAREMETAL workers: worker/index.js as plain host processes, no Docker. ONE APP PER DEV MODEL —
// worker/index.js serves ONE model and drains ONE subscription, so a second model is a second process,
// never a flag. Generation goes to whatever WORKER_OLLAMA_HOST names in .env.dev — the Mac's
// Ollama.app, or one of the boxes above. All the workers share that one host; only the model and the
// subscription differ, and both of those are pm2 `env`, NOT launch args: scripts/worker-native.mjs
// reads them from process.env at boot (its header records what baking a target into args cost once).
// dotenv-flow does not overwrite a variable already in process.env, so these beat .env.dev.
//
// They live here rather than in yeschef/ecosystem.config.cjs because they generate against a devbox,
// and because that file is started bare to bring the whole dev stack up.
//
// This REPLACES the old single `bare` app, which hard-coded nothing and so defaulted to llama3.1:8b
// on sub_llama3_1_8b_v1 — the same queue b-llama-8b drains. Two subscribers split the messages, so
// they cannot both exist. If `bare` is still registered from an earlier run: `pm2 delete bare`.
// Each still drains the same subscription as the Docker `workers` app — run one or the other.
//
//   pm2 start ecosystem.devbox.config.cjs --only b-qwen
//   npm run logs -- script --tag b-qwen
//
// The short name is the one thing that cannot be derived: `qwen3_5_9b_v1` has no honest abbreviation.
// It is declared per topic and the test asserts this map covers devModels() exactly, so a new dev
// model fails the suite here instead of silently having no worker.
const SHORT = {
  llama3_1_8b_v1: 'llama-8b',
  gemma4_12b_v1: 'gemma',
  qwen3_5_9b_v1: 'qwen',
  // OpenClaw tiers are separate TOPICS fronting the same backing models, so they are separate
  // subscriptions that nothing else drains. Until the gateway wiring lands they run as their raw
  // backing model — which is still the correct worker for those jobs, so they get an app.
  openclaw_gemma4_12b_v1: 'oc-gemma',
  openclaw_llama3_1_8b_v1: 'oc-llama-8b',
}

// autorestart TRUE here, unlike the boxes above: these start no VM, so a restart costs nothing.
const worker = (m) => {
  // Loud, not `b-undefined`: an unnamed dev model would otherwise register an app nobody can find.
  if (!SHORT[m.topic]) throw new Error(`No short name for dev model ${m.topic} — add it to SHORT in ${__filename}.`)
  return {
    name: `b-${SHORT[m.topic]}`,
    cwd: HERE,
    script: 'pm2-dev.mjs',          // the repo's pm2 shim: runs the command and tees it into logd
    args: ['npm run dev:worker:native', 'script', `b-${SHORT[m.topic]}`],
    // OLLAMA_NUM_PARALLEL is the ONE knob (worker/lease.js): it sets the Pub/Sub lease bound, the
    // in-process generation gate, and the num_ctx multiplier. Unset here it fell back to 1 while the
    // box ran its own value, so the worker leased one message per box no matter how many slots existed.
    env: { WORKER_MODEL: m.model, WORKER_SUBSCRIPTION: subscriptionOf(m), OLLAMA_NUM_PARALLEL: String(parallelOf(m)) },
    autorestart: true,
    min_uptime: '10s',
    max_restarts: 5,
    watch: false,
  }
}

// A SHORT entry for a model that is no longer dev:true is a name that resolves to nothing.
const stale = Object.keys(SHORT).filter((t) => !devModels().some((m) => m.topic === t))
if (stale.length) throw new Error(`SHORT names a non-dev model: ${stale.join(', ')}`)

const workers = devModels().map(worker)

// THE MONEY GUARD. A bare `pm2 start ecosystem.devbox.config.cjs` starts every app in the file,
// which would power on four GPU VMs at ~$0.85/hr each. This file is require()d BY the pm2 CLI, so
// process.argv is pm2's own — withhold the boxes unless the caller named one with --only.
// Registered boxes are unaffected: `pm2 start|stop ollama-001` acts on the saved app and never
// reads this file, which is why managing them through plain pm2 works.
const named = process.argv.includes('--only')
if (!named) console.error('[devbox] no --only: withholding the boxes so no GPU VM boots by accident.')

// Enabled boxes only, in name order. A box that is declared but disabled has no pm2 app at all, so
// `--only ollama-002` names nothing until someone enables 002 in the registry on purpose.
const boxes = Object.keys(REGISTRY.boxes).filter((n) => REGISTRY.boxes[n].enabled).sort().map(devbox)

module.exports = {
  apps: named ? [...boxes, ...workers] : [...workers],
}
