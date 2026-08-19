// QA probe #2 (courses only). Replays the recipes output already generated in a probe log as the
// context for the courses step, and calls Ollama the way the WORKER does: /api/chat with
// system+user messages and a sized num_ctx (worker/steps/step.js sizeNumCtx, floor OLLAMA_NUM_CTX
// = 8192). The earlier /api/generate probe used Ollama's default tiny context, which truncated the
// context block — that is why courses summarized instead of emitting rows.
//   QA_REPLAY=/tmp/qa_run2.log QA_DAYS=3 QA_MEALS="breakfast, lunch, dinner" \
//     QA_DIETS="regular, diabetic, renal, vegetarian" NODE_ENV=dev node scripts/_qa_courses_replay.mjs
import dotenvFlow from 'dotenv-flow'
dotenvFlow.config()
import fs from 'fs'

const { getCollection } = await import('../functions/lib/mongo.js')
const { composeFromDefs, renderUnit } = await import('../functions/entry/ai/compose.js')
const { sizeNumCtx } = await import('../worker/steps/step.js')

const MODEL = process.env.QA_MODEL || 'llama3.1:8b'
const prompts = await (await getCollection('prompt_library')).find({ active: { $ne: false } }).toArray()
const stepDocs = await (await getCollection('plan_library')).find({ active: { $ne: false } }).toArray()
const cfgDefault = await (await getCollection('model_config')).findOne({ _id: '_default' })
const cfgStyles = await (await getCollection('model_config')).findOne({ _id: '_styles' })
const sampler = { ...(cfgDefault?.params || {}), temperature: cfgStyles?.params?.structured ?? 0.1 }

const systemPromptFor = (type) => prompts
  .filter((p) => p.mapping && p.mapping[type] != null)
  .sort((a, b) => { const x = String(a.mapping[type]), y = String(b.mapping[type]); return x < y ? -1 : x > y ? 1 : 0 })
  .map((p) => p.content).filter(Boolean).join('\n\n')

const defs = ['Build Recipes', 'Build Courses'].map((n) => stepDocs.find((s) => s.name === n))
const DIETS = (process.env.QA_DIETS || 'regular, diabetic, renal, vegetarian').split(',').map((x) => x.trim())
const FORM = {
  values: {
    diets: DIETS.join(', '), meals: process.env.QA_MEALS || 'breakfast, lunch, dinner', institution: 'Senior Care',
    legals: 'FDA Food Code, CMS', restrictions: 'no nuts', preferences: 'comfort foods',
  },
  duration: { weeks: 0, days: Number(process.env.QA_DAYS || 3), startDate: '2026-09-01' },
  residents: 300, costTier: 'standard', flags: {}, dietWeights: {},
  region: 'United States · Seattle', hemisphere: 'North', tz: 'America/Los_Angeles',
  courseCounts: { entree: 1, side: 2, dessert: 1 },
}

// Recipes responses from the prior probe log = step 0 context, joined exactly as loadStep() does.
const log = fs.readFileSync(process.env.QA_REPLAY, 'utf8')
const recipeUnits = log.split(/^@@@ STEP /m).slice(1)
  .filter((p) => /^0 recipes/.test(p))
  .map((p) => p.slice(p.indexOf('\n') + 1).trim())
const ctxBlock = `# Result of step 0:\n${recipeUnits.join('\n\n')}`

const plan = composeFromDefs(defs, FORM, { isProd: false })
const step = plan[1]
const system = systemPromptFor('courses')
console.log(`SAMPLER ${JSON.stringify(sampler)}  recipeUnits=${recipeUnits.length}  ctx=${ctxBlock.length}ch  units=${step.items.length}`)

for (let u = 0; u < step.items.length; u++) {
  const user = [renderUnit(step, u), ctxBlock].join('\n\n')
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }]
  const numCtx = sizeNumCtx({ messages, modelMaxCtx: 131072, outputReserve: 4096, floor: 8192 })
  const t0 = Date.now()
  const res = await fetch('http://localhost:11434/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, stream: false, options: { ...sampler, num_ctx: numCtx, num_predict: -1 } }),
  })
  if (!res.ok) { console.log(`@@@ STEP 1 courses UNIT ${u} HTTP ${res.status} ${await res.text()}`); continue }
  const answer = (await res.json()).message?.content ?? ''
  console.log(`\n@@@ STEP 1 courses UNIT ${u} item=${JSON.stringify(step.items[u])} num_ctx=${numCtx} ${(Date.now() - t0) / 1000}s`)
  console.log(answer.trim())
}
process.exit(0)
