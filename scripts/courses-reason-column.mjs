// Courses: replace the trailing `Why:` block with a Reason COLUMN.
//
// The Why block is written AFTER the table, so the model has to go back and summarise decisions it
// already made — and its 76% of the response by line count is prose the row parser has to survive.
// A Reason cell is written in the same left-to-right pass as the row it explains.
//
// COURSES ONLY, on purpose: `recipes`, `protein_grid`, `nutrients` and `recipe_detail` keep the old
// `Why:` block. The column is named `Reason`, not `Why`, so if the word shows up in one of those
// steps' output we know a rule bled across subtypes.
//
// Two fragments, not one: MECHANISM (how to emit the column) is reusable by any table step;
// CONTENT (what belongs in the cell) is per-step. Order keys put them where the Why block was —
// "f" < "f1" < "m" (the status contract), and systemPromptFor sorts mapping values as plain strings.
//
// BACKS UP plan_library + prompt_library to scripts/backups/ before writing.
//   node scripts/courses-reason-column.mjs           # dry run
//   node scripts/courses-reason-column.mjs --commit
import fs from "fs";
import path from "path";
import dotenvFlow from "dotenv-flow";
import { MongoClient } from "mongodb";

dotenvFlow.config({ node_env: "dev" });
const COMMIT = process.argv.includes("--commit");

const OLD_HEADER = "Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit | Kind | Diets | Components";
const NEW_HEADER = `${OLD_HEADER} | Reason`;

const MECHANISM = {
  name: "Reason column mechanism",
  mapping: { courses: "f" },
  active: true,
  content: [
    "* Your table carries ONE EXTRA COLUMN, named `Reason`, and it is the LAST column.",
    "* The header line you write ends with ` | Reason`. Write the header exactly as:",
    `    ${NEW_HEADER}`,
    "* EVERY row therefore ends with a Reason cell. A row that stops after Components is missing a column.",
    "* Write the Reason cell in the same left-to-right pass as the rest of its row, at the moment you write that row. Never finish the table and then go back to add reasons.",
    "* NO PIPE CHARACTERS inside a Reason cell — a `|` there opens another column and corrupts the row. Write \"and\" or a comma instead.",
    "* Do NOT write a `Why:` line or a Why block. The Reason column replaces it completely.",
    "* Write NO prose before the table and NO prose after it. The table is the whole deliverable; only the status block follows it.",
    "* A row whose Reason cell is empty is an incomplete row.",
  ].join("\n"),
};

const CONTENT = {
  name: "Courses reason content",
  mapping: { courses: "f1" },
  active: true,
  content: [
    "* The Reason cell explains why THIS dish is on THIS row — everything that decided it, in one short phrase per factor, separated by semicolons.",
    "* Say how it goes with the entrée it accompanies: the flavour, texture or temperature contrast that makes the pair work, or the cuisine it belongs to.",
    "* Say which rule forced or forbade it where one did: a diet restriction, a nutrient limit, an allergen, the cost tier, or regional and seasonal availability.",
    "* Where you passed over the obvious choice, name it and say what excluded it.",
    "* Name the course position it fills when that is what decided it — a starch beside a protein entrée, a fruit where the meal has no dessert.",
    "* Concrete over generic: \"acid cuts the braise's fat\" beats \"complements the entrée\". Never write \"meets requirements\" or \"suitable\" on its own.",
  ].join("\n"),
};

const uri = process.env.MONGO_URI;
const dbName = process.env.MONGO_DB || "yeschef";
if (!uri) { console.error("MONGO_URI unset — check .env.dev"); process.exit(1); }

const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);
  const planLib = await db.collection("plan_library").find({}).toArray();
  const promptLib = await db.collection("prompt_library").find({}).toArray();

  const courses = planLib.find((d) => d.name === "Build Courses");
  const rationale = promptLib.find((d) => d.name === "Decision rationale clause");
  if (!courses) throw new Error("no plan_library row named 'Build Courses'");
  if (!rationale) throw new Error("no prompt_library doc named 'Decision rationale clause'");

  // 1. Build Courses: every occurrence of the header gains ` | Reason` (it appears in instruction
  //    AND in the pass/fail text, and tableRows compares the whole set).
  const patched = {};
  for (const f of ["instruction", "pass", "fail"]) {
    const before = String(courses[f] || "");
    const after = before.split(OLD_HEADER).join(NEW_HEADER);
    patched[f] = { before, after, hits: before.split(OLD_HEADER).length - 1 };
  }
  // 2. pass/fail also assert the cell count and the Reason cell itself.
  patched.pass.after += " Every row has 11 cells, the last being a non-empty Reason. No `Why:` line appears anywhere.";
  patched.fail.after += " Also fail: any row with fewer than 11 cells, any empty Reason cell, a `|` inside a Reason cell, or a `Why:` line.";

  // 3. Decision rationale clause stops applying to courses; the other four steps keep it.
  const newMapping = { ...(rationale.mapping || {}) };
  delete newMapping.courses;

  console.log(JSON.stringify({
    db: dbName,
    headerHits: { instruction: patched.instruction.hits, pass: patched.pass.hits, fail: patched.fail.hits },
    rationaleMappingBefore: rationale.mapping,
    rationaleMappingAfter: newMapping,
    inserting: [MECHANISM.name, CONTENT.name],
    coursesFragmentOrderAfter: ["a Courses system", "f " + MECHANISM.name, "f1 " + CONTENT.name, "m status contract"],
  }, null, 2));

  if (!patched.instruction.hits) throw new Error("header string not found in Build Courses.instruction — aborting rather than writing a half-change");

  if (!COMMIT) { console.log("\nDRY RUN — nothing written. Re-run with --commit."); }
  else {
    const dir = path.join(process.cwd(), "scripts", "backups");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path.join(dir, `courses-reason-column-backup-${stamp}.json`);
    fs.writeFileSync(backup, JSON.stringify({ plan_library: planLib, prompt_library: promptLib }, null, 2));
    console.log(`backed up plan_library(${planLib.length}) + prompt_library(${promptLib.length}) → ${backup}`);

    const r1 = await db.collection("plan_library").updateOne({ _id: courses._id }, {
      $set: { instruction: patched.instruction.after, pass: patched.pass.after, fail: patched.fail.after, updatedAt: new Date() },
    });
    console.log(`Build Courses: matched=${r1.matchedCount} modified=${r1.modifiedCount}`);

    for (const doc of [MECHANISM, CONTENT]) {
      const r = await db.collection("prompt_library").updateOne({ name: doc.name }, { $set: { ...doc, updatedAt: new Date() } }, { upsert: true });
      console.log(`${doc.name}: ${r.upsertedCount ? "inserted" : "updated"}`);
    }

    const r2 = await db.collection("prompt_library").updateOne({ _id: rationale._id }, { $set: { mapping: newMapping, updatedAt: new Date() } });
    console.log(`Decision rationale clause: matched=${r2.matchedCount} modified=${r2.modifiedCount}`);

    // Re-read and show what a courses run will now assemble.
    const after = await db.collection("prompt_library").find({}).toArray();
    const frags = after.filter((p) => p.mapping && p.mapping.courses != null)
      .sort((a, b) => (String(a.mapping.courses) < String(b.mapping.courses) ? -1 : 1));
    console.log("\ncourses fragments, in assembly order:");
    frags.forEach((f) => console.log(`  ${String(f.mapping.courses).padEnd(3)} ${f.name || f._id}`));
    const c2 = await db.collection("plan_library").findOne({ _id: courses._id });
    console.log("\nheader in instruction now:", c2.instruction.includes(NEW_HEADER) ? "HAS | Reason" : "MISSING");
    const others = await db.collection("plan_library").find({}).toArray();
    const drift = others.filter((d) => String(d._id) !== String(courses._id))
      .filter((d) => JSON.stringify(d) !== JSON.stringify(planLib.find((p) => String(p._id) === String(d._id))));
    console.log("other plan_library rows changed:", drift.length, drift.map((d) => d.name));
  }
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
