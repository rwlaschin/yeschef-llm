// Throwaway: back up prompt_library to a timestamped JSON, then dump every doc's _id + content.
// Usage (NODE_ENV=dev): node scripts/_prompt_backup.mjs
import { MongoClient } from "mongodb";
import { writeFileSync } from "fs";
import dotenvFlow from "dotenv-flow";
dotenvFlow.config();

const { MONGO_URI, MONGO_DB = "yeschef" } = process.env;
const COLL = process.env.PROMPT_COLLECTION || "prompt_library";

const client = new MongoClient(MONGO_URI);
await client.connect();
const docs = await client.db(MONGO_DB).collection(COLL).find({}).toArray();

const stamp = process.argv[2] || "manual";
const file = `prompt_library.backup.${stamp}.json`;
writeFileSync(file, JSON.stringify(docs, null, 2));
console.log(`backed up ${docs.length} doc(s) → ${file}\n`);

for (const d of docs) {
  const topics = d.mapping ? Object.keys(d.mapping).join(",") : (d.topic ?? "?");
  console.log(`\n========== ${d._id}  [${topics}]  active=${d.active}  len=${(d.content||"").length} ==========`);
  console.log(d.content || "(empty)");
}
await client.close();
process.exit(0);
