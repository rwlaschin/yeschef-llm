import { MongoClient } from "mongodb";
import dotenvFlow from "dotenv-flow";
dotenvFlow.config({ node_env: "dev" });
const c = new MongoClient(process.env.MONGO_URI);
await c.connect();
const rows = await c.db(process.env.MONGO_DB || "yeschef").collection("plan_library").find({}).toArray();
rows.sort((a,b)=>String(a.order??"")<String(b.order??"")?-1:1);
console.log("TOTAL ROWS:", rows.length);
for (const r of rows) {
  console.log(`_id=${r._id} order=${JSON.stringify(r.order)} active=${r.active} name=${JSON.stringify(r.name)} subtype=${r.subtype} kind=${r.kind} mapOf=${JSON.stringify(r.mapOf??"")} context=${JSON.stringify(r.context??[])} inputs=${JSON.stringify(r.inputs??[])} requiredFlags=${JSON.stringify(r.requiredFlags??[])} model=${r.model} modelProd=${r.modelProd??""} rowsOf=${JSON.stringify(r.rowsOf??"")} columns=${JSON.stringify(r.columns??"")}`);
}
await c.close();
