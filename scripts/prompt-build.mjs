// Build the EXACT prompt a step will send, from a SAVED config, and print it. No LLM call.
//
// prompt-lab.mjs runs a chain against a hardcoded FORM; this answers the other question — "what
// does the model actually receive for THIS plan?" — so a prompt can be read before it is measured.
//
//   NODE_ENV=production node scripts/prompt-build.mjs --step "Build Courses" --unit 1
//   NODE_ENV=production node scripts/prompt-build.mjs --job <jobId> --company <companyId> --demarcate
//
//   --job/--company   load the saved config from companies/{companyId}/menuPlans/{jobId}.input
//                     (menu.js:298 writes it). Omit to use scripts' own sample form.
//   --step <name>     plan_library step name (default "Build Courses")
//   --unit <n>        fan-out unit (default 0)
//   --demarcate       label every section with the doc it came from: prompt_library _id + name +
//                     mapping key for system chunks, plan_library field for the instruction, and
//                     the step id for each injected context block.
//   --system/--user   print only that message
import dotenvFlow from 'dotenv-flow'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
dotenvFlow.config({ path: path.join(HERE, '..') })

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i === -1 ? d : (process.argv[i + 1]?.startsWith('--') ? true : process.argv[i + 1] ?? true)
}
const has = (k) => process.argv.includes(`--${k}`)

const { getCollection } = await import('../functions/lib/mongo.js')
const { composeFromDefs, renderUnit } = await import('../functions/entry/ai/compose.js')
const { buildStepMessages, sizeNumCtx } = await import('../worker/steps/step.js')
const { MODELS } = await import('../config/models.js')

const STEP = String(arg('step', 'Build Courses'))
const UNIT = Number(arg('unit', 0))
const MODEL = String(arg('model', 'llama3.1:8b'))

// Saved config, or the sample. A run whose inputs you cannot name is not a reading of anything, so
// the source is always printed.
let form, formSource
const jobId = arg('job'), companyId = arg('company')
if (jobId && companyId) {
  const { initializeApp, getApps } = await import('firebase-admin/app')
  const { getFirestore } = await import('firebase-admin/firestore')
  if (!getApps().length) initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT_ID })
  const snap = await getFirestore().collection('companies').doc(String(companyId))
    .collection('menuPlans').doc(String(jobId)).get()
  if (!snap.exists) throw new Error(`no menuPlans doc companies/${companyId}/menuPlans/${jobId}`)
  form = snap.data().input || {}
  formSource = `companies/${companyId}/menuPlans/${jobId}.input`
} else {
  const { makeCoursesForm, seed } = await import('../.scratch/enforcer/form.mjs')
  form = makeCoursesForm({ proteins: seed() })
  formSource = 'sample form (.scratch/enforcer/form.mjs) — pass --job/--company for a saved config'
}

const promptDocs = await (await getCollection('prompt_library'))
  .find({ isDeleted: { $ne: true }, active: true }).toArray()
const planDocs = await (await getCollection('plan_library')).find({ active: true }).toArray()

const def = planDocs.find((d) => d.name === STEP)
if (!def) throw new Error(`no active plan_library step named "${STEP}"`)

// Verbatim worker/index.js systemPromptFor, but each doc kept separate so it can be labelled.
const chunksFor = (type) => promptDocs
  .filter((p) => p.mapping && p.mapping[type] != null)
  .sort((a, b) => {
    const x = String(a.mapping[type]), y = String(b.mapping[type])
    return x < y ? -1 : x > y ? 1 : 0
  })
  .map((p) => ({ doc: p, key: String(p.mapping[type]), content: String(p.content || '').replace(/\\([\\`*_{}[\]()#+\-.!>])/g, '$1') }))
  .filter((c) => c.content)

const chunks = chunksFor(def.subtype)
const DEMARC = has('demarcate')
const systemPromptFor = async () => chunks
  .map((c) => DEMARC
    ? `<<<< prompt_library ${c.doc._id}  "${c.doc.name || '(unnamed)'}"  mapping.${def.subtype}="${c.key}"  ${c.content.length} chars >>>>\n${c.content}`
    : c.content)
  .join('\n\n')

// The step's own prior-step context. Reads what the worker reads; a missing one is reported, never
// silently rendered as an empty block — an absent context block is exactly the bug being hunted.
const ctxDocs = {}
if (jobId && companyId) {
  const { getFirestore } = await import('firebase-admin/firestore')
  const { unitDocId } = await import('../config/models.js')
  const steps = await getFirestore().collection('llmResults').doc(String(jobId)).collection('steps').get()
  for (const d of steps.docs) ctxDocs[d.id] = d.data().response
  void unitDocId
}

const plan = composeFromDefs(
  planDocs.filter((d) => ['Build Protein Grid', 'Build Recipes', 'Build Courses'].includes(d.name)),
  form, { isProd: false })
const stepIndex = plan.findIndex((s) => s.subtype === def.subtype)
if (stepIndex === -1) throw new Error(`step "${STEP}" (subtype ${def.subtype}) not in the composed plan`)

const stubFirestore = {
  collection: () => ({ doc: () => ({
    get: async () => ({ exists: true, data: () => ({ plan }) }),
    collection: () => ({
      doc: (id) => ({ get: async () => (ctxDocs[id] != null
        ? { exists: true, data: () => ({ response: ctxDocs[id], isDeleted: false }) }
        : { exists: false, data: () => ({}) }) }),
      where: () => ({ get: async () => ({ docs: [] }) }),
    }),
  }) }),
}

const stepDef = plan[stepIndex]
const query = Array.isArray(stepDef.items) ? renderUnit(stepDef, UNIT) : null
const payload = { jobId: String(jobId || 'PREVIEW'), step: stepIndex, unit: UNIT, type: 'step',
  subtype: stepDef.subtype, tools: stepDef.tools || [], ...(query != null ? { query } : {}) }
const messages = await buildStepMessages(payload, '',
  { getFirestoreClient: () => stubFirestore, systemPromptFor, subtypeBuilders: {} })

const modelMaxCtx = MODELS.find((m) => m.model === MODEL)?.ctx ?? null
const numCtx = sizeNumCtx({ messages, modelMaxCtx, outputReserve: 4096, floor: 8192 })

const onlySystem = has('system'), onlyUser = has('user')
console.log(`# step        ${STEP}  (subtype=${stepDef.subtype}, index=${stepIndex}, unit=${UNIT})`)
console.log(`# config      ${formSource}`)
console.log(`# system      ${chunks.length} prompt_library doc(s), ${messages[0].content.length} chars`)
console.log(`# user        ${messages[1].content.length} chars`)
console.log(`# context     ${Object.keys(ctxDocs).length} prior step doc(s) available`)
console.log(`# numCtx      ${numCtx}\n`)

for (const m of messages) {
  if (onlySystem && m.role !== 'system') continue
  if (onlyUser && m.role !== 'user') continue
  console.log(`=============== ${m.role.toUpperCase()} ===============\n`)
  console.log(DEMARC && m.role === 'user'
    ? m.content.replace(/^(# .+)$/gm, '<<<< $1 >>>>')
    : m.content)
  console.log()
}
process.exit(0)
