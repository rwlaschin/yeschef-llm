// One-shot: back up + recursiveDelete the LEGACY top-level Firestore `menuPlans` collection
// (orphaned pre-company-scoping). Does NOT touch companies/{cid}/menuPlans (a different path).
// Backs up every doc (+ any subcollection docs) to .backups/ before deleting.
// Usage (NODE_ENV=dev): node scripts/_delete_menuplans.mjs [--apply]
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { writeFileSync } from "fs";

const APPLY = process.argv.includes("--apply");
const STAMP = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "20260615";
initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT_ID });
const db = getFirestore();

const col = db.collection("menuPlans"); // TOP-LEVEL only
const snap = await col.get();
console.log(`top-level menuPlans: ${snap.size} doc(s)`);

// Back up each doc + any subcollections (so "all children" is recoverable).
const backup = [];
for (const d of snap.docs) {
  const subs = await d.ref.listCollections();
  const subData = {};
  for (const sc of subs) {
    const ss = await sc.get();
    subData[sc.id] = ss.docs.map((x) => ({ id: x.id, data: x.data() }));
  }
  backup.push({ id: d.id, data: d.data(), subcollections: subData });
}
const subTotal = backup.reduce((n, b) => n + Object.values(b.subcollections).reduce((m, a) => m + a.length, 0), 0);
console.log(`  + ${subTotal} subcollection doc(s) across them`);
for (const b of backup) console.log(`  - ${b.id}${Object.keys(b.subcollections).length ? ` [subs: ${Object.keys(b.subcollections).join(",")}]` : ""}`);

if (!snap.size) { console.log("nothing to delete."); process.exit(0); }
if (!APPLY) { console.log("\n(dry run — pass --apply to back up + delete)"); process.exit(0); }

const file = `.backups/firestore-menuPlans-top-level.backup.${STAMP}.json`;
writeFileSync(file, JSON.stringify(backup, null, 2));
console.log(`\nbacked up → ${file}`);

await db.recursiveDelete(col); // deletes every doc AND its subcollections
const after = (await col.get()).size;
console.log(`recursiveDelete done — menuPlans now has ${after} doc(s)`);
process.exit(0);
