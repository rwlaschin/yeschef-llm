import admin from 'firebase-admin'; import fs from 'node:fs'
const SA='/Users/mac/Documents/Work/alimenta/yeschef-c572a-firebase-adminsdk-fbsvc-f2933f9fbd.json'
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(SA,'utf8'))) })
const db=admin.firestore(); const jobId=process.argv[2]
const snap=await db.collection('llmResults').doc(jobId).collection('steps').get()
const units=snap.docs.filter(d=>d.id!=='plan')
const running=units.filter(d=>d.data().status==='running').length
console.log(JSON.stringify({ running, total: units.length,
  statuses: units.map(d=>`${d.id}:${d.data().status}`) }))
process.exit(running>0?1:0)
