// Courses-only status contract, so the Fail-criteria requirement can be tested on ONE subtype.
//
// The shared contract (prompt_library 6a28a5a25b0a853a539963d2, mapped to every subtype) defines
// PASS purely in terms of the Pass list: "the task fully met EVERY Pass criterion". The Fail list
// therefore never enters the verdict — measured: llama3.1:8b returned @@::PASS::@@ on a courses row
// that matched two explicit Fail conditions, and its stated reasons cited only Pass items.
//
// This clones that contract for `courses` with the PASS line amended, and unmaps the shared one for
// `courses` only — every other subtype keeps the original, so any behaviour change is attributable.
//
//   node scripts/courses-status-contract.mjs           # dry run
//   node scripts/courses-status-contract.mjs --commit
import fs from "fs";
import path from "path";
import dotenvFlow from "dotenv-flow";
import { MongoClient } from "mongodb";

dotenvFlow.config({ node_env: "dev" });
const COMMIT = process.argv.includes("--commit");

const SHARED_ID = "6a28a5a25b0a853a539963d2";
const OLD_PASS_LINE = "@@::PASS::@@          — the task fully met EVERY Pass criterion";
const NEW_PASS_LINE = "@@::PASS::@@          — the task fully met EVERY Pass criterion and MUST NOT meet any of the Fail criterion";

const uri = process.env.MONGO_URI;
const dbName = process.env.MONGO_DB || "yeschef";
if (!uri) { console.error("MONGO_URI unset — check .env.dev"); process.exit(1); }

const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);
  const promptLib = await db.collection("prompt_library").find({}).toArray();
  const shared = promptLib.find((d) => String(d._id) === SHARED_ID);
  if (!shared) throw new Error(`no prompt_library doc ${SHARED_ID}`);

  const content = String(shared.content || "");
  if (!content.includes(OLD_PASS_LINE)) throw new Error("PASS line not found verbatim in the shared contract — aborting");
  const coursesContent = content.split(OLD_PASS_LINE).join(NEW_PASS_LINE);

  const newSharedMapping = { ...(shared.mapping || {}) };
  const coursesOrder = newSharedMapping.courses;          // keep the SAME order key
  delete newSharedMapping.courses;
  if (coursesOrder == null) throw new Error("shared contract is not mapped to courses — nothing to split");

  const doc = {
    name: "Courses status contract",
    mapping: { courses: coursesOrder },
    active: true,
    content: coursesContent,
  };

  console.log(JSON.stringify({
    db: dbName,
    coursesOrderKey: coursesOrder,
    passLineBefore: OLD_PASS_LINE,
    passLineAfter: NEW_PASS_LINE,
    sharedMappingBefore: shared.mapping,
    sharedMappingAfter: newSharedMapping,
    contentIdenticalExceptPassLine: coursesContent.length - content.length === NEW_PASS_LINE.length - OLD_PASS_LINE.length,
  }, null, 2));

  if (!COMMIT) { console.log("\nDRY RUN — nothing written. Re-run with --commit."); }
  else {
    const dir = path.join(process.cwd(), ".backups");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path.join(dir, `courses-status-contract-backup-${stamp}.json`);
    fs.writeFileSync(backup, JSON.stringify({ prompt_library: promptLib }, null, 2));
    console.log(`backed up prompt_library(${promptLib.length}) → ${backup}`);

    const r1 = await db.collection("prompt_library").updateOne({ name: doc.name }, { $set: { ...doc, updatedAt: new Date() } }, { upsert: true });
    console.log(`${doc.name}: ${r1.upsertedCount ? "inserted" : "updated"}`);
    const r2 = await db.collection("prompt_library").updateOne({ _id: shared._id }, { $set: { mapping: newSharedMapping, updatedAt: new Date() } });
    console.log(`shared contract mapping: matched=${r2.matchedCount} modified=${r2.modifiedCount}`);

    const after = await db.collection("prompt_library").find({}).toArray();
    for (const sub of ["courses", "recipes", "protein_grid", "nutrients", "recipe_detail"]) {
      const frags = after.filter((p) => p.mapping && p.mapping[sub] != null)
        .sort((a, b) => (String(a.mapping[sub]) < String(b.mapping[sub]) ? -1 : 1));
      const hasNew = frags.some((f) => String(f.content).includes(NEW_PASS_LINE));
      console.log(`  ${sub.padEnd(15)} fragments=${frags.length}  amendedPassLine=${hasNew}`);
    }
  }
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
