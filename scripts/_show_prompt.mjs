import { MongoClient, ObjectId } from "mongodb";
import dotenvFlow from "dotenv-flow";
dotenvFlow.config();
const { MONGO_URI, MONGO_DB = "yeschef" } = process.env;
const COLL = process.env.PROMPT_COLLECTION || "prompt_library";
const client = new MongoClient(MONGO_URI);
await client.connect();
const ids = process.argv.slice(2);
for (const id of ids) {
  const d = await client.db(MONGO_DB).collection(COLL).findOne({ _id: new ObjectId(id) });
  console.log(`\n===== _id=${id} name=${d?.name} keys=[${d?.mapping?Object.keys(d.mapping):''}] =====\n`);
  console.log(d?.content || "(empty)");
}
await client.close();
process.exit(0);
