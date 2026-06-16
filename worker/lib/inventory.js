// worker/lib/inventory.js — the math behind the normalize_ingredients tool. NO Firestore.
//
// The model COPIES everything it needs from its prompt (it does NO math):
//   • residents + the diet distribution  ← from the STEP PROMPT (Handlebars-injected)
//   • the day's recipes (by diet)         ← from the CONTEXT (the day's menu)
// …and passes them as the tool's args. The TOOL does the math:
//
//   args = {
//     residents,                                  // e.g. 300
//     diets:   [ { diet, pct } ],                 // e.g. [{renal,2},{no-sodium,40},{regular,58}] — % or fraction
//     recipes: [ { diet, items:[{name,amount,unit}] } ],
//   }
//   count(diet)     = ceil(residents × diet%)     // how many eat that diet's recipe
//   servingQuantity = amount × count(diet)        // per ingredient line
//
// OUTPUT: one normalized row per line —
//   { id, ingredient, amount, servingUnit, servingQuantity, quantityUnit, diet, servings }

// ---- normalize: conservative key. Case/whitespace/plural ONLY — never strips a modifier. ----
const SINGULAR_KEEP = new Set(["molasses", "hummus", "couscous", "watercress", "asparagus", "swiss", "greens"]);
function singularize(w) {
  if (SINGULAR_KEEP.has(w)) return w;
  if (/sses$/.test(w)) return w;
  if (/oes$/.test(w)) return w.slice(0, -2);
  if (/ies$/.test(w)) return w.slice(0, -3) + "y";
  if (/s$/.test(w) && !/ss$/.test(w) && w.length > 3) return w.slice(0, -1);
  return w;
}
export function normalize(name) {
  return String(name == null ? "" : name).toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ").trim()
    .split(" ").filter(Boolean).map(singularize).join("-");
}

// how many residents eat a given diet's recipe. `pct` is the diet's share as a PERCENTAGE, however
// the model copied it from the instruction — 58, "58", or "58%" all mean 58% → 0.58. We strip any
// %/sign/whitespace and parse, then ÷100. ceil — never short a person. Unparseable → 0.
export function servingCount(residents, pct) {
  const n = parseFloat(String(pct == null ? "" : pct).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return Math.ceil((Number(residents) || 0) * (n / 100));
}

// Parse a per-serving amount the model may write many ways: 0.5, ".25", "1/4", "3/2", "1 1/2",
// "½", "1½", even "2 cups" (takes the number, ignores stray text). Sums whitespace-separated numeric
// tokens (each a decimal or a/b). Unparseable → 0.
const UFRAC = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8, "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875 };
export function parseAmount(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  let s = String(v == null ? "" : v).trim();
  if (!s) return 0;
  // a range ("1-2", "1 – 2", "1 to 2", maybe with a trailing unit) → ALWAYS the BIGGER number.
  const range = s.match(/(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)/i);
  if (range) return Math.max(parseFloat(range[1]), parseFloat(range[2]));
  for (const [g, val] of Object.entries(UFRAC)) if (s.includes(g)) s = s.replaceAll(g, ` ${val} `);
  let total = 0, any = false;
  for (const p of s.split(/\s+/).filter(Boolean)) {
    const fr = p.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
    if (fr) { const den = parseFloat(fr[2]); if (den) { total += parseFloat(fr[1]) / den; any = true; } continue; }
    const n = parseFloat(p);
    if (Number.isFinite(n)) { total += n; any = true; }
  }
  return any ? total : 0;
}

// Unmeasurable seasoning amounts ("to taste", "a smidgen", … in ANY language) → a nominal 1/4 tsp is
// handled by the MODEL (the inventory prompt), which is multilingual. Code does NOT try to enumerate
// the phrases — an English-only regex here would just be a non-exhaustive false safety net.

// Diets are controlled KEYWORDS passed through the whole pipeline — the recipe tool is given the same
// keywords, so a recipe's diet and the distribution's diet are the SAME string. Match exactly (trim
// only). If one ever doesn't match, it surfaces as 0 servings on the row — never silently wrong.
const dietKey = (d) => String(d == null ? "" : d).trim();

// Process a DAY'S recipes. All inputs are in `args` (model-copied); the tool does the math. The row
// `id` is only LOCALLY unique (recipe:line) — the run/streamer already scopes the output by job/run.
export function processDay(args) {
  const residents = Math.max(0, parseFloat(String(args?.residents == null ? "" : args.residents).replace(/[^0-9.]/g, "")) || 0);
  const pctOf = {};
  (args?.diets || []).forEach((d) => { if (d?.diet != null) pctOf[dietKey(d.diet)] = d.pct; });
  const rows = [];
  (args?.recipes || []).forEach((rec, r) => {
    const count = servingCount(residents, pctOf[dietKey(rec?.diet)]); // people on this recipe's diet
    (rec?.items || []).forEach((it, i) => {
      const amount = parseAmount(it?.amount);
      const su = String(it?.unit == null ? "" : it.unit);
      rows.push({
        id: `${r}:${i}`,
        ingredient: normalize(it?.name),
        amount,
        servingUnit: su,
        servingQuantity: amount * count,
        quantityUnit: su,
        diet: rec?.diet,
        servings: count,
      });
    });
  });
  return rows;
}
