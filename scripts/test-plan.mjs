// TEST PLAN — 1 meal, 2 days, 2 diets. The smallest build that still exercises the WHOLE chain:
//   Categorize Proteins By Diet → Build Protein Grid → Build Recipes → Build Courses → Build Recipe Details
//
// Why it is small: compose.js:281 fans `recipes`/`courses` over dietDays = diets × days. The plan
// Robert ran was 3 diets × 7 days = 21 units per step, which is why it crawled. 2 × 2 = 4.
// Runs on the REAL model (each plan_library row carries model=llama3_1_8b_v1) — `fake` is NEVER
// set here, so no canned fake_canned_v1 output.
//
//   node scripts/test-plan.mjs            # DEFAULT: offline compose check. Reads plan_library, writes NOTHING.
//   node scripts/test-plan.mjs --run      # create the plan + launch the build (needs the dev stack up)
//
// --run needs: the Next dev server (YC_BASE_URL, default http://localhost:3100) and the Firebase
// emulator hosting /ai (NEXT_PUBLIC_AI_BASE, default http://localhost:5101/...). It creates ONE
// meal_plan through the real API and POSTs ONE /ai/menu build. It never touches plan_library or
// prompt_library.
import fs from "fs";
import path from "path";
import dotenvFlow from "dotenv-flow";
import { MongoClient } from "mongodb";
import { composeFromDefs, pruneOrphans } from "../functions/entry/ai/compose.js";
import { MENU_ENTRIES } from "../functions/entry/ai/menu-plan.js";

dotenvFlow.config({ node_env: "dev" });

const RUN = process.argv.includes("--run");

// ── The test plan's shape ───────────────────────────────────────────────────────────────────────
const STAMP = new Date().toISOString().slice(0, 16).replace("T", " ");
const PLAN_NAME = `TEST · 1 meal · 2 days · 2 diets · ${STAMP}`;

// 1 meal (lunch), 2 diets. `days: 2` is the explicit day override compose.js:275 honours — weeks is
// carried too because the plan list renders durationWeeks.
const VALUES = { institution: "Senior Care", diets: "standard,diabetic", meals: "lunch", restrictions: "no nuts" };
const DURATION = { weeks: 1, days: 2, businessDaysOnly: false };
const RESIDENTS = 20;
const DIET_WEIGHTS = { standard: 50, diabetic: 15 };   // the catalog's own relative mix (menu-plan.js diets.weights)
// A count is 0 or 2–7 (schemas.js:53 — 1 is not expressible). Kept at the smallest real service,
// because `Build Recipe Details` fans over every ROW those two steps emit: 4 slots × 4 dishes = 16 units.
const COURSE_COUNTS = { appetizer: 2, entree: 2, side: 2 };
const COST_TIER = "standard";
const LOCATION = "America/Los_Angeles";                // an IANA zone → {{season}}/{{date}}/{{region}} resolve

// The 5 chain steps ON, everything else OFF. menu.js:137 only drops on === false, so a subtype that
// is not named here is KEPT — hence every other body toggle is listed explicitly. `recipe_detail` has
// no MENU_ENTRIES toggle key at all, so it can only be dropped by pruneOrphans.
// NOTE: do NOT add `preferences: false` — that is a data-INPUT key, and all three of protein_grid /
// recipes / courses list it in `inputs`, so disabling it drops them (menu.js:140).
const ENABLED = {
  protein_dietary_categorization: true, protein_grid: true, recipes: true, courses: true,
  nutrients: false, compliance: false, menu: false, recipe: false,
  nutrition: false, inventory: false, order_form: false,
};

// The UI resolves a plan step's job by matching menuPlans.stepId to the step TYPE string
// (lib/plans/selectPlanJob.ts), so ONE job can only surface on ONE step page. This build covers
// proteins→recipes in a single job; it is tagged `recipes` so the Recipe Book page picks it up.
const STEP_ID = "recipes";

const FORM = {
  values: VALUES, duration: DURATION, residents: RESIDENTS, flags: {}, enabled: ENABLED,
  dietWeights: DIET_WEIGHTS, courseCounts: COURSE_COUNTS, costTier: COST_TIER,
};

// ── Offline compose check — the same filter + prune + compose menu.js:104-161 runs ───────────────
async function composeCheck() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI unset — check .env.dev");
  const client = new MongoClient(uri);
  let fromDb;
  try {
    await client.connect();
    fromDb = (await client.db(process.env.MONGO_DB || "yeschef").collection("plan_library").find({ active: true }).toArray())
      .sort((a, b) => { const x = String(a.order ?? ""), y = String(b.order ?? ""); return x < y ? -1 : x > y ? 1 : 0; });
  } finally {
    await client.close();
  }

  const toggleKeyForSubtype = Object.fromEntries(MENU_ENTRIES.filter((e) => e.group === "body").map((e) => [e.subtype, e.key]));
  const dropReason = (def) => {
    const toggleKey = toggleKeyForSubtype[def.subtype];
    if (toggleKey && ENABLED[toggleKey] === false) return `'${toggleKey}' toggled off`;
    const missingFlag = (def.requiredFlags || []).find((f) => !FORM.flags[f]);
    if (missingFlag) return `required flag '${missingFlag}' not set`;
    const disabledInput = (def.inputs || []).find((inp) => ENABLED[inp] === false);
    if (disabledInput) return `input '${disabledInput}' disabled`;
    return null;
  };

  console.log(`── FILTER (plan_library active=${fromDb.length}) ──`);
  const defs = [];
  for (const def of fromDb) {
    const r = dropReason(def);
    console.log(`  ${r ? "drop" : "KEEP"}  ${def.name}${r ? ` — ${r}` : ""}`);
    if (!r) defs.push(def);
  }
  const { defs: kept, removed } = pruneOrphans(defs);
  for (const r of removed) console.log(`  drop  ${r.name} — orphan, needs [${r.context.join(", ")}], none kept`);

  const plan = composeFromDefs(kept, FORM, { isProd: false });
  console.log("\n── COMPOSED PLAN ──");
  plan.forEach((s, i) => console.log(
    `  #${i} subtype=${s.subtype} kind=${s.kind} count=${Array.isArray(s.items) ? s.items.length : 1}` +
    ` contexts=[${(s.contexts || []).join(",")}] model=${s.model}` +
    (s.rowsOf ? ` rowsOf=[${s.rowsOf.join(",")}] (units materialised at dispatch)` : "") +
    (s.error ? `  ⚠ ERROR: ${s.error}` : "")
  ));
  const units = plan.reduce((n, s) => n + (Array.isArray(s.items) ? s.items.length : 1), 0);
  console.log(`\ncompose-time LLM units: ${units}  (+ Build Recipe Details, one per row of Recipes+Courses ≈ ${2 * 2 * (COURSE_COUNTS.entree + COURSE_COUNTS.side)})`);

  const recipes = plan.find((s) => s.subtype === "recipes");
  const fail = [];
  if (plan.length !== 5) fail.push(`expected 5 steps, got ${plan.length}`);
  if (!recipes) fail.push("no `recipes` step composed");
  else {
    if (recipes.items?.length !== 4) fail.push(`recipes count is ${recipes.items?.length}, expected 4 (2 diets × 2 days)`);
    if (!recipes.contexts?.length) fail.push("recipes has EMPTY contexts — the protein grid is not wired in");
  }
  if (plan.some((s) => s.error)) fail.push("a step failed to render");
  if (fail.length) { console.error(`\n✗ ${fail.join("; ")}`); process.exitCode = 1; }
  else console.log("\n✓ 5 steps, recipes ×4 with contexts, no template errors");
  return plan;
}

// ── --run: create the plan through the real API, then launch ONE /ai/menu build ──────────────────
function loadFrontendEnv() {
  // The Firebase web API key (needed to mint an ID token) lives in the frontend's .env.local, the
  // same file e2e/global-setup.mjs parses by hand.
  const file = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "yeschef", ".env.local");
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    throw new Error(`could not read ${file} — needed for NEXT_PUBLIC_FIREBASE_API_KEY`);
  }
}

async function token() {
  const key = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  if (!key) throw new Error("NEXT_PUBLIC_FIREBASE_API_KEY unset");
  const email = process.env.YC_EMAIL || "test.headchef@yeschef.test";
  const password = process.env.YC_PASSWORD || "TestPass!2026";
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`Firebase sign-in failed for ${email}: ${res.status} — set YC_EMAIL/YC_PASSWORD`);
  const { idToken } = await res.json();
  const claims = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
  return { idToken, uid: claims.user_id ?? claims.sub, email };
}

async function run() {
  loadFrontendEnv();
  const baseUrl = process.env.YC_BASE_URL || "http://localhost:3100";
  const aiBase = process.env.NEXT_PUBLIC_AI_BASE || "http://localhost:5101/yeschef-c572a/us-central1/ai";
  const { idToken, uid, email } = await token();
  const auth = { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" };
  console.log(`signed in as ${email} (uid ${uid})`);

  const created = await fetch(`${baseUrl}/api/meal_plan`, {
    method: "POST", headers: auth,
    body: JSON.stringify({
      name: PLAN_NAME, values: VALUES, duration: DURATION, residents: RESIDENTS,
      dietWeights: DIET_WEIGHTS, courseCounts: COURSE_COUNTS, costTier: COST_TIER, location: LOCATION,
    }),
  });
  if (!created.ok) throw new Error(`POST ${baseUrl}/api/meal_plan → ${created.status} ${await created.text()}`);
  const { id: planId } = await created.json();

  // companyId is read back off the plan the server just wrote — never hardcoded.
  const got = await fetch(`${baseUrl}/api/meal_plan/${planId}`, { headers: auth });
  if (!got.ok) throw new Error(`GET /api/meal_plan/${planId} → ${got.status}`);
  const { data: plan } = await got.json();
  const companyId = String(plan.companyId);
  console.log(`created plan "${PLAN_NAME}"\n  planId=${planId} companyId=${companyId}`);

  const build = await fetch(`${aiBase}/menu`, {
    method: "POST", headers: auth,
    body: JSON.stringify({
      userId: uid, companyId, values: VALUES, duration: DURATION, residents: RESIDENTS,
      flags: {}, dietWeights: DIET_WEIGHTS, courseCounts: COURSE_COUNTS, costTier: COST_TIER,
      location: LOCATION, enabled: ENABLED, planId, stepId: STEP_ID,   // no `fake` — REAL model
    }),
  });
  if (!build.ok) throw new Error(`POST ${aiBase}/menu → ${build.status} ${await build.text()}`);
  const { jobId } = await build.json();
  console.log(`launched build jobId=${jobId}`);
  console.log(`  watch: llmResults/${jobId} (dashboard), or the plan at ${baseUrl}/plans/${planId}`);
}

try {
  await composeCheck();
  if (RUN) { console.log(""); await run(); }
  else console.log("\n(compose check only — nothing written. Re-run with --run to create the plan and launch the build.)");
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
}
