import fs from 'node:fs'
import dotenvFlow from 'dotenv-flow'; dotenvFlow.config()
const { getCollection } = await import('./functions/lib/mongo.js')
const { composeFromDefs, renderUnit } = await import('./functions/entry/ai/compose.js')
const AI='http://localhost:5101/yeschef-c572a/us-central1/ai'
const env=Object.fromEntries(fs.readFileSync('/Users/mac/Documents/Work/alimenta/yeschef/.env.local','utf8')
  .split('\n').filter(l=>l.includes('=')&&!l.trimStart().startsWith('#'))
  .map(l=>[l.slice(0,l.indexOf('=')).trim(),l.slice(l.indexOf('=')+1).trim()]))
const login=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.NEXT_PUBLIC_FIREBASE_API_KEY}`,
  {method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({email:'test.headchef@yeschef.test',password:process.env.E2E_PASSWORD||'TestPass!2026',returnSecureToken:true})})
const {idToken}=await login.json()

const def=(await (await getCollection('plan_library')).find({name:'Build Protein Grid'}).toArray())[0]
const FORM={values:{diets:'regular',meals:'breakfast, lunch, dinner',institution:'Senior Care',
  legals:'FDA Food Code, CMS',restrictions:'no nuts',preferences:'comfort foods'},
  duration:{weeks:1,days:7},residents:300,costTier:'standard',region:'United States · Seattle'}
const A=renderUnit(composeFromDefs([def],FORM,{isProd:false})[0],0)

// ONE minimal change: the header becomes a required FIRST LINE instead of being excluded by "nothing else".
const B=A.replace(
  'Output ONLY pipe-delimited rows, one per line, with this exact header and columns and nothing else:',
  'Your FIRST line must be exactly this header, then one pipe-delimited row per day and mealtime:')
if (A===B) { console.error('PATCH DID NOT APPLY — instruction text differs from expectation'); process.exit(1) }
console.log('patch applied; A len',A.length,'B len',B.length)

for (const [label,q] of [['A-current',A],['B-header-first',B]]) {
  const r=await fetch(`${AI}/query`,{method:'POST',
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${idToken}`},
    body:JSON.stringify({ query:q, subtype:'protein_grid', style:'structured', fake:false,
      userId:'cwvBmsCQFjfo2AviIwKmRXlIvwy1', companyId:'6a31baf5f3bca3f80fa3a340' })})
  console.log(label,'→',r.status,(await r.text()).slice(0,160))
}
