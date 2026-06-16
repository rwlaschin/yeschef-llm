// menu-plan.js — Menu Plan workflow STRUCTURE + registries. PURE: NO firebase-admin, NO compose
// import — the DASHBOARD imports these constants (via #menu-plan), so anything server-only here
// would get pulled into the browser bundle and crash it. The Handlebars render that turns the
// plan_library defs (passed in on the /ai/menu request) into a plan lives in the SERVER-ONLY
// menu.js (composeMenuPlan) and compose.js (composeFromDefs) — never here.
//
// MENU_ENTRIES / MENU_FLAGS / COST_TIERS are imported by the dashboard (form UI). They no longer drive
// composition — the DB step defs do.

export const MENU_ENTRIES = [
  // ── INPUT entries — chip fields; each becomes a "gather this" step ──
  {
    key: "institution", label: "Institution", group: "input", field: "chips", defaultEnabled: true,
    default: ["Senior Care"],
    options: ["Household", "School (Primary)", "School (Secondary)", "College", "Hotel", "Military", "Hospital", "Restaurant", "Catering", "Senior Care"],
    subtype: "query", kind: "fanout", includeInResults: true, contextsFrom: [],
    roles: ["request"],
  },
  {
    key: "legals", label: "Legals", group: "input", field: "chips", defaultEnabled: true,
    default: ["FDA Food Code", "CMS"],
    options: ["FDA Food Code", "CMS", "USDA", "HACCP", "State Health Code", "Joint Commission"],
    subtype: "query", kind: "fanout", includeInResults: true, contextsFrom: [],
    roles: ["request"],
  },
  {
    key: "diets", label: "Diets", group: "input", field: "chips", defaultEnabled: true,
    default: ["regular", "diabetic", "low-sodium", "renal", "gluten-free", "vegetarian"],
    options: ["regular", "diabetic", "low-sodium", "renal", "gluten-free", "vegetarian", "vegan", "low-fat", "lactose-free"],
    // Default RELATIVE diet mix (regular-heavy, typical of senior care) — the form seeds the per-diet
    // weight inputs from this, the user can override, and the {{allocate}} helper normalizes whatever
    // weights the SELECTED diets carry to split residents into per-diet batch counts.
    weights: { regular: 50, diabetic: 15, "low-sodium": 12, renal: 8, "gluten-free": 5, vegetarian: 8, vegan: 3, "low-fat": 4, "lactose-free": 3 },
    subtype: "query", kind: "fanout", includeInResults: true, contextsFrom: [],
    roles: ["request"],
  },
  {
    key: "restrictions", label: "Restrictions", group: "input", field: "chips", defaultEnabled: true,
    default: ["no nuts", "no grapefruit", "no cranberries", "seasonal"],
    options: ["no nuts", "no shellfish", "no pork", "no-sodium", "no grapefruit", "no cranberries", "seasonal", "organic", "local sourcing", "kosher", "halal"],
    subtype: "query", kind: "fanout", includeInResults: true, contextsFrom: [],
    roles: ["request"],
  },
  {
    // Meals to build, in TIME-OF-DAY order (the option order = display order). Fan a step over them
    // with `meals as |meal|`. Default = the three standard meals.
    key: "meals", label: "Meals", group: "input", field: "chips", defaultEnabled: true,
    default: ["breakfast", "lunch", "dinner"],
    options: ["breakfast", "brunch", "elevenses", "lunch", "tea", "dinner", "supper", "dessert", "nightcap"],
    subtype: "query", kind: "fanout", includeInResults: true, contextsFrom: [],
    roles: ["request"],
  },

  // ── BODY entries — fixed pipeline; toggle to skip ──
  {
    key: "compliance", label: "Compliance", group: "body", defaultEnabled: true,
    subtype: "compliance", kind: "fanout", includeInResults: true,
    contextsFrom: [],
    roles: ["validation"],
  },
  {
    key: "menu", label: "Menu", group: "body", defaultEnabled: true,
    subtype: "menu_plan", kind: "fanout", fanByDuration: true, includeInResults: true,
    contextsFrom: ["institution", "legals", "diets", "restrictions"],
    roles: ["request", "validation"],
  },
  {
    key: "recipe", label: "Recipes", group: "body", defaultEnabled: true,
    subtype: "recipe", kind: "fanout", fanByDuration: true, includeInResults: true,
    contextsFrom: ["menu"],
    roles: ["request"],
  },
  {
    key: "nutrition", label: "Nutrition", group: "body", defaultEnabled: false,
    subtype: "nutrition", kind: "fanout", fanByDuration: true, includeInResults: true,
    contextsFrom: ["recipe"],
    roles: ["request"],
  },
  {
    key: "inventory", label: "Inventory", group: "body", defaultEnabled: true,
    subtype: "inventory", kind: "aggregation", includeInResults: true,
    contextsFrom: ["recipe"],
    roles: ["request"],
  },
  {
    key: "order_form", label: "Order form", group: "body", defaultEnabled: true,
    subtype: "procurement", kind: "aggregation", includeInResults: true,
    contextsFrom: ["inventory"],
    roles: ["request", "validation"],
  },
];

// FLAGS — cross-cutting prep/texture constraints (NOT diets). Each is a FILTER KEY: a step def with
// `requiredFlags: ["pureed"]` is only included when that flag is active. Fragment TEXT is authored
// as its own step def in the Step Library.
export const MENU_FLAGS = [
  {
    key: "pureed", label: "Pureed-safe", defaultEnabled: true, appliesTo: ["menu", "recipe"],
    help: "Every dish must blend safely (no bones/shells) so a pureed/dysphagia version is possible.",
  },
  {
    key: "business_days", label: "Weekdays", defaultEnabled: false, appliesTo: ["menu"],
    help: "Plan Monday–Friday only; weekends are skipped (5 days per week instead of 7).",
  },
];

// COST TIERS — the Cost tier dropdown (key + label). A budget/quality label, rendered as {{costTier}}.
export const COST_TIERS = [
  { key: "institution default", label: "Institution default" },
  { key: "budget",   label: "Budget" },
  { key: "standard", label: "Standard" },
  { key: "premium",  label: "Premium" },
];

// LOCATIONS — EVERY IANA timezone (derived from the runtime's tz database, not hand-maintained), so
// the picker covers the whole world and never goes stale. The picked zone is the single source of
// truth: the server derives region, hemisphere (season), and current date/time from it (menu.js).
// `value`/`tz` are the IANA id; `label` is a readable form for the searchable picker.
export const LOCATIONS = (typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [])
  .map((tz) => ({ value: tz, tz, label: tz.replace(/_/g, " ").replace(/\//g, " / ") }));

// The actual FORM FIELDS a step can declare as inputs (Step Library "Required Inputs" picker) — only
// direct user inputs. DERIVED values are deliberately excluded (they'd duplicate the form field): days/
// weeks come from Duration, date/time/region/hemisphere from Location. Those are still usable in
// templates via the {{…}} helpers — listed in the Handlebars help panel, not selected here.
export const STATIC_FIELDS = ["institution", "legals", "diets", "restrictions", "meals", "residents", "costTier", "flags"];
