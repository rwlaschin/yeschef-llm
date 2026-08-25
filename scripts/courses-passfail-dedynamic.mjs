// Build Courses pass/fail: stop naming user-configurable course positions, and fix the cell-count
// clause I wrote one-sided.
//
// Course positions (entree, appetizer, side, soup, salad, starch, vegetable, dessert, beverage) are
// USER DATA — the chef picks which positions a meal offers and how many dishes each holds
// (courseCounts / COURSES in the frontend's planOptions). Naming them in pass/fail freezes one
// customer's configuration into a rule that is supposed to hold for every customer. The criteria now
// refer to "the positions this meal offers" and "the position the previous step already wrote",
// which stay true whatever the chef configured.
//
// Also fixed: "fewer than 11 cells" only caught short rows — a stray `|` inside a Reason cell makes
// a 12-cell row, which that clause passed. Now "not exactly 11". And the duplicated restatements of
// the mechanism clause (empty Reason, `|` inside Reason) are dropped from `fail` — the mechanism
// fragment owns those; criteria that repeat mechanism drift out of sync with it.
//
//   node scripts/courses-passfail-dedynamic.mjs           # dry run
//   node scripts/courses-passfail-dedynamic.mjs --commit
import fs from "fs";
import path from "path";
import dotenvFlow from "dotenv-flow";
import { MongoClient } from "mongodb";

dotenvFlow.config({ node_env: "dev" });
const COMMIT = process.argv.includes("--commit");

const HEADER = "Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit | Kind | Diets | Components | Reason";

const PASS = [
  "Every course position this meal offers is filled by at least one row, except the position the previous step already wrote.",
  "No row takes the position the previous step already wrote, and no row repeats a dish it already wrote.",
  "Every row's Kind is one of the course positions this meal offers.",
  "Every row's Components names only ingredients cooked into that dish, each tagged with a category.",
  `Every row is in the \`${HEADER}\` format, has exactly 11 cells, and its Reason cell is not empty.`,
  "The response is the table and nothing else.",
].join(" ");

const FAIL = [
  "Any of:",
  "a row that takes the position the previous step already wrote;",
  "a row repeating a dish the previous step already wrote;",
  "a Kind that is not one of the course positions this meal offers;",
  "a course position this meal offers left with no row;",
  "a row written for a position this meal does not offer;",
  "an empty or uncategorized Components cell;",
  "a `name:category` pair written into the Protein, Starch, Vegetable or Fruit column;",
  "Components naming another course rather than this dish's own ingredients;",
  "a row whose cell count is not exactly 11;",
  "an empty Reason cell;",
  "any text that is not part of the table.",
].join(" ");

const uri = process.env.MONGO_URI;
const dbName = process.env.MONGO_DB || "yeschef";
if (!uri) { console.error("MONGO_URI unset — check .env.dev"); process.exit(1); }

const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);
  const planLib = await db.collection("plan_library").find({}).toArray();
  const courses = planLib.find((d) => d.name === "Build Courses");
  if (!courses) throw new Error("no plan_library row named 'Build Courses'");

  // The check that matters: no user-configurable position name survives in the criteria.
  const POSITIONS = ["entree", "entrée", "appetizer", "side", "soup", "salad", "starch", "vegetable", "dessert", "beverage", "beverage"];
  const naming = (s) => POSITIONS.filter((p) => new RegExp(`\\b${p}\\b`, "i").test(s));

  console.log(JSON.stringify({
    passBefore: { len: courses.pass.length, namesPositions: naming(courses.pass) },
    passAfter: { len: PASS.length, namesPositions: naming(PASS) },
    failBefore: { len: courses.fail.length, namesPositions: naming(courses.fail) },
    failAfter: { len: FAIL.length, namesPositions: naming(FAIL) },
  }, null, 2));
  console.log("\n=== NEW PASS ===\n" + PASS + "\n\n=== NEW FAIL ===\n" + FAIL);

  if (!COMMIT) { console.log("\nDRY RUN — nothing written. Re-run with --commit."); }
  else {
    const dir = path.join(process.cwd(), ".backups");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path.join(dir, `courses-passfail-backup-${stamp}.json`);
    fs.writeFileSync(backup, JSON.stringify({ plan_library: planLib }, null, 2));
    console.log(`backed up plan_library(${planLib.length}) → ${backup}`);

    const r = await db.collection("plan_library").updateOne({ _id: courses._id }, { $set: { pass: PASS, fail: FAIL, updatedAt: new Date() } });
    console.log(`Build Courses: matched=${r.matchedCount} modified=${r.modifiedCount}`);
    const re = await db.collection("plan_library").findOne({ _id: courses._id });
    console.log("re-read pass namesPositions:", naming(re.pass));
    console.log("re-read fail namesPositions:", naming(re.fail));
    const others = await db.collection("plan_library").find({}).toArray();
    const drift = others.filter((d) => String(d._id) !== String(courses._id))
      .filter((d) => JSON.stringify(d) !== JSON.stringify(planLib.find((p) => String(p._id) === String(d._id))));
    console.log("other rows changed:", drift.length, drift.map((d) => d.name));
  }
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
