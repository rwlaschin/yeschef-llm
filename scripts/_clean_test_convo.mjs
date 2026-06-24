// One-shot cleanup: delete the E2E test messages I posted into the unified `conversation` collection
// (collectionGroup scan; matches only my test texts). Usage: node scripts/_clean_test_convo.mjs [--apply]
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const MARK = /unified (collection|conversation)|migration check/i; // my test messages
initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT_ID });
const db = getFirestore();

const snap = await db.collectionGroup("conversation").get();
const victims = snap.docs.filter((d) => MARK.test(String(d.data().text ?? "")));
console.log(`conversation docs: ${snap.size} total, ${victims.length} match the test marker`);
for (const d of victims) console.log(`  - ${d.ref.path}\n      "${d.data().text}"`);

if (!victims.length) { console.log("nothing to delete."); process.exit(0); }
if (!APPLY) { console.log("\n(dry run — pass --apply to delete)"); process.exit(0); }

for (const d of victims) await d.ref.delete();
console.log(`\ndeleted ${victims.length} test message(s).`);
process.exit(0);
