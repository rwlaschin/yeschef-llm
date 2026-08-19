import { MongoClient } from "mongodb";
import dotenvFlow from "dotenv-flow";
dotenvFlow.config({ node_env: "dev" });
const c = new MongoClient(process.env.MONGO_URI);
await c.connect();
const col = c.db(process.env.MONGO_DB || "yeschef").collection("plan_library");
for (const n of ["Build Protein Grid","Build Recipes","Categorize Proteins By Diet"]) {
  const r = await col.findOne({ name: n });
  console.log("=".repeat(80)); console.log("NAME:", n);
  console.log(JSON.stringify(r, null, 2));
}
await c.close();
