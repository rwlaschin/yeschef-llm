// Targeted, reversible, concurrency-safe patching of one field in one prompt/plan record.
//
// Two sessions edit these collections at once. A whole-collection restore would clobber the other
// player's work, so there is no bulk path here at all — every operation is scoped to a single _id
// and a single field.
//
// Safety chain, in order:
//   1. Read the record FRESH from Mongo (never from a cache) and back up that exact document.
//   2. Compare-and-swap: the update matches on _id AND on the field still containing the expected
//      anchor. If the other player changed that field first, the update matches 0 documents and
//      no-ops rather than overwriting them.
//   3. Read back and diff against intent. Any mismatch restores from the backup taken in step 1.
//   4. Dry run is the DEFAULT. Writing requires --commit.
//
// Usage:
//   node scripts/prompt-patch.mjs --list
//   node scripts/prompt-patch.mjs --id <_id> --field instruction --anchor-file a.txt --replace-file b.txt
//   node scripts/prompt-patch.mjs ... --commit
//   node scripts/prompt-patch.mjs --restore .backups/<file>.json
import dotenvFlow from "dotenv-flow"; dotenvFlow.config({ node_env: "dev" });
import { MongoClient, ObjectId } from "mongodb";
import fs from "node:fs";
import path from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); const v = i > -1 ? process.argv[i + 1] : undefined; return v === undefined || v.startsWith("--") ? d : v; };
const has = (k) => process.argv.includes(`--${k}`);
const BACKUP_DIR = ".backups";
const COLLECTIONS = ["plan_library", "prompt_library"];

const die = (m) => { console.error(`REFUSING: ${m}`); process.exit(1); };

const mc = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000 });
await mc.connect();
const db = mc.db(process.env.MONGO_DB || "yeschef");

// _id may be a real ObjectId or a plain string depending on how the record was created; the cached
// JSON stringifies both. Try the raw value first, then the ObjectId form.
const candidates = (id) => {
  const out = [id];
  if (typeof id === "string" && /^[0-9a-f]{24}$/i.test(id)) { try { out.push(new ObjectId(id)); } catch {} }
  return out;
};
const findById = async (id) => {
  for (const c of COLLECTIONS)
    for (const key of candidates(id)) {
      const doc = await db.collection(c).findOne({ _id: key });
      if (doc) return { coll: c, doc, key };
    }
  return null;
};

if (has("list")) {
  for (const c of COLLECTIONS)
    for (const r of await db.collection(c).find({}).toArray())
      console.log(`${r._id}  ${c.padEnd(14)}  ${(r.name || "(unnamed)").padEnd(38)}  ${r.active ? "active" : "INACTIVE"}`);
  await mc.close(); process.exit(0);
}

if (has("restore")) {
  const file = arg("restore");
  const b = JSON.parse(fs.readFileSync(file, "utf8"));
  const cur = await findById(b._id);
  if (!cur) die(`_id ${b._id} no longer exists`);
  console.log(`RESTORE ${b.coll}/${b.name || "(unnamed)"} field '${b.field}'`);
  console.log(`  current ${cur.doc[b.field]?.length ?? 0}c  →  backup ${b.before?.length ?? 0}c`);
  const live = cur.doc[b.field];
  const untouched = b.after === undefined || live === b.after;
  if (!untouched) {
    console.log(`  WARNING: the field no longer holds what this backup wrote — someone edited it since.`);
    if (!has("force")) die("restoring would delete their change. Re-read it, merge, and patch forward. --force overrides.");
  }
  if (!has("commit")) { console.log(`\n  changed-since: ${!untouched}\nDRY RUN — add --commit to apply`); await mc.close(); process.exit(0); }
  // Back up what we are about to overwrite, so the restore is itself undoable.
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const pre = path.join(BACKUP_DIR, `${cur.coll}-${(cur.doc.name || "unnamed").replace(/\W+/g, "_")}-${b.field}-prerestore-${Date.now()}.json`);
  fs.writeFileSync(pre, JSON.stringify({ _id: b._id, coll: cur.coll, name: cur.doc.name ?? null, field: b.field, before: live, takenAt: new Date().toISOString() }, null, 2));
  console.log(`  pre-restore backup: ${pre}`);
  // Compare-and-swap on the CURRENT value, so a concurrent edit between the check above and here
  // aborts instead of clobbering.
  const res = await db.collection(cur.coll).updateOne({ _id: cur.key, [b.field]: live }, { $set: { [b.field]: b.before } });
  if (res.matchedCount === 0) { console.error("ABORTED — field changed during restore. Nothing written."); await mc.close(); process.exit(1); }
  const back = await findById(b._id);
  console.log(`matched=${res.matchedCount} modified=${res.modifiedCount}  verified=${back.doc[b.field] === b.before}`);
  await mc.close(); process.exit(back.doc[b.field] === b.before ? 0 : 1);
}

const id = arg("id"), field = arg("field");
if (!id || !field) die("need --id and --field (or --list / --restore)");
// One field may need several edits. They are applied together in ONE compare-and-swap so the field
// is never left half-patched: either every edit lands or none does.
//   --edits-file <json>   [{ "anchor": "...", "replace": "..." }, ...]
//   --anchor-file/--replace-file   shorthand for a single edit
const EDITS = has("edits-file")
  ? JSON.parse(fs.readFileSync(arg("edits-file"), "utf8"))
  : [{ anchor: fs.readFileSync(arg("anchor-file") || die("need --anchor-file or --edits-file"), "utf8"),
       replace: fs.readFileSync(arg("replace-file") || die("need --replace-file"), "utf8") }];
if (!Array.isArray(EDITS) || !EDITS.length) die("--edits-file must be a non-empty array");

const found = await findById(id);
if (!found) die(`_id ${id} not found in either collection`);
const { coll, doc, key } = found;
const before = doc[field];
if (typeof before !== "string") die(`${coll}/${doc.name}.${field} is ${typeof before}, not a string`);

let after = before;
EDITS.forEach((e, i) => {
  if (typeof e.anchor !== "string" || typeof e.replace !== "string") die(`edit ${i + 1}: anchor and replace must both be strings`);
  const hits = after.split(e.anchor).length - 1;
  if (hits === 0) die(`edit ${i + 1}: anchor not present in ${coll}/${doc.name}.${field} — someone changed it, or the anchor is wrong`);
  if (hits > 1) die(`edit ${i + 1}: anchor appears ${hits}x — ambiguous, refusing`);
  const next = after.replace(e.anchor, () => e.replace);
  if (next === after) die(`edit ${i + 1}: replacement is a no-op`);
  after = next;
});
if (after === before) die("all edits are no-ops");

console.log(`TARGET   ${coll}/${doc.name || "(unnamed)"}.${field}   _id=${id}`);
console.log(`SIZE     ${before.length}c → ${after.length}c  (${after.length - before.length >= 0 ? "+" : ""}${after.length - before.length})`);
console.log(`EDITS    ${EDITS.length}, each anchor found exactly once, applied as one write`);
EDITS.forEach((e, i) => {
  console.log(`\n--- edit ${i + 1}: removing ---\n${e.anchor.slice(0, 300)}${e.anchor.length > 300 ? "\n… (preview truncated)" : ""}`);
  console.log(`--- edit ${i + 1}: inserting ---\n${e.replace.slice(0, 300)}${e.replace.length > 300 ? "\n… (preview truncated)" : ""}`);
});

if (!has("commit")) { console.log("\nDRY RUN — nothing written. Add --commit to apply."); await mc.close(); process.exit(0); }

fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = `${coll}-${(doc.name || "unnamed").replace(/\W+/g, "_")}-${field}-${Date.now()}.json`;
const backupPath = path.join(BACKUP_DIR, stamp);
fs.writeFileSync(backupPath, JSON.stringify({ _id: id, coll, name: doc.name ?? null, field, before, after, takenAt: new Date().toISOString() }, null, 2));
console.log(`\nBACKUP   ${backupPath}`);

// Compare-and-swap: only write if the field STILL holds the anchor. If the other player changed it
// between our read and this update, matchedCount is 0 and their work is untouched.
const res = await db.collection(coll).updateOne({ _id: key, [field]: before }, { $set: { [field]: after } });
if (res.matchedCount === 0) {
  console.error(`\nABORTED — ${coll}/${doc.name}.${field} changed underneath us. Nothing written. Backup kept.`);
  await mc.close(); process.exit(1);
}

const verify = await findById(id);
const ok = verify.doc[field] === after;
console.log(`WRITE    matched=${res.matchedCount} modified=${res.modifiedCount}`);
console.log(`VERIFY   read-back matches intent: ${ok}`);
if (!ok) {
  console.error("MISMATCH — rolling back from backup");
  await db.collection(coll).updateOne({ _id: key, [field]: verify.doc[field] }, { $set: { [field]: before } });
  const back = await findById(id);
  console.error(`ROLLBACK restored: ${back.doc[field] === before}`);
  await mc.close(); process.exit(1);
}
console.log(`\nUndo:  node scripts/prompt-patch.mjs --restore ${backupPath} --commit`);
await mc.close();
process.exit(0);
