// Revert the over-broad pragma edit: restore EVERY doc pragma-allow-override.mjs touched EXCEPT
// the two recipes ones, which are what was actually asked for.
//
// The previous script relaxed the "…and nothing else:" pragma across all 8 authored copies. The ask
// was recipes only. Restores each doc's field verbatim from that run's backup, so the revert cannot
// drift — it is the pre-edit bytes, not a re-derived string.
//
//   node scripts/pragma-revert-nonrecipes.mjs           # dry run
//   node scripts/pragma-revert-nonrecipes.mjs --commit
import fs from "fs";
import path from "path";
import dotenvFlow from "dotenv-flow";
import { MongoClient, ObjectId } from "mongodb";

// JSON.stringify turns an ObjectId into its hex STRING, so the backup's `_id` no longer matches a
// real ObjectId in a query — findOne returned null for every doc and the first run reported
// "nothing to revert" while 6 docs were still edited. Rehydrate, and fall back to the 24-hex `_id`
// only when it parses (the `_default`/`_styles` style string ids must stay strings).
const idOf = (raw) => (typeof raw === "string" && /^[0-9a-f]{24}$/i.test(raw) ? new ObjectId(raw) : raw);

dotenvFlow.config({ node_env: "dev" });
const COMMIT = process.argv.includes("--commit");

const KEEP = new Set(["Recipes system", "Build Recipes"]);   // the recipes rules — stay relaxed
const FIELD = { prompt_library: "content", plan_library: "instruction" };

const dir = path.join(process.cwd(), "scripts", "backups");
const file = fs.readdirSync(dir).filter((f) => f.startsWith("pragma-allow-override-backup-")).sort().pop();
if (!file) { console.error("no pragma-allow-override backup found"); process.exit(1); }
const backup = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
console.log(`restoring from ${file}`);

const client = new MongoClient(process.env.MONGO_URI);
try {
  await client.connect();
  const db = client.db(process.env.MONGO_DB || "yeschef");
  const work = [];
  for (const [coll, field] of Object.entries(FIELD)) {
    for (const b of backup[coll] || []) {
      if (KEEP.has(b.name)) continue;
      const cur = await db.collection(coll).findOne({ _id: idOf(b._id) });
      if (!cur) continue;
      if (String(cur[field] || "") === String(b[field] || "")) continue;   // untouched already
      work.push({ coll, field, _id: idOf(b._id), name: b.name, prev: b[field] });
    }
  }
  console.log(JSON.stringify({
    reverting: work.map((w) => `${w.coll}/${w.name}`),
    keepingRelaxed: [...KEEP],
  }, null, 2));

  if (!work.length) { console.log("\nnothing to revert."); }
  else if (!COMMIT) { console.log("\nDRY RUN — nothing written. Re-run with --commit."); }
  else {
    for (const w of work) {
      const r = await db.collection(w.coll).updateOne({ _id: w._id }, { $set: { [w.field]: w.prev, updatedAt: new Date() } });
      console.log(`  reverted ${w.coll} "${w.name}": modified=${r.modifiedCount}`);
    }
    // Verify: every doc is byte-identical to the backup EXCEPT the two kept ones.
    let drift = [], relaxed = [];
    for (const [coll, field] of Object.entries(FIELD)) {
      for (const b of backup[coll] || []) {
        const cur = await db.collection(coll).findOne({ _id: idOf(b._id) });
        const same = String(cur?.[field] || "") === String(b[field] || "");
        if (KEEP.has(b.name)) { if (!same) relaxed.push(b.name); else drift.push(`${b.name} NOT relaxed!`); }
        else if (!same) drift.push(`${coll}/${b.name}`);
      }
    }
    console.log(`\nstill relaxed (expected 2): ${relaxed.join(", ") || "NONE"}`);
    console.log(`unexpected drift: ${drift.length ? drift.join(", ") : "none"}`);
  }
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
