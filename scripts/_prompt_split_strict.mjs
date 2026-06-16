// One-off: SPLIT the STRICT SCHEMA rule into its own standalone segment, mapped to every strict-
// output subtype, and REMOVE it from 6a2ce7b4 (which goes back to tool-call discipline only).
// Order keys place the new segment right after 6a2ce7b4 in each topic's assembly.
// Dry-run default; pass --apply to write. Usage: NODE_ENV=dev node scripts/_prompt_split_strict.mjs [--apply]
import { MongoClient, ObjectId } from "mongodb";
import dotenvFlow from "dotenv-flow";
dotenvFlow.config();

const APPLY = process.argv.includes("--apply");
const { MONGO_URI, MONGO_DB = "yeschef" } = process.env;
const COLL = process.env.PROMPT_COLLECTION || "prompt_library";
const HOST_ID = new ObjectId("6a2ce7b4a816493790ff1c02"); // currently holds the appended STRICT SCHEMA bullet

const STRICT_BULLET =
  "* STRICT SCHEMA: emit ONLY the fields defined in this step's output template, and nothing else. Do NOT add keys, attributes, per-item flags, or annotations the template does not list, and do NOT invent or rename fields. If the template gives no place for a detail, leave it out.";

// Sits immediately after 6a2ce7b4 (keys r1/c1/F1/v1/y1/v1) and before the next segment, per topic.
const MAPPING = { compliance: "r2", menu_plan: "c2", recipe: "F2", nutrition: "v2", inventory: "y2", procurement: "v2" };

const client = new MongoClient(MONGO_URI);
await client.connect();
const coll = client.db(MONGO_DB).collection(COLL);

// 1) strip the STRICT SCHEMA bullet (and its leading newline) out of the host segment
const host = await coll.findOne({ _id: HOST_ID });
const hostNext = (host.content || "").replace(/\n\* STRICT SCHEMA:[^\n]*/g, "");
const hostChanged = hostNext !== host.content;

// 2) avoid duplicate standalone segment if re-run
const existing = await coll.findOne({ content: STRICT_BULLET });

console.log(`host 6a2ce7b4: ${hostChanged ? "WILL REMOVE STRICT SCHEMA bullet" : "no STRICT SCHEMA bullet found"}`);
console.log(`new segment:  ${existing ? "already exists ("+String(existing._id)+") — skip" : "WILL CREATE  mapping="+JSON.stringify(MAPPING)}`);

if (APPLY) {
  if (hostChanged) await coll.updateOne({ _id: HOST_ID }, { $set: { content: hostNext } });
  if (!existing) {
    const now = new Date();
    const res = await coll.insertOne({
      mapping: MAPPING, active: true, content: STRICT_BULLET,
      modelOverride: null, isDeleted: false, createdAt: now, updatedAt: now,
    });
    console.log(`created segment ${res.insertedId}`);
  }
}
await client.close();
process.exit(0);
