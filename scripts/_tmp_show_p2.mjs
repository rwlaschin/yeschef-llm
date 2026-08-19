import { MongoClient, ObjectId } from "mongodb";
import dotenvFlow from "dotenv-flow";
dotenvFlow.config({ node_env: "dev" });
const c = new MongoClient(process.env.MONGO_URI);
await c.connect();
const col = c.db(process.env.MONGO_DB || "yeschef").collection("prompt_library");
for (const id of ["6a763c2613403f653cfb4950","6a7cb50adff6312de742717e"]) {
  const r = await col.findOne({ _id: new ObjectId(id) });
  console.log("="*1, "=".repeat(70), r.name, JSON.stringify(r.mapping));
  console.log(r.content);
}
await c.close();
