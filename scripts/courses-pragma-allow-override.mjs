// Relax the table-output pragma in `Courses system` ONLY.
//
// The courses prompt already carries its override (`Reason column mechanism`, mapping {courses:"f"}:
// "Your table carries ONE EXTRA COLUMN, named `Reason`"). But the system fragment is read first and
// says "…with this header and nothing else:" — absolute, so the override is arguing with a rule that
// already closed the question. Measured on the real assembled prompt against llama3.1:8b:
//   pragma absolute   → 10-column header, no Reason cell on any row
//   pragma permissive → 11-column header, Reason populated on every row, no Why: block, no entree row
//
// COURSES ONLY. `Build Courses` already has the clause; every other subtype keeps its absolute
// pragma untouched, so any behaviour change is attributable to this one document.
//
//   node scripts/courses-pragma-allow-override.mjs           # dry run
//   node scripts/courses-pragma-allow-override.mjs --commit
import fs from "fs";
import path from "path";
import dotenvFlow from "dotenv-flow";
import { MongoClient } from "mongodb";

dotenvFlow.config({ node_env: "dev" });
const COMMIT = process.argv.includes("--commit");

const NAME = "Courses system";
const OLD = "with this header and nothing else:";
const NEW = "with this header and nothing else, UNLESS you are specifically instructed to overload it:";

const client = new MongoClient(process.env.MONGO_URI);
try {
  await client.connect();
  const db = client.db(process.env.MONGO_DB || "yeschef");
  const all = await db.collection("prompt_library").find({}).toArray();
  const doc = all.find((d) => d.name === NAME);
  if (!doc) throw new Error(`no prompt_library doc named ${JSON.stringify(NAME)}`);

  const before = String(doc.content || "");
  const hits = before.split(OLD).length - 1;
  if (hits !== 1) throw new Error(`expected exactly 1 absolute pragma in "${NAME}", found ${hits} — aborting`);
  const after = before.split(OLD).join(NEW);

  console.log(JSON.stringify({
    doc: NAME, mapping: doc.mapping, occurrences: hits,
    lenBefore: before.length, lenAfter: after.length,
    onlyDiffIsTheClause: after.length - before.length === NEW.length - OLD.length,
  }, null, 2));
  console.log(`\n- ${OLD}\n+ ${NEW}`);

  if (!COMMIT) { console.log("\nDRY RUN — nothing written. Re-run with --commit."); }
  else {
    const dir = path.join(process.cwd(), ".backups");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `courses-pragma-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify({ prompt_library: all }, null, 2));
    console.log(`\nbacked up prompt_library(${all.length}) → ${file}`);

    const r = await db.collection("prompt_library").updateOne({ _id: doc._id }, { $set: { content: after, updatedAt: new Date() } });
    console.log(`${NAME}: matched=${r.matchedCount} modified=${r.modifiedCount}`);

    // Verify against a RE-READ, and prove containment: every other doc byte-identical to the backup.
    const now = await db.collection("prompt_library").find({}).toArray();
    const me = now.find((d) => d.name === NAME);
    const drift = now.filter((d) => d.name !== NAME)
      .filter((d) => JSON.stringify(d.content) !== JSON.stringify(all.find((b) => String(b._id) === String(d._id))?.content));
    console.log(`re-read "${NAME}": absolute=${String(me.content).split(OLD).length - 1} (must be 0), permissive=${String(me.content).split(NEW).length - 1}`);
    console.log(`other prompt_library docs changed: ${drift.length ? drift.map((d) => d.name).join(", ") : "none"}`);

    // The assembled courses system prompt — what the worker will actually send.
    const frags = now.filter((f) => f.mapping?.courses != null)
      .sort((a, b) => (String(a.mapping.courses) < String(b.mapping.courses) ? -1 : 1));
    const sys = frags.map((f) => f.content).join("\n\n");
    console.log(`\nassembled courses system (${sys.length}c) — fragments: ${frags.map((f) => `${f.name}[${f.mapping.courses}]`).join(", ")}`);
    for (const l of sys.match(/Output ONLY pipe-delimited rows[^\n]*/g) || []) {
      console.log(`  ${/UNLESS/.test(l) ? "[permissive]" : "[ABSOLUTE] "} ${l.slice(0, 90)}`);
    }
    console.log(`  override present: ${sys.includes("ONE EXTRA COLUMN")}`);
  }
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
