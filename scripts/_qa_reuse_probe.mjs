// QA probe (adversarial test harness — NOT production). Runs the REAL recipes + courses steps
// against the REAL host Ollama, using the REAL prompt_library join and REAL plan_library defs and
// compose.js. Mirrors worker/steps/step.js loadStep(): a `fanout` step's context = the WHOLE prior
// step (all units joined), which is how Build Courses sees Build Recipes.
//   NODE_ENV=dev node scripts/_qa_reuse_probe.mjs            # run
//   DRY=1 NODE_ENV=dev node scripts/_qa_reuse_probe.mjs      # render prompts only, no LLM
import dotenvFlow from 'dotenv-flow'
dotenvFlow.config()

const { getCollection } = await import('../functions/lib/mongo.js')
const { composeFromDefs, renderUnit } = await import('../functions/entry/ai/compose.js')

const MODEL = process.env.QA_MODEL || 'llama3.1:8b'
const DRY = process.env.DRY === '1'

const prompts = await (await getCollection('prompt_library')).find({ active: { $ne: false } }).toArray()
const stepDocs = await (await getCollection('plan_library')).find({ active: { $ne: false } }).toArray()
const cfg = await (await getCollection('model_config')).find({ _id: { $in: ['_default', MODEL] } }).toArray()
const params = Object.fromEntries(cfg.map((d) => [d._id, d.params || {}]))
const styles = (params._styles || (cfg.find((d) => d._id === '_styles') || {}).params) || {}
const _styles = await (await getCollection('model_config')).findOne({ _id: '_styles' })
// worker/index.js samplerForStyle(): a step's `style` OVERRIDES the base temperature. Every
// pipeline step is `structured` -> 0.1.
const sampler = { ...(params._default || {}), ...(params[MODEL] || {}), temperature: (_styles?.params?.structured ?? 0.1) }

// Verbatim reimplementation of worker/index.js systemPromptFor.
const systemPromptFor = (type) => prompts
  .filter((p) => p.mapping && p.mapping[type] != null)
  .sort((a, b) => {
    const x = String(a.mapping[type]), y = String(b.mapping[type])
    return x < y ? -1 : x > y ? 1 : 0
  })
  .map((p) => p.content)
  .filter(Boolean)
  .join('\n\n')

const CHAIN = ['Build Recipes', 'Build Courses']
const defs = CHAIN.map((n) => {
  const d = stepDocs.find((s) => s.name === n)
  if (!d) throw new Error(`no active plan_library step named "${n}"`)
  return d
})

const DIETS = (process.env.QA_DIETS || 'regular, diabetic, renal, vegetarian, vegan').split(',').map((x) => x.trim())
const FORM = {
  values: {
    diets: DIETS.join(', '), meals: process.env.QA_MEALS || 'breakfast, lunch', institution: 'Senior Care',
    legals: 'FDA Food Code, CMS', restrictions: 'no nuts', preferences: 'comfort foods',
  },
  duration: { weeks: 0, days: Number(process.env.QA_DAYS || 2), startDate: '2026-09-01' },
  residents: 300, costTier: 'standard', flags: {}, dietWeights: {},
  region: 'United States · Seattle', hemisphere: 'North', tz: 'America/Los_Angeles',
  courseCounts: { entree: 1, side: 2, dessert: 1 },
}

async function ask(system, user) {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, system, prompt: user, stream: false, options: sampler }),
  })
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`)
  return (await res.json()).response ?? ''
}

const plan = composeFromDefs(defs, FORM, { isProd: false })
console.log('SAMPLER', JSON.stringify(sampler))
plan.forEach((s, i) => console.log(`PLAN[${i}] subtype=${s.subtype} kind=${s.kind} units=${Array.isArray(s.items) ? s.items.length : 1} contexts=${JSON.stringify(s.contexts || [])} items=${JSON.stringify(s.items || [])}`))

const runs = []
for (let i = 0; i < plan.length; i++) {
  const step = plan[i]
  if (step.error) { console.log(`### ${step.subtype}: COMPOSE ERROR ${step.error}`); runs[i] = []; continue }
  const n = Array.isArray(step.items) ? step.items.length : 1
  const system = systemPromptFor(step.subtype)
  const ctxBlocks = (step.contexts || []).map((idx) => {
    const text = (runs[idx] || []).filter(Boolean).join('\n\n')
    return text ? `# Result of step ${idx}:\n${text}` : ''
  }).filter(Boolean)

  runs[i] = []
  for (let u = 0; u < n; u++) {
    const user = [renderUnit(step, u), ...ctxBlocks].join('\n\n')
    if (DRY) {
      console.log(`\n@@@ DRY step ${i} ${step.subtype} unit ${u} system=${system.length}ch`)
      console.log(user)
      if (u >= 1) break
      continue
    }
    const t0 = Date.now()
    const answer = await ask(system, user)
    runs[i].push(answer)
    console.log(`\n@@@ STEP ${i} ${step.subtype} UNIT ${u} item=${JSON.stringify(step.items?.[u] ?? null)} ${(Date.now() - t0) / 1000}s`)
    console.log(answer.trim())
  }
}
process.exit(0)
