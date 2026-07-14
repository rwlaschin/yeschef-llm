// compose.js — PURE plan composition from DB-authored step definitions.
//
// Replaces the old promptKey/vars stub: each step def in the `plan_library` collection carries
// Handlebars templates (instruction/pass/fail) that we render against a context built from the
// form, producing a real `instructions` string the worker can run directly.
//
// NO Firestore here — composeFromDefs takes the already-sorted+filtered defs and the form, and
// returns plan[]. The Firestore read + filtering lives in menu-plan.js (composeMenuPlan). Keeping
// this pure makes it unit-testable without the emulator (see scripts/test-compose.mjs).

import Handlebars from "handlebars";

// One shared Handlebars instance with our helpers registered once.
const hb = Handlebars.create();
// {{join arr ", "}} → "a, b, c". Tolerates a non-array (returns "") and a missing separator.
hb.registerHelper("join", (arr, sep) => (Array.isArray(arr) ? arr.join(typeof sep === "string" ? sep : ", ") : ""));
// {{count list}} → number of items in a list field, e.g. {{count diets}}. Empty/non-array → 1
// (never 0, so it's safe as a divisor).
hb.registerHelper("count", (arr) => (Array.isArray(arr) && arr.length ? arr.length : 1));

// Comparisons: eq ne gt lt ge le. Each works BOTH as a subexpression — {{#if (eq (count diets) 1)}}
// — and as a block — {{#eq (count diets) 1}}…{{else}}…{{/eq}}. (Handlebars has no infix operators,
// so the operator leads.) Used as a block, renders the body/else; otherwise returns the boolean.
// Comparisons: eq ne gt lt ge le. Work as a subexpression — {{#if (eq (count diets) 1)}} — and as a
// block — {{#eq (count diets) 1}}…{{else}}…{{/eq}}. (Handlebars has no infix, so the operator leads.)
// Types: number↔number compares directly; a list compared to a NUMBER uses the list's length
// (`gt diets 5`); list↔list compares contents; strings compare as strings. Loose ==/!=.
const numLike = (x) => typeof x === "number" || (typeof x === "string" && x.trim() !== "" && !isNaN(Number(x)));
const listEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
// Coerce a list to its length ONLY when the other operand is a number; otherwise leave it as-is.
const lenIfNum = (v, other) => (Array.isArray(v) && numLike(other) ? v.length : v);
const cmp = (test) => function (a, b, opts) {
  const ok = test(a, b);
  return opts && typeof opts.fn === "function" ? (ok ? opts.fn(this) : opts.inverse(this)) : ok;
};
hb.registerHelper("eq", cmp((a, b) => (Array.isArray(a) && Array.isArray(b)) ? listEq(a, b) : lenIfNum(a, b) == lenIfNum(b, a)));
hb.registerHelper("ne", cmp((a, b) => (Array.isArray(a) && Array.isArray(b)) ? !listEq(a, b) : lenIfNum(a, b) != lenIfNum(b, a)));
hb.registerHelper("gt", cmp((a, b) => lenIfNum(a, b) >  lenIfNum(b, a)));
hb.registerHelper("lt", cmp((a, b) => lenIfNum(a, b) <  lenIfNum(b, a)));
hb.registerHelper("ge", cmp((a, b) => lenIfNum(a, b) >= lenIfNum(b, a)));
hb.registerHelper("le", cmp((a, b) => lenIfNum(a, b) <= lenIfNum(b, a)));

// {{zip a b …}} → tuples [[a0,b0,…], …], truncated to the shortest list. Iterate with Handlebars'
// own block params (one parser): {{#each (zip legals codes) as |pair|}}{{pair.[0]}} → {{pair.[1]}}{{/each}}.
hb.registerHelper("zip", (...args) => {
  const lists = args.slice(0, -1).map((a) => (Array.isArray(a) ? a : [])); // last arg = Handlebars options
  if (!lists.length) return [];
  const n = Math.min(...lists.map((l) => l.length));
  return Array.from({ length: n }, (_, i) => lists.map((l) => l[i]));
});

// {{proteinBackbone proteins diet}} → the grid's assigned protein for each slot of THIS diet, as
// `Day N | mealtime | Type (cut)` rows the recipe prompt builds dishes on — so a REAL (LLM) build
// mirrors the proteins grid. The fake path reads ctx.proteins directly (cannedRecipes); the model
// only ever sees what the prompt renders, so without this the LLM ignores the grid and free-styles.
// Diet key is space-stripped/lower-cased to match proteinSeedFromGrid; a single-diet grid falls back
// to its sole slice when the unit's diet doesn't match. Empty → "" (falsy, so {{#if}} skips the block).
hb.registerHelper("proteinBackbone", (proteins, diet, day) => {
  const all = proteins && typeof proteins === "object" ? proteins : {};
  const keys = Object.keys(all);
  if (!keys.length) return "";
  const nd = String(diet || "").replace(/\s+/g, "").toLowerCase();
  const slice = all[nd] || (keys.length === 1 ? all[keys[0]] : null);
  if (!slice) return "";
  // Optional day filter (day-fanout: {{proteinBackbone proteins slot.diet slot.day}} → just that
  // day's rows). Handlebars passes an options object as the trailing arg, so only a real number/
  // numeric string narrows; anything else (the options object, undefined) emits all days.
  const only = (typeof day === "number" || (typeof day === "string" && /^\d+$/.test(day))) ? Number(day) : null;
  const days = Object.keys(slice).filter((d) => only == null || Number(d) === only).sort((a, b) => Number(a) - Number(b));
  const lines = [];
  for (const day of days) {
    for (const meal of Object.keys(slice[day] || {})) {
      const p = slice[day][meal];
      if (p && p.type) lines.push(`Day ${day} | ${meal} | ${p.type}${p.cut ? ` ${p.cut}` : ""}`);
    }
  }
  return lines.length ? new Handlebars.SafeString(lines.join("\n")) : "";
});

// ---- Seasons & per-unit dates (hemisphere-aware) ----------------------------------------------
// Need a Location → the context carries {{hemisphere}} (North/South), {{date}} (today), {{startDate}} and
// {{businessDaysOnly}}. Without a location these are empty and the helpers return "".
const SEASON_CYCLE = ["winter", "spring", "summer", "fall"]; // calendar progression (same names both hemispheres)
const STARTMONTH_N = { winter: 11, spring: 2, summer: 5, fall: 8 }; // northern season → start month (0=Jan)
const root = (opts) => (opts && opts.data && opts.data.root) || {};
const monthOf = (s) => { const m = /^\d{4}-(\d{2})/.exec(String(s || "")); return m ? parseInt(m[1], 10) - 1 : null; };
// month (0=Jan) → season for the hemisphere. Northern: Dec–Feb winter, Mar–May spring, … Southern: +2 (mod 4).
function seasonOf(month0, hemisphere) {
  if (month0 == null) return "";
  const i = Math.floor((((month0 + 1) % 12)) / 3);
  return SEASON_CYCLE[hemisphere === "South" ? (i + 2) % 4 : i];
}
// Calendar date (YYYY-MM-DD) of the nth unit (1-based) from startDate, skipping weekends when
// weekdaysOnly. Pure UTC math — `new Date(string)` is deterministic (not `now`).
function nthUnitDate(start, n, weekdaysOnly) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(start || "")) || !(n >= 1)) return "";
  const d = new Date(start + "T00:00:00Z");
  if (!weekdaysOnly) { d.setUTCDate(d.getUTCDate() + (n - 1)); return d.toISOString().slice(0, 10); }
  let counted = 0;
  while (counted < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) counted++;
    if (counted === n) break;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}
// {{date}} → today (location-stamped); {{date n}} → the nth fan-out unit's date (weekday-aware).
hb.registerHelper("date", function (...args) {
  const r = root(args[args.length - 1]);
  return args.length <= 1 ? (r.date || "") : nthUnitDate(r.startDate, Number(args[0]), !!r.businessDaysOnly);
});
// {{tomorrow}} → the day after today (today's date + 1, in the user's tz). For "order for today/tomorrow".
hb.registerHelper("tomorrow", function (opts) {
  const s = root(opts).date || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
});
// {{season}} → current season; {{season <date>}} → season for that date. Hemisphere-aware.
hb.registerHelper("season", function (...args) {
  const r = root(args[args.length - 1]);
  return seasonOf(args.length > 1 ? monthOf(args[0]) : monthOf(r.date), r.hemisphere);
});
// {{seasons}} → the four seasons rotated to start at the current (or given date's) season.
hb.registerHelper("seasons", function (...args) {
  const r = root(args[args.length - 1]);
  const cur = seasonOf(args.length > 1 ? monthOf(args[0]) : monthOf(r.date), r.hemisphere);
  const i = SEASON_CYCLE.indexOf(cur);
  return i < 0 ? [] : SEASON_CYCLE.slice(i).concat(SEASON_CYCLE.slice(0, i));
});
// {{seasonDate <season>}} → that season's start date (YYYY-MM-01) in the current year + hemisphere.
hb.registerHelper("seasonDate", function (season, opts) {
  const r = root(opts);
  const yr = (/^(\d{4})/.exec(r.date || "") || [])[1];
  const n = STARTMONTH_N[String(season).toLowerCase()];
  if (!yr || n == null) return "";
  const mo = r.hemisphere === "South" ? (n + 6) % 12 : n;
  return `${yr}-${String(mo + 1).padStart(2, "0")}-01`;
});
// {{weekday}} → today's weekday name; {{weekday <date>}} → that date's. For deterministic day-of-week
// logic, e.g. {{#eq (weekday (date itemIndex)) "Friday"}}…{{/eq}}.
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
hb.registerHelper("weekday", function (...args) {
  const r = root(args[args.length - 1]);
  const s = args.length > 1 ? String(args[0]) : (r.date || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? WEEKDAYS[new Date(s + "T00:00:00Z").getUTCDay()] : "";
});

// {{allocate diets residents [bufferPct]}} → the per-diet portion plan, computed in CODE because LLMs
// fumble exactly this (multiply, round, scale). Splits `residents` across the diets by their RELATIVE
// weights (form `dietWeights`; a diet with no/≤0 weight falls back to an equal share). Each share is
// rounded UP (ceil) — you can never serve or short half a person — so the per-diet counts sum to ≥
// residents (a little over is the safe direction); the buffer (default 5%, also ceil'd) adds more on
// top. Returns rows to {{#each}} or join:
//   [{ diet, weight, pct, demand, count }] — pct = % of residents, demand = ceil'd share, count = batch (w/ buffer).
hb.registerHelper("allocate", function (...args) {
  const opts = args[args.length - 1];
  const r = root(opts);
  const diets = Array.isArray(args[0]) ? args[0] : toList(args[0]);
  const residents = Math.max(0, Math.ceil(Number(args[1]) || 0));
  const bufferPct = args.length > 3 ? (Number(args[2]) || 0) : 0.05; // optional 3rd arg; else 5%
  if (!diets.length) return [];
  const weights = r.dietWeights || {};
  const w = diets.map((d) => { const v = Number(weights[d]); return v > 0 ? v : 1; });
  const sum = w.reduce((a, b) => a + b, 0);
  const demand = w.map((wi) => Math.ceil((residents * wi) / sum)); // ceil — never short a resident
  return diets.map((d, i) => ({
    diet: d, weight: w[i], pct: Math.round((w[i] / sum) * 100),
    demand: demand[i], count: Math.ceil(demand[i] * (1 + bufferPct)),
  }));
});

// Split a comma-delimited form value into a trimmed, empties-removed array. "" → [].
function toList(s) {
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

// Case-insensitive view of the context: a template can reference {{Legals}} or {{legals}} and both
// resolve to the lowercase key. Normalizes the variable LOOKUP only — literal text is untouched.
function lc(ctx) {
  const lower = (p) => (typeof p === "string" && !(p in ctx) && p.toLowerCase() in ctx ? p.toLowerCase() : p);
  return new Proxy(ctx, {
    has: (t, p) => typeof p === "string" ? (p in t || p.toLowerCase() in t) : p in t,
    get: (t, p) => t[lower(p)],
    getOwnPropertyDescriptor: (t, p) => Object.getOwnPropertyDescriptor(t, lower(p)),
  });
}

// Render a Handlebars template string against ctx. Empty/undefined template → "".
function render(tpl, ctx) {
  if (!tpl) return "";
  return hb.compile(String(tpl), { noEscape: true })(lc(ctx));
}

// Resolve what a step runs once-per. `mapOf` names the thing to iterate:
//   ""            → a single run (one unit; item is null)
//   "days"        → once per day (item = the day number, 1..N)
//   a list field  → once per entry in that list (item = the entry), e.g. "institution"/"diets"
//   "<int>"       → that many runs (item = the run number, 1..N)
// Pure — lists come from the render context. Returns the array of per-unit `item` values.
function resolveItems(mapOf, ctx) {
  // mapOf may be a Handlebars expression (e.g. {{join Legals ", "}}) or a bare field name — render
  // it first so templates resolve, then decide what to iterate over.
  const key = render(mapOf, ctx).trim();
  if (!key) return [null];
  if (/^days$/i.test(key)) return Array.from({ length: ctx.days }, (_, i) => i + 1);
  const fk = Object.keys(ctx).find((k) => k.toLowerCase() === key.toLowerCase()); // case-insensitive field
  const list = fk ? ctx[fk] : undefined;
  if (Array.isArray(list)) return list.length ? list : [null];
  if (/^\d+$/.test(key)) return Array.from({ length: Math.max(1, parseInt(key, 10)) }, (_, i) => i + 1);
  // A rendered comma-list (or any non-empty string) becomes the items to iterate.
  const items = toList(key);
  return items.length ? items : [null];
}

// "Run once per" can name the loop var with Handlebars' OWN block-param syntax: "Legals as |legal|".
// Handlebars' parser (not a custom one) gives the name + source; we bind each fan-out item to that
// name so instruction/pass/fail can use {{legal}} directly — no {{#each}} loop.
function parseMapOf(mapOf) {
  const raw = String(mapOf || "").trim();
  if (/\bas\s*\|/.test(raw)) {
    const inner = (/^\{\{\s*([\s\S]*?)\s*\}\}$/.exec(raw)?.[1] ?? raw).trim(); // allow {{Legals as |legal|}} too
    try {
      const block = hb.parse(`{{#each ${inner}}}{{/each}}`).body.find((n) => n.type === "BlockStatement");
      const name = block?.program?.blockParams?.[0];
      const source = block?.params?.[0]?.original;
      if (name && source != null) return { name, source };
    } catch { /* not a valid block-param spec → fall through to no-name */ }
  }
  return { name: null, source: raw };
}

// Build the render context shared by every step, plus per-step value/valueList overlaid per def.
// form shape: { values:{institution,legals,diets,restrictions,preferences,meals}, duration:{weeks,businessDaysOnly,days},
//               residents, flags:{pureed:bool}, costTier, enabled:{<name>:bool}, model }
function baseContext(form) {
  const values = form.values || {};
  const duration = form.duration || {};
  // days = explicit override, else derived from the plan duration: weeks × 5 (weekdays
  // only) or × 7 (full week). The grid/canned output emits one column per day, so a
  // 6-week weekdays plan → 30 days. Falls back to one week when no duration is set.
  const weeks = Number(duration.weeks) || 0;
  const days = Math.max(1, Number(duration.days) || (weeks ? weeks * (duration.businessDaysOnly ? 5 : 7) : 7));
  // Fan-out unit list for the recipes build: one entry per (diet, day) so each LLM call writes ONE
  // day for ONE diet — smaller, higher-fidelity prompts (the worker MIGs absorb the unit count).
  // Diet-major, day-minor; the frontend reconstructs the SAME order to map runs back. No diets → one
  // unnamed diet so a single-diet/ad-hoc plan still fans out by day.
  const dietList = toList(values.diets);
  const dietDays = (dietList.length ? dietList : [""]).flatMap(
    (diet) => Array.from({ length: days }, (_, i) => ({ diet, day: i + 1 })));
  return {
    // input lists — both array AND raw string forms available to templates
    institution: toList(values.institution),
    institutionRaw: values.institution || "",
    legals: toList(values.legals),
    legalsRaw: values.legals || "",
    diets: toList(values.diets),
    dietsRaw: values.diets || "",
    dietDays,
    restrictions: toList(values.restrictions),
    restrictionsRaw: values.restrictions || "",
    preferences: toList(values.preferences),
    preferencesRaw: values.preferences || "",
    meals: toList(values.meals),
    mealsRaw: values.meals || "",
    // scalars / shared
    residents: Math.max(1, Number(form.residents) || 1),
    days,
    weeks,
    businessDaysOnly: !!duration.businessDaysOnly,
    costTier: form.costTier || "",
    flags: form.flags || {},
    dietWeights: form.dietWeights || {}, // { <diet>: relative weight } → consumed by the {{allocate}} helper
    proteins: form.proteins || {}, // per-slot grid proteins (normDiet → day → mealtime → {type,cut}); rides ctx → fake dispatch → cannedRecipes so recipes mirror the grid

    // Runtime ids — unknown at compose (the job/run don't exist yet). Pass through as literal {{tokens}}
    // so the worker substitutes the real values at execution (it has jobId/step/unit). batchIndex = this
    // fan unit's index; runId = its steps/{id} doc. See worker/steps/step.js.
    jobId: "{{jobId}}",
    stepNumber: "{{stepNumber}}",
    batchIndex: "{{batchIndex}}",
    runId: "{{runId}}",

    // location-derived (server-stamped from the picked IANA zone): {{date}}/{{time}} in the user's tz,
    // {{region}} (country · city) for regional favorites, {{hemisphere}}/{{tz}} for seasons.
    date: form.date || "",
    time: form.time || "",
    region: form.region || "",
    hemisphere: form.hemisphere || "",
    tz: form.tz || "",
    startDate: (form.duration || {}).startDate || "", // plan start → {{date n}} computes the nth unit's date
    businessDaysOnly: !!(form.duration || {}).businessDaysOnly,
  };
}

// PURE composer. `stepDefs` MUST already be sorted (by order) and filtered (active, enabled,
// requiredFlags satisfied) by the caller. Returns plan[] with EXACTLY the fields the
// dispatcher (dispatch.js: model, tools, count/groups, kind) and worker (step.js: instructions,
// subtype, kind, contexts) consume, plus failStep/successStep for step.js.
export function composeFromDefs(stepDefs, form, opts = {}) {
  const isProd = !!opts.isProd; // caller resolves the env signal; compose stays pure/testable
  const ctx = baseContext(form);

  // name -> emitted plan index, so `context` names resolve to 0-based indices.
  const indexByName = {};
  stepDefs.forEach((def, i) => { indexByName[def.name] = i; });

  // Per-step fan-out items + per-unit var names, resolved up front so a `chain` step can INHERIT them
  // from the one earlier step it names (its context[0]) — same fan-out 1:1, no mapOf of its own.
  const SINGULAR = { institution: "institution", legals: "legal", diets: "diet", restrictions: "restriction", preferences: "preference", meals: "meal" };
  const itemsByName = {}, itemVarsByName = {};
  for (const def of stepDefs) {
    if (def.kind === "chain") {
      const src = (def.context || [])[0];
      itemsByName[def.name] = itemsByName[src] || [null];
      itemVarsByName[def.name] = itemVarsByName[src] || [];
    } else {
      const { name, source } = parseMapOf(def.mapOf);
      itemsByName[def.name] = resolveItems(source, ctx);
      itemVarsByName[def.name] = [...new Set([name, SINGULAR[String(source).trim().toLowerCase()]].filter(Boolean))];
    }
  }

  const plan = stepDefs.map((def) => {
    // Resolve context names -> 0-based indices among the emitted steps (drop unknown/forward refs).
    const contexts = (def.context || [])
      .map((nm) => indexByName[nm])
      .filter((idx) => idx != null);

    const step = {
      instructions: "",
      // The model is defined ON the step (StepForm); there is no run-level model. In production, an
      // optional per-step `modelProd` overrides it (e.g. a larger GPU tier); dev/dry-runs use `model`.
      model: (isProd && def.modelProd) ? def.modelProd : (def.model || ""),
      subtype: def.subtype,
      kind: def.kind,
      tools: def.tools || [],
      style: def.style || "structured", // output style → worker maps to a temperature; default structured
      contexts,
      includeInResults: !!def.includeInOutput,
      failStep: null,    // set below (compliance/validation → its single context)
      successStep: null, // set after the list is built (linear)
    };

    // A bad template (or mapOf) for ONE step is recorded on that step (step.error) instead of throwing
    // and blanking the whole plan — so the dry-run logs which step failed and why, and keeps going.
    try {
      // {{value}} = this step's primary input (first declared input, else step name for legacy defs).
      const primaryInput = (def.inputs && def.inputs[0]) || def.name;
      const value = (form.values || {})[primaryInput] || "";
      const stepCtx = { ...ctx, value, valueList: toList(value), tools: def.tools || [] };

      // "Legals as |legal|" names the fan-out var. Per-unit vars vary per unit AND can be wrapped in
      // helpers (e.g. {{season (date itemIndex)}}), which can't be pre-rendered with a placeholder — so
      // for a real fan-out we carry the ORIGINAL template + this step's render context + the items list,
      // and renderUnit() renders each unit fully (here for the display sample, and at dispatch per unit).
      // No `count` — items.length is the fan-out size.
      // Pre-resolved above; a `chain` step inherits its source's items/vars (its mapOf is ignored).
      const items = itemsByName[def.name];
      const itemVars = itemVarsByName[def.name];
      const fanned = (def.kind === "fanout" || def.kind === "chain") && items.length > 1;

      // The fake dispatch reads days/meals/proteins off step.renderCtx to build the worker's ctx
      // (dispatch.js). Carry it on EVERY step — a non-fanned step (e.g. a single-diet recipes build
      // where `diets` is empty → one unit) otherwise loses that ctx and the proteins seed never
      // reaches cannedRecipes. Harmless for the real path (renderCtx is dropped from the dry-run view).
      step.renderCtx = stepCtx;

      if (fanned) {
        step.template = { instruction: def.instruction || "", pass: def.pass || "", fail: def.fail || "" };
        step.items = items;                                // orchestrator launches one unit per entry
        if (itemVars.length) step.itemVars = itemVars;     // bound to items[unit] in renderUnit
        step.instructions = renderUnit(step, 0);           // a fully-rendered sample (unit 1) for display
      } else {
        // Single unit (or non-fan-out): render fully with the one item (or none) — nothing left to fill JIT.
        const item = items.length === 1 ? items[0] : null;
        const aliases = {};
        for (const v of itemVars) aliases[v] = item;
        const uctx = { ...stepCtx, ...aliases, item, itemIndex: 1, itemCount: items.length };
        step.instructions = `${render(def.instruction, uctx)}\n\nPass: ${render(def.pass, uctx)}\nFail: ${render(def.fail, uctx)}`;
      }
      if (def.kind === "chunks") step.groups = parseInt(def.mapOf, 10) || 1;
    } catch (e) {
      step.error = e.message; // e.g. "#if requires exactly one argument"
    }

    // On failure, the plan reverts to step `failStep` and re-runs forward. Precedence:
    //   1. an explicitly authored "On failure → go to" target (by step name, resolved to its index);
    //   2. else a validation/compliance step reverts to the step it validates (its single context).
    // A named target that was dropped (pruned) resolves to undefined → falls through to the default.
    if (def.failStep && indexByName[def.failStep] != null) {
      step.failStep = indexByName[def.failStep];
    } else if (def.subtype === "compliance" && contexts.length) {
      step.failStep = contexts[0];
    }

    return step;
  });

  // successStep is linear (i+1; last is null) — advancement is linear in step.js anyway.
  plan.forEach((s, i) => { s.successStep = i < plan.length - 1 ? i + 1 : null; });

  return plan;
}

// Cascade-prune the filtered step defs: a step that lists EARLIER STEPS (its `context` / "Earlier
// Steps") but whose referenced steps were ALL dropped has nothing to operate on (e.g. a join/output
// task whose compliance inputs were all skipped) — so drop it too. Repeats to a fixpoint, so dropping
// one step can orphan (and drop) its dependents. Steps with no `context` are independent and never
// pruned here. PURE. Returns { defs: kept, removed: [{ name, context }] }.
export function pruneOrphans(stepDefs) {
  let working = [...stepDefs];
  const removed = [];
  for (let changed = true; changed; ) {
    changed = false;
    const present = new Set(working.map((d) => d.name));
    const next = [];
    for (const d of working) {
      const deps = d.context || [];
      if (deps.length && !deps.some((n) => present.has(n))) {
        removed.push({ name: d.name, context: deps });
        changed = true;
      } else {
        next.push(d);
      }
    }
    working = next;
  }
  return { defs: working, removed };
}

// Render ONE fan-out unit's prompt (compose-time for the display sample, and by the orchestrator
// dispatch.js per unit). Renders the step's ORIGINAL template against its base render context plus this
// unit's values — {{item}}/{{itemIndex}}/{{itemCount}}, the named/singular vars (step.itemVars), all
// bound to step.items[unit]. This is why helper-wrapped per-unit expressions like
// {{season (date itemIndex)}} resolve correctly per unit. A step with no template (single/non-fan-out)
// is already fully rendered → returned as-is.
export function renderUnit(step, unit) {
  if (!step.template || !Array.isArray(step.items)) return step.instructions;
  const item = step.items[unit];
  const uctx = { ...step.renderCtx, item, itemIndex: unit + 1, itemCount: step.items.length };
  for (const v of step.itemVars || []) uctx[v] = item;
  const t = step.template;
  return `${render(t.instruction, uctx)}\n\nPass: ${render(t.pass, uctx)}\nFail: ${render(t.fail, uctx)}`;
}
