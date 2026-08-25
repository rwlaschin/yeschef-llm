import { test } from 'node:test'
import assert from 'node:assert/strict'
import { repairFrozenPlan } from './repair-frozen-plan.mjs'

test('Equivalence Partitioning: dry-run repairs the frozen template and unit-zero display instruction without writing', async () => {
  const writes = []
  const result = await repairFrozenPlan({
    jobId: 'job-exact',
    stepIndex: 1,
    expectedSubtype: 'courses',
    canonicalTemplate: { instruction: 'NEW {{item.day}}', pass: 'P', fail: 'F' },
    expectedRenderedUnits: [
      '{leading}\nNEW 1\n{trailing}\n{conditions}\n\nPass: P\n{pass}\nFail: F\n{fail}',
      '{leading}\nNEW 2\n{trailing}\n{conditions}\n\nPass: P\n{pass}\nFail: F\n{fail}',
    ],
    readJob: async () => ({
      exists: true,
      updateTime: 'update-7',
      data: {
        status: 'failed',
        plan: [
          { subtype: 'recipes', instructions: 'unchanged' },
          { subtype: 'courses', kind: 'fanout', template: { instruction: 'OLD {{item.day}}', pass: 'OLD P', fail: 'OLD F' }, instructions: 'ACCIDENTALLY PATCHED DISPLAY', items: [{ day: 1 }, { day: 2 }], renderCtx: {}, itemVars: [], contexts: [0] },
        ],
      },
    }),
    writeJob: async (...args) => { writes.push(args) },
  })

  assert.deepEqual({
    mode: result.mode,
    repairedTemplate: result.afterPlan[1].template,
    restoredDisplayInstruction: result.afterPlan[1].instructions,
    comparedUnits: result.comparisons,
    writes,
  }, {
    mode: 'dry-run',
    repairedTemplate: { instruction: 'NEW {{item.day}}', pass: 'P', fail: 'F' },
    restoredDisplayInstruction: '{leading}\nNEW 1\n{trailing}\n{conditions}\n\nPass: P\n{pass}\nFail: F\n{fail}',
    comparedUnits: [
      { unit: 0, match: true },
      { unit: 1, match: true },
    ],
    writes: [],
  })
})

test('Domain Analysis: commit writes only the repaired plan with the caller supplied update-time CAS precondition', async () => {
  const writes = []
  await repairFrozenPlan({
    jobId: 'job-exact',
    stepIndex: 1,
    expectedSubtype: 'courses',
    expectedUpdateTime: 'update-7',
    commit: true,
    canonicalTemplate: { instruction: 'NEW {{item.day}}', pass: 'P', fail: 'F' },
    expectedRenderedUnits: ['{leading}\nNEW 1\n{trailing}\n{conditions}\n\nPass: P\n{pass}\nFail: F\n{fail}'],
    readJob: async (jobId) => ({
      exists: jobId === 'job-exact',
      updateTime: 'update-7',
      data: { owner: 'user-1', plan: [{ subtype: 'recipes' }, { subtype: 'courses', template: { instruction: 'OLD', pass: '', fail: '' }, instructions: 'DRIFT', items: [{ day: 1 }], renderCtx: {}, itemVars: [] }] },
    }),
    writeJob: async (...args) => { writes.push(args) },
  })

  assert.deepEqual(writes, [[
    'job-exact',
    { plan: [{ subtype: 'recipes' }, { subtype: 'courses', template: { instruction: 'NEW {{item.day}}', pass: 'P', fail: 'F' }, instructions: '{leading}\nNEW 1\n{trailing}\n{conditions}\n\nPass: P\n{pass}\nFail: F\n{fail}', items: [{ day: 1 }], renderCtx: {}, itemVars: [] }] },
    { lastUpdateTime: 'update-7' },
  ]])
})

test('Error Guessing: repair preserves every unrelated job field, unrelated step, and non-render field on the target step', async () => {
  const result = await repairFrozenPlan({
    jobId: 'job-exact',
    stepIndex: 1,
    expectedSubtype: 'courses',
    canonicalTemplate: { instruction: 'NEW {{item.day}}', pass: 'P', fail: 'F' },
    expectedRenderedUnits: ['{leading}\nNEW 1\n{trailing}\n{conditions}\n\nPass: P\n{pass}\nFail: F\n{fail}'],
    readJob: async () => ({
      exists: true,
      updateTime: 'update-7',
      data: {
        status: 'failed', cursor: 2, userId: 'user-1', nested: { keep: ['all', 'values'] },
        plan: [
          { subtype: 'recipes', instructions: 'KEEP STEP ZERO', opaque: { x: 1 } },
          { subtype: 'courses', kind: 'fanout', template: { instruction: 'OLD', pass: '', fail: '' }, instructions: 'DRIFT', items: [{ day: 1 }], renderCtx: {}, itemVars: [], contexts: [0], tools: ['web_search'], opaque: { y: 2 } },
          { subtype: 'nutrients', instructions: 'KEEP STEP TWO' },
        ],
      },
    }),
    writeJob: async () => { throw new Error('dry-run must not write') },
  })

  assert.deepEqual(result.afterData, {
    status: 'failed', cursor: 2, userId: 'user-1', nested: { keep: ['all', 'values'] },
    plan: [
      { subtype: 'recipes', instructions: 'KEEP STEP ZERO', opaque: { x: 1 } },
      { subtype: 'courses', kind: 'fanout', template: { instruction: 'NEW {{item.day}}', pass: 'P', fail: 'F' }, instructions: '{leading}\nNEW 1\n{trailing}\n{conditions}\n\nPass: P\n{pass}\nFail: F\n{fail}', items: [{ day: 1 }], renderCtx: {}, itemVars: [], contexts: [0], tools: ['web_search'], opaque: { y: 2 } },
      { subtype: 'nutrients', instructions: 'KEEP STEP TWO' },
    ],
  })
})

test('Equivalence Partitioning: repair refuses a missing job', async () => {
  await assert.rejects(() => repairFrozenPlan({
    jobId: 'missing-job', stepIndex: 1, expectedSubtype: 'courses',
    canonicalTemplate: { instruction: 'NEW', pass: 'P', fail: 'F' }, expectedRenderedUnits: ['unused'],
    readJob: async () => ({ exists: false }), writeJob: async () => {},
  }), /missing-job.*does not exist|missing job/i)
})

test('Boundary Value Analysis: repair refuses a step index equal to plan length', async () => {
  await assert.rejects(() => repairFrozenPlan({
    jobId: 'job-exact', stepIndex: 2, expectedSubtype: 'courses',
    canonicalTemplate: { instruction: 'NEW', pass: 'P', fail: 'F' }, expectedRenderedUnits: ['unused'],
    readJob: async () => ({ exists: true, updateTime: 'update-7', data: { plan: [{ subtype: 'recipes' }, { subtype: 'courses' }] } }), writeJob: async () => {},
  }), /plan\[2\]|step index 2/i)
})

test('Equivalence Partitioning: repair refuses a target step with the wrong subtype', async () => {
  await assert.rejects(() => repairFrozenPlan({
    jobId: 'job-exact', stepIndex: 1, expectedSubtype: 'courses',
    canonicalTemplate: { instruction: 'NEW', pass: 'P', fail: 'F' }, expectedRenderedUnits: ['unused'],
    readJob: async () => ({ exists: true, updateTime: 'update-7', data: { plan: [{ subtype: 'recipes' }, { subtype: 'nutrients' }] } }), writeJob: async () => {},
  }), /expected.*courses|subtype.*nutrients/i)
})

test('Equivalence Partitioning: commit refuses a missing exact update-time precondition', async () => {
  await assert.rejects(() => repairFrozenPlan({
    jobId: 'job-exact', stepIndex: 1, expectedSubtype: 'courses', commit: true,
    canonicalTemplate: { instruction: 'NEW', pass: 'P', fail: 'F' }, expectedRenderedUnits: ['unused'],
    readJob: async () => ({ exists: true, updateTime: 'update-7', data: { plan: [{ subtype: 'recipes' }, { subtype: 'courses' }] } }), writeJob: async () => {},
  }), /expectedUpdateTime|update-time precondition|CAS/i)
})

test('Domain Analysis: commit refuses when the supplied update-time no longer equals the job snapshot', async () => {
  await assert.rejects(() => repairFrozenPlan({
    jobId: 'job-exact', stepIndex: 1, expectedSubtype: 'courses', commit: true, expectedUpdateTime: 'stale-update',
    canonicalTemplate: { instruction: 'NEW', pass: 'P', fail: 'F' }, expectedRenderedUnits: ['unused'],
    readJob: async () => ({ exists: true, updateTime: 'current-update', data: { plan: [{ subtype: 'recipes' }, { subtype: 'courses' }] } }), writeJob: async () => {},
  }), /stale-update.*current-update|update.*mismatch|CAS/i)
})

test('Combinatorial: repair renders every unit and refuses the entire operation when even one unit differs', async () => {
  const writes = []
  await assert.rejects(() => repairFrozenPlan({
    jobId: 'job-exact', stepIndex: 1, expectedSubtype: 'courses', commit: true, expectedUpdateTime: 'update-7',
    canonicalTemplate: { instruction: 'NEW {{item.day}}', pass: 'P', fail: 'F' },
    expectedRenderedUnits: [
      '{leading}\nNEW 1\n{trailing}\n{conditions}\n\nPass: P\n{pass}\nFail: F\n{fail}',
      'INTENTIONALLY DIFFERENT UNIT TWO',
    ],
    readJob: async () => ({ exists: true, updateTime: 'update-7', data: { plan: [{ subtype: 'recipes' }, { subtype: 'courses', template: { instruction: 'OLD', pass: '', fail: '' }, instructions: 'DRIFT', items: [{ day: 1 }, { day: 2 }], renderCtx: {}, itemVars: [] }] } }),
    writeJob: async (...args) => { writes.push(args) },
  }), /1\/2|unit 1|100%|render.*match/i)

  assert.deepEqual(writes, [])
})
