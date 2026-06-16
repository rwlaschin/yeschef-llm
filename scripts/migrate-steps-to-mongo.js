// scripts/migrate-steps-to-mongo.js — one-time migration of the Step Library from Firestore
// (`step_library`) to Mongo (`plan_library`, alongside prompt_library). The dashboard + /ai/menu
// now read steps from Mongo; this moves the existing docs over.
//
// Firestore string doc ids are NOT carried over as Mongo _id (the dashboard endpoints resolve ids
// via ObjectId) — Mongo mints fresh ObjectIds. Nothing references a step by id once a plan is
// composed, so that's safe. All other fields (order/active/subtype/instruction/…) are preserved.
//
// Usage:
//   node scripts/migrate-steps-to-mongo.js            # DRY RUN — read both DBs, print, write nothing
//   node scripts/migrate-steps-to-mongo.js --write     # actually insert into Mongo plan_library
//   node scripts/migrate-steps-to-mongo.js --write --force   # insert even if Mongo already has steps

import dotenvFlow from "dotenv-flow";
dotenvFlow.config({ node_env: process.env.NODE_ENV || "dev" });

import admin from "firebase-admin";
import { MongoClient } from "mongodb";

const WRITE = process.argv.includes("--write");
const FORCE = process.argv.includes("--force");
const { MONGO_URI, MONGO_DB = "yeschef", GCP_PROJECT_ID, FIREBASE_PROJECT_ID } = process.env;

if (!MONGO_URI) { console.error("MONGO_URI not set (expected from .env.dev)."); process.exit(1); }
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("GOOGLE_APPLICATION_CREDENTIALS not set — cannot read prod Firestore."); process.exit(1);
}

const projectId = FIREBASE_PROJECT_ID || GCP_PROJECT_ID;
if (!admin.apps.length) admin.initializeApp({ projectId }); // ADC via GOOGLE_APPLICATION_CREDENTIALS
const fs = admin.firestore();

const mongo = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });

const fmt = (d) =>
  `  · ${JSON.stringify(d.name)}  order=${JSON.stringify(d.order ?? "")} active=${d.active === true} subtype=${d.subtype ?? "(none)"} kind=${d.kind ?? "?"}`;

async function main() {
  // ── Source: prod Firestore step_library ──
  const snap = await fs.collection("step_library").get();
  const src = snap.docs.map((d) => ({ firestoreId: d.id, ...d.data() }));
  console.log(`\nFirestore step_library (project ${projectId}): ${src.length} doc(s)`);
  src.forEach((d) => console.log(fmt(d)));

  // ── Target: Mongo ──
  await mongo.connect();
  const db = mongo.db(MONGO_DB);
  const stepCol = db.collection("plan_library");
  const [existingSteps, promptCount] = await Promise.all([
    stepCol.find({}).toArray(),
    db.collection("prompt_library").countDocuments(),
  ]);
  console.log(`\nMongo "${MONGO_DB}": plan_library=${existingSteps.length} doc(s), prompt_library=${promptCount} doc(s)`);
  if (existingSteps.length) existingSteps.forEach((d) => console.log(fmt(d)));

  if (!WRITE) {
    console.log(`\nDRY RUN — nothing written. Re-run with --write to migrate ${src.length} step(s) into Mongo "${MONGO_DB}".`);
    return;
  }
  if (existingSteps.length && !FORCE) {
    console.error(`\nABORT: Mongo plan_library already has ${existingSteps.length} doc(s). Re-run with --force to insert anyway (may duplicate).`);
    process.exitCode = 1;
    return;
  }
  if (!src.length) { console.log("\nNothing to migrate (Firestore step_library is empty)."); return; }

  // Strip the Firestore id; Mongo mints _id. Preserve all fields; stamp timestamps if missing.
  const now = new Date();
  const docs = src.map(({ firestoreId, createdAt, updatedAt, ...rest }) => ({
    ...rest,
    createdAt: createdAt ? new Date(createdAt._seconds ? createdAt._seconds * 1000 : createdAt) : now,
    updatedAt: now,
  }));
  const res = await stepCol.insertMany(docs);
  console.log(`\n✓ Inserted ${res.insertedCount} step(s) into Mongo "${MONGO_DB}".plan_library`);
  console.log("  (Firestore step_library left intact — delete it manually once you've verified.)");
}

main()
  .catch((e) => { console.error("Migration failed:", e); process.exitCode = 1; })
  .finally(async () => { await mongo.close().catch(() => {}); process.exit(); });
