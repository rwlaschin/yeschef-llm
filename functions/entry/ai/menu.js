// POST /ai/menu — launch a Menu Plan. The structured sibling of /ai/plan: instead of minting a
// job and running the LLM planner, this COMPOSES the plan[] deterministically from the form inputs
// (see menu-plan.js), writes the job doc with the plan already in place, and dispatches step 0.
// Everything downstream (orchestrator step flow, worker, dashboard streaming) is identical — the
// only difference from /ai/plan is the plan's SOURCE.
import { randomUUID } from "crypto";
import { PubSub } from "@google-cloud/pubsub";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getCollection } from "../../lib/mongo.js";
import { ORCHESTRATE_TOPIC } from "../../lib/topics.js";
import { composeFromDefs, pruneOrphans } from "./compose.js";
import { hardDeleteRuns, isStepRun } from "./resume.js";
import { MENU_ENTRIES } from "./menu-plan.js";
import { stringify as yamlStringify } from "yaml";
import tzdb from "@vvo/tzdb";

// Serialize a composed plan the SAME way the planner's run renders it — a fenced YAML list of step
// summaries — so a menu job's `step:"plan"` run reads identically to a Request-page planner run in
// the dashboard. count = a fanout's unit count (items length) or 1.
export function planAsYaml(plan) {
  const steps = plan.map((s) => ({
    instructions: s.instructions,
    model: s.model,
    subtype: s.subtype,
    kind: s.kind,
    count: Array.isArray(s.items) ? s.items.length : (s.count ?? 1),
    contexts: s.contexts || [],
    tools: s.tools || [],
  }));
  // lineWidth:0 → no folding (no ">-"), keep newlines. A multi-line value (instructions, which carries
  // "Pass:/Fail:" text full of ": ") stays a block scalar ("|-"). Readability: a blank line BETWEEN each
  // top-level step (a linefeed) — NOT stripping the "|-" indicator. Stripping it made the indented text
  // re-parse as nested mappings and broke round-trip (/ai/rebuild); a blank line between sequence items
  // is valid YAML and parses cleanly. Only matches a step start ("\n- " at column 0), not indented
  // nested-array items ("\n    - ").
  const yaml = yamlStringify(steps, { lineWidth: 0 }).replace(/\n(- )/g, "\n\n$1");
  return "Composed from the Plan Library (deterministic — no planner LLM run).\n\n```yaml\n" + yaml + "```";
}

let _pubsub;
function pubsub() {
  if (!_pubsub) _pubsub = new PubSub({ projectId: process.env.GCP_PROJECT_ID });
  return _pubsub;
}

// IANA timezone → metadata (country, cities, …), keyed by name AND aliases. The picked zone is the
// single source of truth; from it we derive REGION and HEMISPHERE. Built once.
const TZDB = new Map(tzdb.getTimeZones().flatMap((z) => [z.name, ...z.group].map((n) => [n, z])));

// Southern-hemisphere countries — consulted ONLY when the offset test is inconclusive (a zone with no
// DST, e.g. Brisbane/Perth, São Paulo, Johannesburg). DST-observing southern zones (Sydney, Auckland,
// Santiago) are already caught by the offset test; listing them here too is harmless. Stable geography.
const SOUTHERN_CC = new Set(["AU","NZ","BR","ZA","AR","CL","UY","PY","BO","PE","NA","BW","ZW","ZM","MZ","AO","MG","MW","LS","SZ","TZ","KE","ID","TL","FJ","PG","NC","SB","VU","WS","TO","TV","CK","PF","RE","MU"]);

// UTC offset (minutes) for a zone at a given month, via Intl shortOffset ("GMT-8" → -480).
function tzOffsetMin(tz, month) {
  const d = new Date(Date.UTC(2024, month, 1, 12));
  const nm = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
    .formatToParts(d).find((p) => p.type === "timeZoneName")?.value || "GMT+0";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(nm);
  return m ? (m[1] === "-" ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3] || "0", 10)) : 0;
}

// Hemisphere from the zone: the southern hemisphere shifts DST to Dec–Feb, so its January offset is
// LARGER than July. Offsets equal (no DST) → fall back to the southern-country set above.
function hemisphereOf(tz, countryCode) {
  const jan = tzOffsetMin(tz, 0), jul = tzOffsetMin(tz, 6);
  if (jan > jul) return "South";
  if (jul > jan) return "North";
  return SOUTHERN_CC.has(countryCode) ? "South" : "North";
}

// Compose the plan from the Step Library (Mongo `plan_library`, alongside the prompts). Read the
// active step defs, sequence by the drag order (lex `order`), drop steps whose toggle is off /
// required flag is unset / a needed input is disabled or empty, and render via the PURE
// composeFromDefs. Lives HERE (server-only), not in menu-plan.js — the dashboard imports
// menu-plan.js and must stay free of firebase-admin. Returns { plan }.
//
// NOTE: data fields (institution/legals/diets/restrictions/residents/…) are NOT steps and have NO
// subtype — they only feed the steps' render context. We never require a step per data field; the
// DB steps (compliance, menu, recipe, …) are the plan, and they consume those fields as inputs.
async function composeMenuPlan(form = {}) {
  const enabled = form.enabled || {};
  const flags = form.flags || {};
  const values = form.values || {};

  // ── The active plan_library docs (Mongo), in DB drag order (lex `order`). `order` is a lexBetween
  // string key (set by drag-drop) → plain code-unit sort, like prompts. ──
  const col = await getCollection("plan_library");
  const fromDb = (await col.find({ active: true }).toArray())
    .sort((a, b) => { const x = String(a.order ?? ""), y = String(b.order ?? ""); return x < y ? -1 : x > y ? 1 : 0; });
  console.log(`[ai/menu DRY-RUN] ── FROM DB (plan_library, active=${fromDb.length}, lex order; ORIGINAL templates) ──`);
  fromDb.forEach((d, i) => {
    console.log(
      `  ${i}. ${d.name}  order=${JSON.stringify(d.order)} subtype=${d.subtype ?? "(none)"} kind=${d.kind ?? "?"}` +
      ` inputs=[${(d.inputs || []).join(",")}] requiredFlags=[${(d.requiredFlags || []).join(",")}] mapOf=${JSON.stringify(d.mapOf ?? "")}`
    );
    console.log(`     instruction: ${JSON.stringify(d.instruction ?? "")}`);
    console.log(`     pass: ${JSON.stringify(d.pass ?? "")}  fail: ${JSON.stringify(d.fail ?? "")}`);
  });

  // ── FILTER: a step is dropped when its toggle is off, a required flag is unset, or any data input
  //    it needs is disabled or empty. So disabling a data field drops the steps that depend on it. ──
  // The Steps toggles are keyed by body-entry key (menu/recipe/compliance/…); a DB step's NAME is
  // free-form, so we match a step to its toggle by SUBTYPE — the stable link. Toggling off skips ALL
  // steps of that subtype (e.g. "Compliance" off → every compliance step dropped, plural).
  const toggleKeyForSubtype = Object.fromEntries(
    MENU_ENTRIES.filter((e) => e.group === "body").map((e) => [e.subtype, e.key])
  );
  // Only the CHIP inputs can be empty/off, so only THEY gate a step. Always-present scalars a step may
  // also list (residents, days, costTier, date, …) live outside `values` and never gate (they're just
  // referenced in the template) — without this, selecting `residents` as an input would drop the step.
  const dropReason = (def) => {
    const toggleKey = toggleKeyForSubtype[def.subtype];
    if (toggleKey && enabled[toggleKey] === false) return `'${toggleKey}' toggled off`;
    const missingFlag = (def.requiredFlags || []).find((f) => !flags[f]);
    if (missingFlag) return `required flag '${missingFlag}' not set`;
    const disabledInput = (def.inputs || []).find((inp) => enabled[inp] === false);
    if (disabledInput) return `input '${disabledInput}' disabled`;
    return null;
  };
  console.log(`[ai/menu DRY-RUN] ── FILTER (DB order; disabling a data field drops its steps) ──`);
  const defs = [];
  for (const def of fromDb) {
    const reason = dropReason(def);
    console.log(`  ${reason ? "✗ drop" : "✓ keep"}  ${def.name}${reason ? ` — ${reason}` : ""}`);
    if (!reason) defs.push(def);
  }

  // Cascade: drop a step whose Earlier Steps (context) were ALL skipped — e.g. a join/output task
  // that depends on compliance steps that didn't survive. Repeats to a fixpoint.
  const { defs: kept, removed } = pruneOrphans(defs);
  for (const r of removed) {
    console.log(`  ✗ drop  ${r.name} — needs earlier step(s) [${r.context.join(", ")}], none kept`);
  }

  return { plan: composeFromDefs(kept, form) };
}

export async function post(req, reply) {
  const { userId, companyId, values, duration, residents, flags, costTier, location, enabled, dietWeights, jobId: reuseJobId, fake, planId, stepId } = req.body || {};
  const isFake = fake === true;   // dev/test: dispatch steps to the canned topic, not the model

  // Location is OPTIONAL and IS an IANA timezone — the single source of truth. When set, derive region
  // + hemisphere (season) and stamp "now" in its tz (compose stays pure). When unset/unknown, leave
  // all location-derived fields empty — nothing is fabricated.
  const z = location ? TZDB.get(location) : null;
  const tz = z ? location : "";
  const hemisphere = z ? hemisphereOf(tz, z.countryCode || "") : "";
  const region = z ? [z.countryName, z.mainCities?.[0]].filter(Boolean).join(" · ") : "";
  const now = new Date();
  const date = tz ? new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now) : "";                                   // YYYY-MM-DD
  const time = tz ? new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(now) : ""; // HH:MM

  // ── What is PASSED IN (these inputs are DATA fields + config — not steps/subtypes). ──
  console.log(`[ai/menu DRY-RUN] ── PASSED IN ──`);
  console.log(JSON.stringify({ userId, companyId, residents, duration, costTier, tz, region, hemisphere, date, time, values, flags, dietWeights }, null, 2));

  if (!userId || !companyId) {
    return reply.code(400).send({ error: "Missing required fields: userId, companyId" });
  }

  // ── What is DISABLED (form toggles set to false → their steps get dropped in FILTER below). ──
  const disabled = Object.keys(enabled || {}).filter((k) => (enabled || {})[k] === false);
  console.log(`[ai/menu DRY-RUN] ── DISABLED ──\n  ${disabled.length ? disabled.join(", ") : "(none)"}`);

  const { plan } = await composeMenuPlan({
    values: values || {}, // { <entryKey>: comma-delimited string } — keyed by input entry
    enabled: enabled || {},
    duration: duration || {},
    residents: residents || 300,
    flags: flags || {},
    costTier: costTier || "",
    dietWeights: dietWeights || {}, // { <diet>: relative weight } for the {{allocate}} portion split
    tz, region, hemisphere, date, time,
  });

  // ── What is BUILT: plan in DB order; each step's NUMBER is its position, calculated here. ──
  const errCount = plan.filter((s) => s.error).length;
  console.log(`[ai/menu DRY-RUN] ── BUILT PLAN (${plan.length} step(s); numbers = position${errCount ? `; ${errCount} with errors` : ""}) ──`);
  plan.forEach((s, i) => console.log(
    `  #${i} ${s.subtype ?? "(none)"}/${s.kind} model=${s.model} units=${Array.isArray(s.items) ? s.items.length : 1}` +
    ` contexts=[${(s.contexts || []).join(",")}] success=${s.successStep} fail=${s.failStep} inResults=${s.includeInResults}` +
    (s.error ? `\n     ⚠ TEMPLATE ERROR: ${s.error}` : "")
  ));
  // Drop the bulky per-step renderCtx from the dry-run view (it's internal plumbing for renderUnit).
  const shown = plan.map(({ renderCtx, ...rest }) => rest);
  console.log(JSON.stringify(shown, null, 2));

  if (!plan.length) {
    return reply.code(400).send({ error: "No entries enabled — nothing to build" });
  }
  const db = getFirestore();
  const jobId = reuseJobId || randomUUID();          // reuse → rerun THIS job in place; else a new job
  const jobRef = db.collection("llmResults").doc(jobId);
  const summary =
    `Menu plan · ${duration?.weeks ?? "?"}w${duration?.businessDaysOnly ? " (business days)" : ""}` +
    ` · ${residents ?? 300} residents` +
    (values?.institution ? ` · ${values.institution}` : "") +
    (values?.diets ? ` · ${values.diets}` : "");
  // No run-level model: each step carries its own (def.model). Record the first step's for the summary.
  const jobModel = plan[0]?.model || "";

  if (reuseJobId) {
    // RERUN IN PLACE: the plan was just RECOMPOSED from the current form, so toggle/diet edits ARE
    // honored (disabled steps are already gone from plan[]). Wipe the prior step runs, overwrite the
    // plan, reset run state — keep createdAt so the history slot is stable. Write before launching:
    // dispatchStep reads plan[step] off this doc.
    await hardDeleteRuns(jobRef, isStepRun);
    await jobRef.set({
      model: jobModel, message: summary, userPrompt: summary, plan, stepCount: plan.length,
      cursor: 0, status: "running", failedSteps: [], attempts: {}, outcome: null, fake: isFake,
    }, { merge: true });
  } else {
    await jobRef.set({
      // `userPrompt` mirrors the Request path's doc (start.js) so the llmResults shape doesn't
      // deviate — a menu has no free-text prompt, so it carries the human summary.
      jobId, userId, companyId, model: jobModel, type: "menu",
      message: summary, userPrompt: summary, plan, stepCount: plan.length, cursor: 0,
      status: "running", fake: isFake, createdAt: FieldValue.serverTimestamp(),
    });
  }
  // Save/refresh the FORM INPUTS doc (id = jobId) so the dashboard can reload this plan into the form.
  // Results live in llmResults/{jobId}; this carries the inputs + the jobId link. Client never writes here.
  // Company-scoped BY PATH (companies/{companyId}/menuPlans) — the tenant boundary is structural,
  // and the history read is a single-field orderBy(createdAt) with NO composite index.
  await db.collection("companies").doc(companyId).collection("menuPlans").doc(jobId).set({
    jobId, userId, companyId, message: summary,
    // Reverse link → the Mongo meal_plan (PLAN CONFIG) + which step this build is for.
    // Forward link is meal_plan.steps[].jobId; together they bind config ↔ build both ways.
    ...(planId ? { planId } : {}), ...(stepId ? { stepId } : {}),
    input: {
      values: values || {}, duration: duration || {}, residents,
      flags: flags || {}, costTier: costTier || "", location: location || "",
      dietWeights: dietWeights || {}, enabled: enabled || {},
    },
    ...(reuseJobId ? {} : { createdAt: FieldValue.serverTimestamp() }),
  }, { merge: true });
  // Write the `step:"plan"` RUN doc — the same shape a Request-page planner run produces, so a menu
  // job is shape-identical in llmResults and the dashboard's Plan panel (which reads the step:"plan"
  // run, not the doc's plan[]) renders it. There's no planner LLM here, so the response is the plan
  // serialized to the planner's YAML. isStepRun excludes "plan", so rerun never deletes it — we
  // overwrite it here. status:"success" since composition already happened.
  await jobRef.collection("steps").doc("plan").set({
    step: "plan", companyId, userId,
    status: "success", outcome: null, isDeleted: false, deletedAt: null,
    prompt: "", message: summary, response: planAsYaml(plan),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    completedAt: FieldValue.serverTimestamp(),
  });
  // Launch through the orchestrator — publish `start`. The plan is already on the doc, so start.js
  // skips the planner and dispatches step 0. Same single launch authority for every job.
  await pubsub().topic(ORCHESTRATE_TOPIC).publishMessage({ json: { action: "start", jobId } });

  console.log(`[ai/menu] → ${reuseJobId ? "RERUN" : "new"} jobId=${jobId} published start to "${ORCHESTRATE_TOPIC}" steps=${plan.length} step0Model=${jobModel}`);
  return reply.send({ jobId });
}
