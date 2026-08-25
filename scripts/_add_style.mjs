// One-shot: put output STYLE into the DB.
//  1) model_config `_styles` doc  → the style→temperature map (dashboard-editable; code is fallback).
//  2) plan_library step defs       → add `style: "structured"` where absent (the per-step selector).
// Backs up BOTH collections to .backups/ first. Usage (NODE_ENV=dev): node scripts/_add_style.mjs [--apply]
import { MongoClient } from "mongodb";
import { writeFileSync } from "fs";
import dotenvFlow from "dotenv-flow";
dotenvFlow.config();

const { MONGO_URI, MONGO_DB = "yeschef" } = process.env;
const APPLY = process.argv.includes("--apply");
const STAMP = "pre-style-20260615";
const STYLE_TEMPS = { structured: 0.1, blended: 0.35, unstructured: 0.7 };

const client = new MongoClient(MONGO_URI);
await client.connect();
const db = client.db(MONGO_DB);
const modelCfg = db.collection("model_config");
const plans = db.collection("plan_library");

// --- preview ---
const existingStyles = await modelCfg.findOne({ _id: "_styles" });
const planDocs = await plans.find({}).toArray();
const missingStyle = planDocs.filter((d) => d.style == null);
console.log(`model_config _styles: ${existingStyles ? "EXISTS — will overwrite" : "absent — will insert"} → ${JSON.stringify(STYLE_TEMPS)}`);
console.log(`plan_library: ${planDocs.length} step(s), ${missingStyle.length} missing style → set "structured"`);
for (const d of missingStyle) console.log(`  + ${d._id}  ${d.name ?? d.subtype ?? ""}`);

if (!APPLY) { console.log("\n(dry run — pass --apply)"); await client.close(); process.exit(0); }

// --- backups ---
writeFileSync(`.backups/model_config.backup.${STAMP}.json`, JSON.stringify(await modelCfg.find({}).toArray(), null, 2));
writeFileSync(`.backups/plan_library.backup.${STAMP}.json`, JSON.stringify(planDocs, null, 2));
console.log(`\nbacked up model_config + plan_library → .backups/*.${STAMP}.json`);

// --- writes ---
const now = new Date();
await modelCfg.updateOne({ _id: "_styles" }, { $set: { params: STYLE_TEMPS, updatedAt: now } }, { upsert: true });
const res = await plans.updateMany({ style: { $exists: false } }, { $set: { style: "structured", updatedAt: now } });
console.log(`_styles upserted; plan_library style set on ${res.modifiedCount} step(s)`);
await client.close();
process.exit(0);
