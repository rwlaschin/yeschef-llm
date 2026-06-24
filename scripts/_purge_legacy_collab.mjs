// Purge the 3 legacy collab collections (recipeComments / threadComments / suggestions) AFTER the
// unified-conversation migration. Uses listDocuments() to catch PHANTOM parent docs (whose /items
// subcollection holds data even though the parent doc itself doesn't "exist" — .get() misses these).
// Backs up everything first, then recursiveDelete. Usage: node scripts/_purge_legacy_collab.mjs [--apply]
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { writeFileSync } from "fs";

const APPLY = process.argv.includes("--apply");
const COLLS = ["recipeComments", "threadComments", "suggestions"];
initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT_ID });
const db = getFirestore();

const backup = {};
let total = 0;
for (const c of COLLS) {
  const parents = await db.collection(c).listDocuments();   // includes phantom parents
  const docs = [];
  for (const p of parents) {
    const items = await p.collection("items").get();
    for (const it of items.docs) docs.push({ path: it.ref.path, data: it.data() });
  }
  backup[c] = { parentRefs: parents.length, items: docs };
  total += docs.length;
  console.log(`${c}: ${parents.length} parent ref(s), ${docs.length} item(s)`);
}
console.log(`total legacy items: ${total}`);

if (!APPLY) { console.log("\n(dry run — pass --apply to back up + recursiveDelete)"); process.exit(0); }

writeFileSync(`db-backups/legacy-collab.backup.20260624.json`, JSON.stringify(backup, null, 2));
console.log(`\nbacked up → db-backups/legacy-collab.backup.20260624.json`);
for (const c of COLLS) { await db.recursiveDelete(db.collection(c)); console.log(`recursiveDelete ${c} ✓`); }
console.log("done.");
process.exit(0);
