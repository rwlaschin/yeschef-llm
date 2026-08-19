import { MongoClient } from "mongodb";
import dotenvFlow from "dotenv-flow";
dotenvFlow.config({ node_env: "dev" });
const c = new MongoClient(process.env.MONGO_URI);
await c.connect();
const db = c.db(process.env.MONGO_DB || "yeschef");
for (const n of ["Build Recipes","Build Courses","Build Nutrients"]) {
  const s = await db.collection("plan_library").findOne({name:n});
  console.log("=========== STEP", n);
  console.log("--- instruction:\n"+s.instruction);
  console.log("--- pass:\n"+s.pass);
  console.log("--- fail:\n"+s.fail);
}
for (const n of ["Recipes system","Courses system","Nutrients system","Decision rationale clause"]) {
  const p = await db.collection("prompt_library").findOne({name:n});
  console.log("=========== PROMPT", n);
  console.log(p.content);
}
await c.close();
