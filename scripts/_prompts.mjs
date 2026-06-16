// Throwaway: dump prompt_library so we can review/tune prompts. Usage (NODE_ENV=dev):
//   node scripts/_prompts.mjs            # list all (id, topics, active, length)
//   node scripts/_prompts.mjs <substr>   # full content of prompts whose topic/name matches
import { MongoClient } from "mongodb";
import dotenvFlow from "dotenv-flow";
dotenvFlow.config();

const { MONGO_URI, MONGO_DB = "yeschef" } = process.env;
const COLL = process.env.PROMPT_COLLECTION || "prompt_library";
const needle = (process.argv[2] || "").toLowerCase();

const client = new MongoClient(MONGO_URI);
await client.connect();
const docs = await client.db(MONGO_DB).collection(COLL).find({ isDeleted: { $ne: true } }).toArray();
console.log(`${docs.length} prompt(s) in ${MONGO_DB}.${COLL}\n`);

for (const d of docs) {
  const topics = d.mapping ? Object.keys(d.mapping).join(",") : (d.topic ?? "?");
  const name = d.name ?? d.title ?? d._id;
  const hay = `${name} ${topics}`.toLowerCase();
  if (needle && !hay.includes(needle)) continue;
  console.log(`── ${name}  [topics: ${topics}]  active=${d.active}  len=${(d.content||"").length}`);
  if (needle) console.log((d.content || "(empty)") + "\n");
}
await client.close();
process.exit(0);
