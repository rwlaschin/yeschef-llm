// Make the table-output pragma OVERRIDABLE everywhere it is authored.
//
// THE BUG THIS FIXES: every table subtype states its output contract twice — once in its
// `*_system` prompt_library fragment, once in its plan_library instruction — and both said
//   "Output ONLY pipe-delimited rows, one per line, with this header and nothing else:"
// "nothing else" is absolute, so NO later fragment can legally add a column. A step that wants an
// extra column (courses' `Reason`) is then arguing with a rule that already closed the question,
// and the model obeys the rule it read first.
//
// Measured, raw against llama3.1:8b on the real prompts:
//   recipes, clause present but 3 competing 10-col headers left → 10 cells, no Reason column
//   recipes, every authored header rewritten to 11-col          → 11 cells, Reason populated
// So the clause is NECESSARY (it stops the pragma forbidding the override) but NOT SUFFICIENT
// (a printed 10-column header still outvotes prose). This script does the first half only —
// it changes no header and no column set, so behaviour is unchanged for every subtype that
// does not override. Courses' plan_library row already carries the clause; it is left alone.
//
//   node scripts/pragma-allow-override.mjs           # dry run
//   node scripts/pragma-allow-override.mjs --commit
import fs from "fs";
import path from "path";
import dotenvFlow from "dotenv-flow";
import { MongoClient } from "mongodb";

dotenvFlow.config({ node_env: "dev" });
const COMMIT = process.argv.includes("--commit");

// TWO authored wordings, and the plan_library one is the stricter of the pair — it closes the
// COLUMNS as well as the header, so it must be relaxed too or the override is still illegal there.
const SUFFIX = ", UNLESS you are specifically instructed to overload it:";
const VARIANTS = [
  "with this header and nothing else:",                       // prompt_library `*_system` fragments
  "with this exact header and columns and nothing else:",      // plan_library `Build *` instructions
];
const relax = (v) => VARIANTS.reduce((s, o) => s.split(o).join(o.slice(0, -1) + SUFFIX), v);
const hitsIn = (v) => VARIANTS.reduce((n, o) => n + (v.split(o).length - 1), 0);
const NEW = SUFFIX;

// field per collection — prompt_library holds `content`, plan_library holds `instruction`.
const TARGETS = [
  ["prompt_library", "content"],
  ["plan_library", "instruction"],
];

const uri = process.env.MONGO_URI;
const dbName = process.env.MONGO_DB || "yeschef";
if (!uri) { console.error("MONGO_URI unset — check .env.dev"); process.exit(1); }

const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);
  const backup = {};
  const plan = [];

  for (const [coll, field] of TARGETS) {
    const docs = await db.collection(coll).find({}).toArray();
    backup[coll] = docs;
    for (const d of docs) {
      const v = String(d[field] || "");
      const hits = hitsIn(v);
      if (!hits) continue;
      plan.push({ coll, field, _id: d._id, name: d.name, hits, next: relax(v) });
    }
  }

  console.log(JSON.stringify({
    db: dbName,
    docsToChange: plan.length,
    occurrences: plan.reduce((n, p) => n + p.hits, 0),
    rows: plan.map((p) => ({ collection: p.coll, name: p.name, occurrences: p.hits })),
  }, null, 2));

  // Anyone ALREADY permissive must be left exactly as-is — proves we are not rewriting courses.
  for (const [coll, field] of TARGETS) {
    const already = (await db.collection(coll).find({}).toArray())
      .filter((d) => String(d[field] || "").includes(NEW))
      .map((d) => d.name);
    console.log(`already permissive in ${coll}: ${already.length ? already.join(", ") : "none"}`);
  }

  if (!plan.length) { console.log("\nnothing to do."); }
  else if (!COMMIT) { console.log("\nDRY RUN — nothing written. Re-run with --commit."); }
  else {
    const dir = path.join(process.cwd(), "scripts", "backups");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `pragma-allow-override-backup-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(backup, null, 2));
    console.log(`\nbacked up ${Object.entries(backup).map(([c, d]) => `${c}(${d.length})`).join(" ")} → ${file}`);

    for (const p of plan) {
      const r = await db.collection(p.coll).updateOne({ _id: p._id }, { $set: { [p.field]: p.next, updatedAt: new Date() } });
      console.log(`  ${p.coll} "${p.name}": matched=${r.matchedCount} modified=${r.modifiedCount}`);
    }

    // Verify by RE-READING: no absolute pragma may survive anywhere, and the only textual
    // difference must be this clause — a changed header or column set here would be a defect.
    let absolute = 0, permissive = 0, otherDiff = [];
    for (const [coll, field] of TARGETS) {
      for (const d of await db.collection(coll).find({}).toArray()) {
        const v = String(d[field] || "");
        absolute += hitsIn(v);
        permissive += v.split(NEW).length - 1;
        const before = String(backup[coll].find((b) => String(b._id) === String(d._id))?.[field] || "");
        if (relax(before) !== v) otherDiff.push(`${coll}/${d.name}`);
      }
    }
    console.log(`\nre-read: absolute pragmas remaining=${absolute} (must be 0), permissive=${permissive}`);
    console.log(`unexpected edits: ${otherDiff.length ? otherDiff.join(", ") : "none"}`);
  }
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
