// Prompt lab, second generation. Differences from lab.mjs, both of which made the first one lie:
//   1. System prompts come from the REAL prompt_library via the same join systemPromptFor() does
//      (filter on mapping[subtype], sort by its value as a string, concatenate). Hand-written system
//      prompts omitted the diet definitions and the status-block contract, so every content failure
//      measured was an artifact of my prompt, not the step.
//   2. Prior-step output is injected as `# Result of step N:` exactly as worker/steps/step.js
//      loadStep() does. Without this a step declaring `context` silently receives nothing, and the
//      first lab scored entrees as "contradicting the matrix" it had never been shown.
//
//   NODE_ENV=dev node scripts/prompt-lab.mjs [model]
//   CHAIN="Build Protein Grid,Build Recipes" UNIT_CAP=1 NODE_ENV=dev node scripts/prompt-lab.mjs

import dotenvFlow from 'dotenv-flow'
dotenvFlow.config()

const { getCollection } = await import('../functions/lib/mongo.js')
const { composeFromDefs, renderUnit } = await import('../functions/entry/ai/compose.js')

const MODEL = process.argv[2] || 'llama3.1:8b'

const prompts = await (await getCollection('prompt_library')).find({ active: { $ne: false } }).toArray()
const stepDocs = await (await getCollection('plan_library')).find({ active: { $ne: false } }).toArray()

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

// Which chain to exercise, in order. Named by plan_library `name` so the DB stays the source of truth.
const CHAIN = (process.env.CHAIN || 'Build Protein Grid,Build Recipes').split(',').map((s) => s.trim())
const defs = CHAIN.map((n) => {
  const d = stepDocs.find((s) => s.name === n)
  if (!d) throw new Error(`no active plan_library step named "${n}"`)
  return d
})

// A 12-entry pool against a 1-row manifest. The SIZE OF THE GAP is the instrument: the defect under
// test is "one row per menu entry", so the pool must be far larger than the rows demanded, or a
// correct run and an enumerating run produce the same count and the measurement says nothing.
const PROTEINS = [
  { slug: 'beef', label: 'Beef', weight: 25 },
  { slug: 'chicken', label: 'Chicken', weight: 30 },
  { slug: 'cod', label: 'Cod', weight: 15 },
  { slug: 'egg', label: 'Egg', weight: 10 },
  { slug: 'greek-yogurt', label: 'Greek yogurt', weight: 8 },
  { slug: 'lamb', label: 'Lamb', weight: 8 },
  { slug: 'pork', label: 'Pork', weight: 12 },
  { slug: 'salmon', label: 'Salmon', weight: 12 },
  { slug: 'shrimp', label: 'Shrimp', weight: 8 },
  { slug: 'tofu', label: 'Tofu', weight: 10 },
  { slug: 'turkey', label: 'Turkey', weight: 20 },
  { slug: 'venison', label: 'Venison', weight: 5 },
]
const DIETS = ['standard', 'diabetic']

// MATCHES THE SHAPE THAT FAILS IN PRODUCTION: 2 days × 1 mealtime × 2 diets. The old FORM was
// 7 days × 3 meals — and at 7 days "enumerate the 12-protein pool" and "write 7 days of rows" yield
// almost the same table, so the bug is invisible and the harness reports a pass on a broken prompt.
// One mealtime and one day per unit makes the manifest exactly ONE ROW, which is unambiguous.
const FORM = {
  values: {
    diets: DIETS.join(', '), meals: 'lunch', institution: 'Senior Care',
    legals: 'FDA Food Code, CMS', restrictions: 'no nuts', preferences: 'comfort foods',
  },
  duration: { weeks: 1, days: 2, startDate: '2026-09-01' },
  residents: 300, costTier: 'standard', flags: {}, dietWeights: {},
  region: 'United States · Seattle', hemisphere: 'North', tz: 'America/Los_Angeles',
  proteinChoices: PROTEINS, counts: { entree: 6, side: 5, appetizer: 5 },
  // compose.js:307-311 reads `courseCounts` — NOT `counts`. Without this key `courseList` renders
  // empty, the {{#if courseList}} test fails, and Build Courses runs its {{else}} branch ("no course
  // list was given, write SIDES ONLY"). That is a DIFFERENT prompt from the one production runs, so
  // every measurement taken without this key is evidence about a prompt nobody ships.
  courseCounts: { appetizer: 3, entree: 2, side: 3 },
}

async function ask(system, user) {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, system, prompt: user, stream: false, options: { temperature: 0.2 } }),
  })
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`)
  return (await res.json()).response ?? ''
}

const MARKER = /@@::(?:(PASS)|FAIL:\s*([\s\S]+?))\s*::@@/i   // worker/steps/outcome.js

const plan = composeFromDefs(defs, FORM, { isProd: false })
const runs = []            // runs[stepIndex] = [unit0, unit1, …] response text
const UNIT_CAP = Number(process.env.UNIT_CAP || 1)   // keep a debug pass cheap

for (let i = 0; i < plan.length; i++) {
  const step = plan[i]
  if (step.error) { console.log(`\n### ${step.subtype}: COMPOSE ERROR ${step.error}`); runs[i] = []; continue }
  const unitCount = Array.isArray(step.items) ? step.items.length : 1
  const n = Math.min(unitCount, UNIT_CAP)
  const system = systemPromptFor(step.subtype)

  // loadStep(): for each earlier step named in `contexts`, join its units' responses into one block.
  const ctxBlocks = (step.contexts || []).map((idx) => {
    const text = (runs[idx] || []).filter(Boolean).join('\n\n')
    return text ? `# Result of step ${idx}:\n${text}` : ''
  }).filter(Boolean)

  runs[i] = []
  for (let u = 0; u < n; u++) {
    const user = [renderUnit(step, u), ...ctxBlocks].join('\n\n')
    const answer = await ask(system, user)
    runs[i].push(answer)
    const m = answer.match(MARKER)
    console.log(`\n### step ${i} ${step.subtype} unit ${u + 1}/${unitCount}` +
      `  system=${system.length}ch  ctxBlocks=${ctxBlocks.length}` +
      `  marker=${m ? (m[1] ? 'PASS' : `FAIL(${m[2].trim().slice(0, 40)})`) : 'MISSING'}`)
    console.log(answer.trim())
  }
}
process.exit(0)
