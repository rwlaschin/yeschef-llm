// scripts/cleanup-firestore-steps.js — remove the old Firestore `step_library` collection AFTER the
// migration to Mongo `plan_library`. Irreversible, so it: (1) verifies Mongo plan_library still holds
// every Firestore step (by name), (2) writes a local JSON backup of the Firestore docs, and only then,
// with --confirm, (3) deletes the Firestore docs.
//
// Usage:
//   node scripts/cleanup-firestore-steps.js            # DRY RUN — verify + back up, delete nothing
//   node scripts/cleanup-firestore-steps.js --confirm   # actually delete the Firestore docs

import dotenvFlow from "dotenv-flow";
dotenvFlow.config({ node_env: process.env.NODE_ENV || "dev" });

import { writeFileSync } from "fs";
import admin from "firebase-admin";
import { MongoClient } from "mongodb";

const CONFIRM = process.argv.includes("--confirm");
const { MONGO_URI, MONGO_DB = "yeschef", GCP_PROJECT_ID, FIREBASE_PROJECT_ID } = process.env;

if (!MONGO_URI) { console.error("MONGO_URI not set (expected from .env.dev)."); process.exit(1); }
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("GOOGLE_APPLICATION_CREDENTIALS not set — cannot reach prod Firestore."); process.exit(1);
}

const projectId = FIREBASE_PROJECT_ID || GCP_PROJECT_ID;
if (!admin.apps.length) admin.initializeApp({ projectId });
const fs = admin.firestore();
const mongo = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });

async function main() {
  // ── Read the Firestore source docs ──
  const snap = await fs.collection("step_library").get();
  const fsDocs = snap.docs.map((d) => ({ firestoreId: d.id, ...d.data() }));
  console.log(`Firestore step_library (project ${projectId}): ${fsDocs.length} doc(s)`);
  if (!fsDocs.length) { console.log("Already empty — nothing to clean up."); return; }

  // ── Safety check: every Firestore step must exist in Mongo plan_library (match on name) ──
  await mongo.connect();
  const mongoDocs = await mongo.db(MONGO_DB).collection("plan_library").find({}).toArray();
  const mongoNames = new Set(mongoDocs.map((d) => String(d.name).trim()));
  const missing = fsDocs.filter((d) => !mongoNames.has(String(d.name).trim()));
  console.log(`Mongo "${MONGO_DB}".plan_library: ${mongoDocs.length} doc(s).`);
  if (missing.length) {
    console.error(`\nABORT: these Firestore steps are NOT in Mongo plan_library — migration incomplete:`);
    missing.forEach((d) => console.error(`  · ${JSON.stringify(d.name)}`));
    process.exitCode = 1;
    return;
  }
  console.log("✓ Every Firestore step is present in Mongo plan_library.");

  // ── Backup (local file) — a restore path even though the data also lives in Mongo ──
  const stamp = process.env.STAMP || "backup";
  const path = `scripts/firestore-step_library-${stamp}.json`;
  writeFileSync(path, JSON.stringify(fsDocs, null, 2));
  console.log(`✓ Backed up ${fsDocs.length} Firestore doc(s) → ${path}`);

  if (!CONFIRM) {
    console.log(`\nDRY RUN — Firestore left intact. Re-run with --confirm to delete ${fsDocs.length} doc(s).`);
    return;
  }

  // ── Delete ──
  const batch = fs.batch();
  for (const d of fsDocs) batch.delete(fs.collection("step_library").doc(d.firestoreId));
  await batch.commit();
  const after = (await fs.collection("step_library").get()).size;
  console.log(`\n✓ Deleted Firestore step_library docs. Remaining: ${after}.`);
}

main()
  .catch((e) => { console.error("Cleanup failed:", e); process.exitCode = 1; })
  .finally(async () => { await mongo.close().catch(() => {}); process.exit(); });
