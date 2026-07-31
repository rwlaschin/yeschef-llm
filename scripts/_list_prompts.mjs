import { MongoClient } from "mongodb";
import dotenvFlow from "dotenv-flow";
dotenvFlow.config();
const { MONGO_URI, MONGO_DB = "yeschef" } = process.env;
const COLL = process.env.PROMPT_COLLECTION || "prompt_library";
const client = new MongoClient(MONGO_URI);
await client.connect();
const docs = await client.db(MONGO_DB).collection(COLL).find({}).toArray();
for (const d of docs) {
  const keys = d.mapping ? Object.keys(d.mapping) : [];
  console.log(`_id=${d._id} | active=${d.active} | keys=[${keys.join(", ")}] | topLevelKeys=[${Object.keys(d).join(",")}]`);
}
await client.close();
process.exit(0);
