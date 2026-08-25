// Wires the proteins grid into the recipes step.
//
// `Build Recipes` had context: [] — so the protein grid built by the step immediately before it
// (`Build Protein Grid`, lex order A vs B) was never handed in, and the recipes prompt rendered its
// pool from an empty list. Every unit then invented proteins or failed.
//
// BACKS UP plan_library + prompt_library to .backups/ before writing, same as
// scripts/seed-protein-grid.mjs. Prints the exact before/after of every field it touches.
//
//   node scripts/wire-recipes-proteins.mjs           # dry run, writes nothing
//   node scripts/wire-recipes-proteins.mjs --commit  # back up, then write
import fs from "fs";
import path from "path";
import dotenvFlow from "dotenv-flow";
import { MongoClient } from "mongodb";

dotenvFlow.config({ node_env: "dev" });

const COMMIT = process.argv.includes("--commit");
const TARGET = "Build Recipes";
const SOURCE = "Build Protein Grid";

const uri = process.env.MONGO_URI;
const dbName = process.env.MONGO_DB || "yeschef";
if (!uri) { console.error("MONGO_URI unset — check .env.dev"); process.exit(1); }

const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);
  const planLib = await db.collection("plan_library").find({}).toArray();

  const target = planLib.find((d) => d.name === TARGET);
  const source = planLib.find((d) => d.name === SOURCE);
  if (!target) throw new Error(`no plan_library row named ${JSON.stringify(TARGET)}`);
  if (!source) throw new Error(`no plan_library row named ${JSON.stringify(SOURCE)}`);

  // context is resolved BY NAME to an index, and only to steps EARLIER in lex `order`
  // (compose.js:433 — `idx != null && idx < stepIndex`). A later source silently resolves to nothing.
  const so = String(source.order ?? ""), to = String(target.order ?? "");
  if (!(so < to)) throw new Error(`${SOURCE} order ${JSON.stringify(so)} does not sort before ${TARGET} order ${JSON.stringify(to)} — context would resolve to nothing`);

  const before = Array.isArray(target.context) ? target.context : [];
  const after = before.includes(SOURCE) ? before : [...before, SOURCE];

  console.log(JSON.stringify({
    db: dbName, rows: planLib.length,
    source: { name: SOURCE, order: so, subtype: source.subtype, active: source.active },
    target: { name: TARGET, order: to, subtype: target.subtype, active: target.active },
    contextBefore: before, contextAfter: after,
    changed: JSON.stringify(before) !== JSON.stringify(after),
  }, null, 2));

  if (JSON.stringify(before) === JSON.stringify(after)) {
    console.log("already wired — nothing to do");
  } else if (!COMMIT) {
    console.log("DRY RUN — nothing written. Re-run with --commit to apply.");
  } else {
    const promptLib = await db.collection("prompt_library").find({}).toArray();
    const dir = path.join(process.cwd(), ".backups");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path.join(dir, `plan_library-${stamp}.json`);
    fs.writeFileSync(backup, JSON.stringify(planLib, null, 2));
    const full = path.join(dir, `wire-recipes-proteins-backup-${stamp}.json`);
    fs.writeFileSync(full, JSON.stringify({ plan_library: planLib, prompt_library: promptLib }, null, 2));
    console.log(`backed up plan_library(${planLib.length}) → ${backup}`);
    console.log(`backed up plan_library + prompt_library(${promptLib.length}) → ${full}`);

    const r = await db.collection("plan_library").updateOne({ _id: target._id }, { $set: { context: after, updatedAt: new Date() } });
    console.log(`updateOne matched=${r.matchedCount} modified=${r.modifiedCount}`);

    const reread = await db.collection("plan_library").findOne({ _id: target._id });
    console.log("re-read context:", JSON.stringify(reread.context));

    const others = await db.collection("plan_library").find({}).toArray();
    const untouched = others.filter((d) => String(d._id) !== String(target._id));
    const drift = untouched.filter((d) => {
      const was = planLib.find((p) => String(p._id) === String(d._id));
      return JSON.stringify(was) !== JSON.stringify(d);
    });
    console.log(`other rows: ${untouched.length}, changed: ${drift.length}`, drift.map((d) => d.name));
  }
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
