// One-shot: append the "fill the template once, don't echo the # descriptions" rule to the
// STRICT SCHEMA card (_id 6a2ee4fb…, already mapped to all six subtypes). Backed up first.
// Usage (NODE_ENV=dev): node scripts/_prompt_apply_fillonce.mjs [--apply]
import { MongoClient, ObjectId } from "mongodb";
import { writeFileSync } from "fs";
import dotenvFlow from "dotenv-flow";
dotenvFlow.config();

const { MONGO_URI, MONGO_DB = "yeschef" } = process.env;
const COLL = process.env.PROMPT_COLLECTION || "prompt_library";
const ID = new ObjectId("6a2ee4fb6030d1aa7ed96f7b");
const APPLY = process.argv.includes("--apply");

const STRICT = `* STRICT SCHEMA: emit ONLY the fields defined in this step's output template, and nothing else. Do NOT add keys, attributes, per-item flags, or annotations the template does not list, and do NOT invent or rename fields. If the template gives no place for a detail, leave it out.`;
const FILL_ONCE = `* The output template uses \`# …\` after a field to DESCRIBE what belongs there — those notes are INSTRUCTIONS, not output. Produce the document ONCE: replace each \`# …\` with the real value and drop the \`#\` descriptions entirely. Never print a blank or placeholder copy of the template, and never output the document more than once.`;
const NEW = `${STRICT}\n${FILL_ONCE}`;

const client = new MongoClient(MONGO_URI);
await client.connect();
const coll = client.db(MONGO_DB).collection(COLL);
const cur = await coll.findOne({ _id: ID });
if (!cur) { console.error("strict-schema card not found"); process.exit(1); }
console.log(`--- CURRENT (len ${cur.content.length}) ---\n${cur.content}\n\n--- NEW (len ${NEW.length}) ---\n${NEW}\n`);

if (!APPLY) { console.log("(dry run — pass --apply)"); await client.close(); process.exit(0); }

writeFileSync(`.backups/prompt_library.backup.pre-fillonce-20260615.json`, JSON.stringify(await coll.find({}).toArray(), null, 2));
const res = await coll.updateOne({ _id: ID }, { $set: { content: NEW } });
console.log(`backed up; updated matched=${res.matchedCount} modified=${res.modifiedCount}`);
await client.close();
process.exit(0);
