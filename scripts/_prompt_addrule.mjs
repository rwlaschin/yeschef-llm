// One-off: append the STRICT SCHEMA + OUTPUT DISCIPLINE bullets to the all-subtypes shared
// output-discipline segment (6a2ce7b4), so every strict-output subtype gets them. Idempotent:
// skips if already present. Dry-run by default; pass --apply to write.
// Usage: NODE_ENV=dev node scripts/_prompt_addrule.mjs [--apply]
import { MongoClient, ObjectId } from "mongodb";
import dotenvFlow from "dotenv-flow";
dotenvFlow.config();

const APPLY = process.argv.includes("--apply");
const { MONGO_URI, MONGO_DB = "yeschef" } = process.env;
const COLL = process.env.PROMPT_COLLECTION || "prompt_library";
const ID = new ObjectId("6a2ce7b4a816493790ff1c02");

const RULES =
  "\n* STRICT SCHEMA: emit ONLY the fields defined in this step's output template, and nothing else. Do NOT add keys, attributes, per-item flags, or annotations the template does not list, and do NOT invent or rename fields. If the template gives no place for a detail, leave it out." +
  "\n* OUTPUT DISCIPLINE: output ONLY the deliverable — no preamble, no commentary, no explanation of your reasoning, no markdown code fences. Match the template's structure exactly.";

const client = new MongoClient(MONGO_URI);
await client.connect();
const coll = client.db(MONGO_DB).collection(COLL);
const doc = await coll.findOne({ _id: ID });
if (!doc) { console.error(`segment ${ID} not found`); process.exit(1); }

if ((doc.content || "").includes("STRICT SCHEMA:")) {
  console.log("already present — nothing to do.");
} else {
  const next = (doc.content || "").replace(/\s*$/, "") + "\n" + RULES.trimStart();
  console.log(`${APPLY ? "APPLIED" : "WOULD APPEND"} to ${ID}:\n${RULES}`);
  if (APPLY) await coll.updateOne({ _id: ID }, { $set: { content: next } });
}
await client.close();
process.exit(0);
