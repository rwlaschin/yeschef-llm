#!/usr/bin/env node
// Repair one frozen step from its canonical plan-library template.
//
// Dry-run is the default. A commit requires the exact Firestore updateTime printed by
// the dry-run, so a job changed between review and write is never overwritten.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderUnit } from '../functions/entry/ai/compose.js'

const sameUpdateTime = (a, b) => {
  if (a === b) return true
  if (a?.isEqual && typeof a.isEqual === 'function') return a.isEqual(b)
  if (b?.isEqual && typeof b.isEqual === 'function') return b.isEqual(a)
  const value = (v) => v?.toDate ? v.toDate().toISOString() : String(v)
  return value(a) === value(b)
}

const displayUpdateTime = (value) => value?.toDate ? value.toDate().toISOString() : String(value)

/**
 * Pure repair operation with injected persistence. This is also the contract used by the CLI.
 */
export async function repairFrozenPlan({
  jobId,
  stepIndex,
  expectedSubtype,
  expectedUpdateTime,
  canonicalTemplate,
  expectedRenderedUnits,
  commit = false,
  readJob,
  writeJob,
}) {
  if (!jobId) throw new Error('jobId is required')
  if (!Number.isInteger(stepIndex) || stepIndex < 0) throw new Error(`invalid step index ${stepIndex}`)
  if (!canonicalTemplate || typeof canonicalTemplate !== 'object') throw new Error('canonicalTemplate is required')
  if (!Array.isArray(expectedRenderedUnits)) throw new Error('expectedRenderedUnits is required')
  if (typeof readJob !== 'function' || typeof writeJob !== 'function') throw new Error('readJob and writeJob are required')
  if (commit && expectedUpdateTime == null) throw new Error('commit requires expectedUpdateTime CAS precondition')

  const snapshot = await readJob(jobId)
  if (!snapshot?.exists) throw new Error(`job ${jobId} does not exist`)
  const beforeData = snapshot.data
  const beforePlan = beforeData?.plan
  if (!Array.isArray(beforePlan) || stepIndex >= beforePlan.length) {
    throw new Error(`job ${jobId} has no plan[${stepIndex}]`)
  }
  const beforeStep = beforePlan[stepIndex]
  if (beforeStep?.subtype !== expectedSubtype) {
    throw new Error(`plan[${stepIndex}] subtype ${JSON.stringify(beforeStep?.subtype)}; expected ${JSON.stringify(expectedSubtype)}`)
  }
  if (commit && !sameUpdateTime(expectedUpdateTime, snapshot.updateTime)) {
    throw new Error(`CAS update-time mismatch: expected ${displayUpdateTime(expectedUpdateTime)}, current ${displayUpdateTime(snapshot.updateTime)}`)
  }

  const afterStep = { ...beforeStep, template: { ...canonicalTemplate } }
  afterStep.instructions = renderUnit(afterStep, 0)
  const afterPlan = beforePlan.map((step, index) => index === stepIndex ? afterStep : step)
  const afterData = { ...beforeData, plan: afterPlan }

  const unitCount = Array.isArray(afterStep.items) ? afterStep.items.length : 1
  if (expectedRenderedUnits.length !== unitCount) {
    throw new Error(`render comparison expected ${expectedRenderedUnits.length} unit(s), repaired step has ${unitCount}; need 100% match`)
  }
  const comparisons = Array.from({ length: unitCount }, (_, unit) => ({
    unit,
    match: renderUnit(afterStep, unit) === expectedRenderedUnits[unit],
  }))
  const matched = comparisons.filter(({ match }) => match).length
  if (matched !== unitCount) {
    const first = comparisons.find(({ match }) => !match)?.unit
    throw new Error(`render comparison matched ${matched}/${unitCount}; unit ${first} differs; refusing without 100% match`)
  }

  if (commit) {
    await writeJob(jobId, { plan: afterPlan }, { lastUpdateTime: expectedUpdateTime })
  }

  return {
    mode: commit ? 'commit' : 'dry-run',
    beforeData,
    afterData,
    beforePlan,
    afterPlan,
    comparisons,
    changedPaths: [`plan[${stepIndex}].template`, `plan[${stepIndex}].instructions`],
    updateTime: snapshot.updateTime,
  }
}

const encodeFirestore = (value) => {
  if (value?.constructor?.name === 'Timestamp') return { __type: 'Timestamp', value: value.toDate().toISOString() }
  if (value?.constructor?.name === 'GeoPoint') return { __type: 'GeoPoint', latitude: value.latitude, longitude: value.longitude }
  if (value?.constructor?.name === 'DocumentReference') return { __type: 'DocumentReference', path: value.path }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { __type: 'Bytes', base64: Buffer.from(value).toString('base64') }
  if (Array.isArray(value)) return value.map(encodeFirestore)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeFirestore(item)]))
  return value
}

const parseArgs = (argv) => {
  const out = { jobs: [], stepIndex: 1, subtype: 'courses', canonical: 'Build Courses', commit: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--job') out.jobs.push(argv[++i])
    else if (arg === '--step') out.stepIndex = Number(argv[++i])
    else if (arg === '--subtype') out.subtype = argv[++i]
    else if (arg === '--canonical') out.canonical = argv[++i]
    else if (arg === '--commit') out.commit = true
    else throw new Error(`unknown argument ${arg}`)
  }
  if (!out.jobs.length) throw new Error('provide at least one --job <id>')
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const dotenvFlow = (await import('dotenv-flow')).default
  dotenvFlow.config({ path: ROOT, node_env: 'dev' })
  const mongodb = await import('mongodb')
  const { getApps, initializeApp } = await import('firebase-admin/app')
  const { getFirestore } = await import('firebase-admin/firestore')
  const mongo = new mongodb.MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000 })
  await mongo.connect()
  try {
    const mongoDb = mongo.db(process.env.MONGO_DB || 'yeschef')
    const canonical = await mongoDb.collection('plan_library').findOne({ name: args.canonical, active: true, isDeleted: { $ne: true } })
    if (!canonical) throw new Error(`active canonical plan definition ${JSON.stringify(args.canonical)} not found`)
    if (canonical.subtype !== args.subtype) throw new Error(`canonical subtype ${canonical.subtype}; expected ${args.subtype}`)
    const canonicalTemplate = {
      instruction: canonical.instruction || '',
      pass: canonical.pass || '',
      fail: canonical.fail || '',
    }

    if (!getApps().length) initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT_ID || 'yeschef-c572a' })
    const db = getFirestore()
    const readJob = async (jobId) => {
      const snap = await db.collection('llmResults').doc(jobId).get()
      return { exists: snap.exists, data: snap.exists ? snap.data() : null, updateTime: snap.updateTime }
    }
    const writeJob = async (jobId, patch, precondition) => db.collection('llmResults').doc(jobId).update(patch, precondition)

    // One initial read supplies both the canonical rendered-unit baseline and the reviewed CAS value.
    const prepared = []
    for (const jobId of args.jobs) {
      const snapshot = await readJob(jobId)
      if (!snapshot.exists) throw new Error(`job ${jobId} does not exist`)
      const step = snapshot.data?.plan?.[args.stepIndex]
      if (step?.subtype !== args.subtype) throw new Error(`${jobId} plan[${args.stepIndex}] is not ${args.subtype}`)
      const canonicalStep = { ...step, template: canonicalTemplate }
      canonicalStep.instructions = renderUnit(canonicalStep, 0)
      const count = Array.isArray(canonicalStep.items) ? canonicalStep.items.length : 1
      prepared.push({
        jobId,
        snapshot,
        expectedRenderedUnits: Array.from({ length: count }, (_, unit) => renderUnit(canonicalStep, unit)),
      })
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outDir = path.join(ROOT, '.scratch/iter/promotions')
    const backupDir = path.join(outDir, `backups-frozen-plan-${stamp}`)
    fs.mkdirSync(outDir, { recursive: true })
    if (args.commit) {
      fs.mkdirSync(backupDir, { recursive: true })
      for (const item of prepared) {
        fs.writeFileSync(path.join(backupDir, `firestore-llmResults-${item.jobId}.json`), JSON.stringify({
          id: item.jobId,
          updateTime: displayUpdateTime(item.snapshot.updateTime),
          document: encodeFirestore(item.snapshot.data),
        }, null, 2) + '\n')
      }
    }

    const results = []
    for (const item of prepared) {
      results.push(await repairFrozenPlan({
        jobId: item.jobId,
        stepIndex: args.stepIndex,
        expectedSubtype: args.subtype,
        expectedUpdateTime: item.snapshot.updateTime,
        canonicalTemplate,
        expectedRenderedUnits: item.expectedRenderedUnits,
        commit: args.commit,
        readJob,
        writeJob,
      }))
    }

    const receipt = {
      mode: args.commit ? 'commit' : 'dry-run',
      createdAt: new Date().toISOString(),
      canonical: args.canonical,
      subtype: args.subtype,
      stepIndex: args.stepIndex,
      jobs: results.map((result, index) => ({
        id: args.jobs[index],
        updateTimeBefore: displayUpdateTime(result.updateTime),
        comparedUnits: result.comparisons.length,
        matchedUnits: result.comparisons.filter(({ match }) => match).length,
        changedPaths: result.changedPaths,
      })),
      backups: args.commit ? backupDir : null,
    }
    const receiptPath = path.join(outDir, `frozen-plan-repair-${args.commit ? 'commit' : 'dry-run'}-${stamp}.json`)
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
    console.log(JSON.stringify({ ...receipt, receiptPath }, null, 2))
  } finally {
    await mongo.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
