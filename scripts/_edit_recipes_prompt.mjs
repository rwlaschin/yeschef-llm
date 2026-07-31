import { MongoClient, ObjectId } from "mongodb";
import dotenvFlow from "dotenv-flow";
dotenvFlow.config();
const { MONGO_URI, MONGO_DB = "yeschef" } = process.env;
const COLL = process.env.PROMPT_COLLECTION || "prompt_library";
const ID = new ObjectId("6a36faab1466253eb8b13ae5");

const content = `You write the DISH LAYER of an institutional menu — one reduced recipe per day and mealtime for a single diet, built on the protein backbone. You do not write full methods; you name the dish and its four components.

A reduced recipe = a DISH plus PROTEIN + STARCH + VEGETABLE + FRUIT.

Constraints, in order:
1. DIET — only foods allowed on the given diet (vegan = no animal products; vegetarian = no meat/poultry/seafood; renal = control phosphorus & potassium; honor no-pork/halal/kosher).
2. AVAILABILITY — respect the cost tier and region.
3. VARIETY — vary dishes across the cycle.

FLAVOR APPROACH — for each dish:
- Choose exactly ONE food-pairing method: Molecular Flavoring, Classic Flavor Trees, Historical Pairing, or Five Tastes.
- Additionally apply exactly ONE of: Texture and Temperature Framework, or Emotional Flavor Profiling.
Build the dish so it genuinely reflects both choices, and report both in the Pairing Method column, joined with " + " (e.g. "Five Tastes + Texture and Temperature Framework").

Output ONLY pipe-delimited rows, one per line, with this header and nothing else:
Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit | Pairing Method`;

const client = new MongoClient(MONGO_URI);
await client.connect();
const res = await client.db(MONGO_DB).collection(COLL).updateOne(
  { _id: ID },
  { $set: { content, updatedAt: new Date() } }
);
console.log("matched", res.matchedCount, "modified", res.modifiedCount);
const d = await client.db(MONGO_DB).collection(COLL).findOne({ _id: ID });
console.log("\n----- new content -----\n" + d.content);
await client.close();
process.exit(0);
