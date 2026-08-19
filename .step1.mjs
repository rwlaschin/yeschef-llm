// Step 1 of the step-wise run: protein_grid ONLY, real inference, via the real /ai/menu.
// Payload shape copied from dashboard/components/MenuForm.vue submit() — no planId, built on the fly.
import fs from 'node:fs'
const AI = 'http://localhost:5101/yeschef-c572a/us-central1/ai'
const env = Object.fromEntries(
  fs.readFileSync('/Users/mac/Documents/Work/alimenta/yeschef/.env.local', 'utf8')
    .split('\n').filter(l => l.includes('=') && !l.trimStart().startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const login = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.NEXT_PUBLIC_FIREBASE_API_KEY}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'test.headchef@yeschef.test', password: process.env.E2E_PASSWORD || 'TestPass!2026', returnSecureToken: true }) })
if (!login.ok) { console.error('sign-in failed', login.status); process.exit(1) }
const { idToken } = await login.json()
console.log('signed in OK')

const body = {
  userId: 'cwvBmsCQFjfo2AviIwKmRXlIvwy1',        // TEST Head Chef
  companyId: '6a31baf5f3bca3f80fa3a340',          // YesChef
  values: { institution: 'Senior Care', legals: 'FDA Food Code,CMS',
            diets: 'regular,low-sodium,renal,vegetarian', restrictions: 'no nuts',
            preferences: 'comfort foods', meals: 'breakfast,lunch,dinner' },
  duration: { weeks: 1, businessDaysOnly: false },
  residents: 300, flags: {}, costTier: 'standard', location: 'America/Los_Angeles',
  dietWeights: { regular: 50, 'low-sodium': 12, renal: 8, vegetarian: 8 },
  enabled: { protein_grid: true, recipes: false, nutrients: false, compliance: false,
             menu: false, recipe: false, nutrition: false, inventory: false, order_form: false },
  fake: false,                                     // REAL 8B inference
}
const r = await fetch(`${AI}/menu`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
  body: JSON.stringify(body) })
const text = await r.text()
console.log('POST /ai/menu →', r.status, text.slice(0, 300))
