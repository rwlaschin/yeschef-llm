#!/usr/bin/env node
// SELF-MAINTAINING SANITY CHECK for the deployed /ai orchestrator.
//
//   npm run smoke                    read-only, against production
//   SMOKE_BUILD=1 npm run smoke      + a real meal-plan build (WRITES to Firestore)
//   SMOKE_AI=http://localhost:5101/yeschef-c572a/us-central1/ai npm run smoke     local
//
// NOTHING HERE IS A HARDCODED ROUTE LIST. The endpoints are parsed out of functions/index.js and
// the public/no-auth set out of functions/lib/auth.js, both at run time. Add `ai.post("/foo", …)`
// and it is checked on the next run with no edit here; delete a route and the check disappears with
// it. That is the whole point — a hand-maintained list of endpoints goes stale and then lies.
//
// What it proves per route: the route is REACHABLE (not 404 — i.e. actually in the deployed bundle)
// and the AUTH GATE matches the source (public routes answer without a token, everything else 401s).
// A 400 from a schema preHandler counts as reachable-and-authorised: the body was rejected, not the
// route. That is deliberate — sending valid bodies to every endpoint would mean maintaining fixtures
// per route, which is the maintenance burden we are avoiding.

import fs from 'node:fs'
import path from 'node:path'
import admin from 'firebase-admin'

const ROOT = path.resolve(import.meta.dirname, '..')
const AI = process.env.SMOKE_AI || 'https://us-central1-yeschef-c572a.cloudfunctions.net/ai'
const SA = path.resolve(ROOT, '..', 'yeschef-c572a-firebase-adminsdk-fbsvc-f2933f9fbd.json')

let failed = 0
const ok  = (n, d = '') => console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`)
const bad = (n, d = '') => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? `  ${d}` : ''}`) }
const skip = (n, d = '') => console.log(`  \x1b[33m–\x1b[0m ${n}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`)
const step = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`)
const die = (m) => { console.error(`\n\x1b[31mABORT\x1b[0m ${m}`); process.exit(1) }
const t0 = Date.now()

// ── Discover the contract from source ───────────────────────────────────────
const indexSrc = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8')
const authSrc  = fs.readFileSync(path.join(ROOT, 'functions/lib/auth.js'), 'utf8')

// ai.get("/health", …) / ai.post("/resume/:step", { preHandler… }, …)
const routes = [...indexSrc.matchAll(/\bai\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g)]
  .map(([, method, route]) => ({ method: method.toUpperCase(), route }))
if (!routes.length) die('parsed 0 routes from functions/index.js — the registration pattern changed, fix the regex')

// const PUBLIC = new Set(["/health", "/events", …])
const publicBlock = authSrc.match(/PUBLIC\s*=\s*new Set\(\[([^\]]*)\]/)
const PUBLIC = new Set([...(publicBlock?.[1] ?? '').matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]))
if (!PUBLIC.size) die('parsed 0 public routes from functions/lib/auth.js — the PUBLIC set moved')

console.log(`\x1b[1myeschef-llm smoke\x1b[0m  ${AI}`)
console.log(`\x1b[2mdiscovered ${routes.length} routes, ${PUBLIC.size} public: ${[...PUBLIC].join(' ')}\x1b[0m`)

const call = async (method, url, { token, body, ms = 30000 } = {}) => {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
      signal: ctl.signal,
    })
    return { status: r.status, text: await r.text().catch(() => '') }
  } catch (e) { return { status: 0, text: '', err: e.name } } finally { clearTimeout(to) }
}
// :params need *some* value to resolve the route; the id is deliberately nonsense — we are testing
// routing and auth, not the handler's data.
const concrete = (route) => route.replace(/:[^/]+/g, 'smoke')

// ── 1. Liveness ─────────────────────────────────────────────────────────────
step('1. Liveness')
const health = await call('GET', `${AI}/health`)
health.status === 200 ? ok('GET /health', health.text.slice(0, 40)) : bad('GET /health', `HTTP ${health.status}${health.err ? ` (${health.err})` : ''}`)
if (health.status !== 200) die('orchestrator is not answering — nothing else is meaningful')

// ── 2. Auth gate, derived from auth.js ──────────────────────────────────────
// Every non-public route MUST 401 without a token. This is the check that catches a route
// accidentally added outside the gate — a real risk, since the gate is a path allow-list.
step('2. Auth gate (no token)')
for (const { method, route } of routes) {
  const r = await call(method, `${AI}${concrete(route)}`)
  const isPublic = PUBLIC.has(route)
  if (r.status === 404) { bad(`${method} ${route}`, '404 — not in the deployed bundle'); continue }
  if (isPublic) {
    r.status === 401 ? bad(`${method} ${route}`, 'public in source but 401 deployed') : ok(`${method} ${route}`, `public, HTTP ${r.status}`)
  } else {
    r.status === 401 ? ok(`${method} ${route}`, 'gated') : bad(`${method} ${route}`, `expected 401, got ${r.status} — OUTSIDE the auth gate`)
  }
}

// ── 3. Authenticated reachability ───────────────────────────────────────────
// With a real token, no gated route may 401 or 404. A 400 is fine (schema rejected our empty body).
step('3. Authenticated reachability')
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(ROOT, '..', 'yeschef/.env.local'), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const login = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.NEXT_PUBLIC_FIREBASE_API_KEY}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: process.env.SMOKE_EMAIL || 'test.headchef@yeschef.test', password: process.env.E2E_PASSWORD || 'TestPass!2026', returnSecureToken: true }),
})
if (!login.ok) die(`Firebase sign-in failed: HTTP ${login.status}`)
const { idToken } = await login.json()
ok('firebase sign-in')

for (const { method, route } of routes.filter((r) => !PUBLIC.has(r.route))) {
  const r = await call(method, `${AI}${concrete(route)}`, { token: idToken })
  if (r.status === 404) bad(`${method} ${route}`, '404 with a valid token')
  else if (r.status === 401) bad(`${method} ${route}`, '401 with a valid token — token not accepted')
  else ok(`${method} ${route}`, `HTTP ${r.status}`)
}

// ── 4. The one deep path: a real meal-plan build ────────────────────────────
// Routing and auth prove the surface; only a build proves the PIPELINE
// (/ai/menu → Pub/Sub → worker → Firestore). Opt-in because it writes.
step('4. Meal-plan build → Pub/Sub → worker → Firestore')
if (!process.env.SMOKE_BUILD) {
  skip('skipped — writes an llmResults job + menuPlans doc', 'enable with SMOKE_BUILD=1')
} else {
  const planId = process.env.SMOKE_PLAN_ID
  const companyId = process.env.SMOKE_COMPANY_ID
  const userId = process.env.SMOKE_USER_ID
  if (!planId || !companyId || !userId) {
    bad('build', 'set SMOKE_PLAN_ID, SMOKE_COMPANY_ID, SMOKE_USER_ID (kept explicit so a smoke never guesses at real plans)')
  } else {
    const res = await call('POST', `${AI}/menu`, { token: idToken, body: {
      userId, companyId,
      values: { diets: 'diet 1', meals: 'breakfast' },
      duration: { weeks: 1, businessDaysOnly: true },
      residents: 0, flags: {}, dietWeights: {}, costTier: '', location: '',
      enabled: { recipes: true, protein_grid: false, nutrition: false, compliance: false,
                 recipe: false, nutrients: false, inventory: false, order_form: false, menu: false },
      fake: true,          // NEVER queue real inference from a smoke test — a real fan-out is ~30 min
      planId, stepId: 'recipes',
    } })
    if (res.status !== 200) bad('POST /menu', `HTTP ${res.status} ${res.text.slice(0, 120)}`)
    else {
      const { jobId } = JSON.parse(res.text)
      ok('POST /menu', `jobId ${jobId.slice(0, 8)}`)
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(SA, 'utf8'))) })
      const db = admin.firestore()
      let job = null
      for (const end = Date.now() + 120_000; Date.now() < end;) {
        job = (await db.doc(`llmResults/${jobId}`).get()).data() ?? null
        if (job && job.status !== 'running') break
        await new Promise((r) => setTimeout(r, 2000))
      }
      const units = await db.collection(`llmResults/${jobId}/steps`).get()
      const byStatus = {}
      units.forEach((d) => { const s = d.data().status ?? '?'; byStatus[s] = (byStatus[s] ?? 0) + 1 })

      job?.status === 'success' ? ok('job completed') : bad('job completed', `status=${job?.status ?? 'MISSING'}`)
      job?.cursor === job?.stepCount ? ok('cursor advanced', `${job?.cursor}/${job?.stepCount}`) : bad('cursor advanced', `cursor=${job?.cursor} stepCount=${job?.stepCount}`)
      units.size > 1 ? ok('fan-out dispatched', `${units.size} docs ${JSON.stringify(byStatus)}`) : bad('fan-out dispatched', `${units.size} docs`)
      // A unit left 'running' pins the job forever and the frontend spins with no error.
      !byStatus.running ? ok('no orphaned units') : bad('no orphaned units', `${byStatus.running} running — restart 'fake' after any 'ai' restart`)
    }
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(failed === 0 ? `\n\x1b[32mSMOKE PASS\x1b[0m  ${secs}s` : `\n\x1b[31mSMOKE FAIL\x1b[0m  ${failed} check(s) in ${secs}s`)
process.exit(failed === 0 ? 0 : 1)
