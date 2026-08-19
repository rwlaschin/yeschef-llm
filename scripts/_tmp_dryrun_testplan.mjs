// DRY RUN ONLY — no writes. Simulates composeMenuPlan (functions/entry/ai/menu.js) against the
// LIVE plan_library plus the candidate TEST row held in memory, so the wiring can be checked
// before anything is written.
import { MongoClient } from "mongodb";
import dotenvFlow from "dotenv-flow";
import { composeFromDefs, pruneOrphans } from "../functions/entry/ai/compose.js";
import { MENU_ENTRIES } from "../functions/entry/ai/menu-plan.js";
import { buildTestRecipesRow, TEST_FORM } from "./_tmp_testrow.mjs";

dotenvFlow.config({ node_env: "dev" });
const c = new MongoClient(process.env.MONGO_URI);
await c.connect();
const col = c.db(process.env.MONGO_DB || "yeschef").collection("plan_library");
const live = await col.find({ active: true }).toArray();
const prodRecipes = await col.findOne({ name: "Build Recipes" });
await c.close();

const testRow = buildTestRecipesRow(prodRecipes);

const fromDb = [...live, testRow].sort((a, b) => {
  const x = String(a.order ?? ""), y = String(b.order ?? "");
  return x < y ? -1 : x > y ? 1 : 0;
});

// ── verbatim from menu.js composeMenuPlan ──
const { enabled, flags, values } = TEST_FORM;
const toggleKeyForSubtype = Object.fromEntries(
  MENU_ENTRIES.filter((e) => e.group === "body").map((e) => [e.subtype, e.key])
);
const dropReason = (def) => {
  const toggleKey = toggleKeyForSubtype[def.subtype];
  if (toggleKey && enabled[toggleKey] === false) return `'${toggleKey}' toggled off`;
  const missingFlag = (def.requiredFlags || []).find((f) => !flags[f]);
  if (missingFlag) return `required flag '${missingFlag}' not set`;
  const disabledInput = (def.inputs || []).find((inp) => enabled[inp] === false);
  if (disabledInput) return `input '${disabledInput}' disabled`;
  return null;
};

console.log("── FILTER ──");
const defs = [];
for (const def of fromDb) {
  const r = dropReason(def);
  console.log(`  ${r ? "x drop" : "+ keep"}  ${def.name}${r ? ` — ${r}` : ""}`);
  if (!r) defs.push(def);
}
const { defs: kept, removed } = pruneOrphans(defs);
for (const r of removed) console.log(`  x drop  ${r.name} — orphan, needs [${r.context.join(", ")}]`);

const plan = composeFromDefs(kept, TEST_FORM, { isProd: false });
console.log("\n── BUILT PLAN ──");
plan.forEach((s, i) => console.log(
  `  #${i} ${s.subtype}/${s.kind} model=${s.model} units=${Array.isArray(s.items) ? s.items.length : 1}` +
  ` contexts=[${(s.contexts || []).join(",")}]${s.error ? `  ERROR: ${s.error}` : ""}`
));
console.log(`\nTOTAL LLM CALLS: ${plan.reduce((n, s) => n + (Array.isArray(s.items) ? s.items.length : 1), 0)}`);
console.log("\n── step 1 (TEST recipes) unit 0 instructions ──\n");
console.log(plan[1]?.instructions);
