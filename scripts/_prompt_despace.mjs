// One-off: rename snake_case OUTPUT-TEMPLATE schema keys to spaced keys in prompt_library, so the
// model stops mistaking snake_case YAML for tool-call params. Exact-token replace only — never
// touches web_search/web_fetch (real tools), menu_plan (subtype), prompt_library, or model ids.
// Dry-run by default; pass --apply to write. Usage: NODE_ENV=dev node scripts/_prompt_despace.mjs [--apply]
import { MongoClient } from "mongodb";
import dotenvFlow from "dotenv-flow";
dotenvFlow.config();

const APPLY = process.argv.includes("--apply");
const { MONGO_URI, MONGO_DB = "yeschef" } = process.env;
const COLL = process.env.PROMPT_COLLECTION || "prompt_library";

// Every snake_case schema key the model emits/reads in an output template. KEEP-list (web_search,
// web_fetch, menu_plan, prompt_library, *_v1 model ids) is intentionally excluded.
const KEYS = [
  "institution_type", "generated_for", "estimated_volume", "used_in", "portion_quantity",
  "order_form", "ingredient_list", "diet_type", "cycle_length", "critical_temp", "yield_portions",
  "vendor_url", "vendor_contact", "total_residents", "storage_requirements", "prep_note",
  "portion_weight", "pans_per_batch", "pan_size", "order_information", "menu_items", "meal_plan",
  "max_hold_time", "hot_hold_temp", "elevation_notes", "dry_storage", "dietary_groups",
  "diet_tags", "derived_from", "cold_hold_temp",
];
const spaced = (k) => k.replace(/_/g, " ");
// Exact-token boundaries: not preceded/followed by a word char (so menu_items ≠ menu_plan, and
// 8b_v1 / web_search are never partially matched since they aren't in KEYS at all).
const RE = new RegExp(`(?<![\\w])(${KEYS.join("|")})(?![\\w])`, "g");

const client = new MongoClient(MONGO_URI);
await client.connect();
const docs = await client.db(MONGO_DB).collection(COLL).find({}).toArray();

let changedDocs = 0, totalHits = 0;
for (const d of docs) {
  const content = d.content || "";
  const hits = {};
  const next = content.replace(RE, (m) => { hits[m] = (hits[m] || 0) + 1; return spaced(m); });
  if (next === content) continue;
  changedDocs++;
  const topics = d.mapping ? Object.keys(d.mapping).join(",") : (d.topic ?? "?");
  const summary = Object.entries(hits).map(([k, n]) => `${k}→"${spaced(k)}"×${n}`).join(", ");
  totalHits += Object.values(hits).reduce((a, b) => a + b, 0);
  console.log(`${APPLY ? "APPLIED" : "WOULD CHANGE"} ${d._id} [${topics}]: ${summary}`);
  if (APPLY) {
    await client.db(MONGO_DB).collection(COLL).updateOne({ _id: d._id }, { $set: { content: next } });
  }
}
console.log(`\n${APPLY ? "applied to" : "would change"} ${changedDocs} doc(s), ${totalHits} key occurrence(s).`);
await client.close();
process.exit(0);
