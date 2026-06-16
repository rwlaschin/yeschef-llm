// One-off: remove the bundled "OUTPUT DISCIPLINE" (no-commentary) bullet from the shared segment
// 6a2ce7b4 — keep ONLY the STRICT SCHEMA rule there. No-commentary already lives elsewhere
// (menu_plan 6a28a5c5, compliance block); don't double-frost it. Dry-run default; --apply to write.
// Usage: NODE_ENV=dev node scripts/_prompt_dropcommentary.mjs [--apply]
import { MongoClient, ObjectId } from "mongodb";
import dotenvFlow from "dotenv-flow";
dotenvFlow.config();

const APPLY = process.argv.includes("--apply");
const { MONGO_URI, MONGO_DB = "yeschef" } = process.env;
const COLL = process.env.PROMPT_COLLECTION || "prompt_library";
const ID = new ObjectId("6a2ce7b4a816493790ff1c02");

const client = new MongoClient(MONGO_URI);
await client.connect();
const coll = client.db(MONGO_DB).collection(COLL);
const doc = await coll.findOne({ _id: ID });
if (!doc) { console.error("segment not found"); process.exit(1); }

// Drop the whole OUTPUT DISCIPLINE bullet line (and its leading newline).
const next = (doc.content || "").replace(/\n\* OUTPUT DISCIPLINE:[^\n]*/g, "");
if (next === doc.content) { console.log("OUTPUT DISCIPLINE bullet not found — nothing to do."); }
else {
  console.log(`${APPLY ? "APPLIED" : "WOULD REMOVE"} the OUTPUT DISCIPLINE bullet from ${ID}.`);
  if (APPLY) await coll.updateOne({ _id: ID }, { $set: { content: next } });
}
await client.close();
process.exit(0);
