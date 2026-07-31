// Deterministic FDC-backed FALCPA-9 allergen lookup. NO LLM in the allergen decision.
//
// Per ingredient, two signals are unioned (over-inclusive = the safe direction for allergens):
//   (a) category+name rule from the best-matching GENERIC USDA food (whole-food view), and
//   (b) a MAJORITY vote across the branded ingredient STATEMENTS that are the same ingredient
//       (composed-food view — catches tahini->sesame in hummus; majority drops outlier products
//       like one peanut butter that also lists pecans).
//
// Results cache in Mongo (allergen_cache) keyed on the normalized ingredient, so FDC's ~1000
// req/hr limit is hit only on cold ingredients — institutional menus reuse a bounded vocabulary,
// so steady state is ~all cache hits. Unknown/unresolved ingredients return allergens:null so the
// caller can fall back (keyword scan) and flag for review rather than silently returning [].
//
// Requires env USDA_FDC_API_KEY (FoodData Central key). Without it, findAllergens returns null
// (caller falls back). Add it to yeschef-llm/.env and restart the functions emulator to enable.
import { getCollection } from "./mongo.js";

const API_KEY = process.env.USDA_FDC_API_KEY;
const GENERIC = ["Foundation", "SR Legacy", "Survey (FNDDS)"];
const GF_GRAIN = ["rice", "corn", "maize", "oat", "quinoa", "buckwheat", "millet", "sorghum", "amaranth", "teff"];

const rxCache = new Map();
// plural-tolerant whole-word match: \bKEYWORD(s)?\b — matches peanut/peanuts, egg/eggs, but not
// "nut" in nutmeg or "egg" in eggplant.
function has(text, keyword) {
  let rx = rxCache.get(keyword);
  if (!rx) { rx = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`); rxCache.set(keyword, rx); }
  return rx.test(text);
}
const pick = (name, map) => {
  const out = new Set();
  for (const [a, kws] of Object.entries(map)) if (kws.some((k) => has(name, k))) out.add(a);
  return [...out];
};

// foodCategory regex -> allergen rule (order specific->broad; first match wins).
const CATEGORY_RULES = [
  [/cheese/, () => ["milk"]],
  [/dairy/, (n) => pick(n, { milk: ["milk", "cream", "cheese", "butter", "yogurt", "whey", "casein", "ghee"], eggs: ["egg"] })],
  [/nuts? and seeds?|nut and seed product/, (n) => pick(n, { tree_nuts: ["almond", "walnut", "cashew", "pecan", "pistachio", "hazelnut", "macadamia", "brazil", "pine nut"], peanuts: ["peanut"], sesame: ["sesame", "tahini"] })],
  [/legume|bean.*(dish|product)|pea.*product/, (n) => pick(n, { peanuts: ["peanut"], soybeans: ["soy", "soya", "tofu", "edamame", "miso", "tempeh"] })],
  [/cereal grain|pasta|grain product/, (n) => GF_GRAIN.some((g) => has(n, g)) ? [] : ["wheat"]],
  [/baked|bread|cereal/, (n) => GF_GRAIN.some((g) => has(n, g)) ? [] : ["wheat"]],
  [/finfish/, () => ["fish"]],
  [/fish|seafood/, (n) => pick(n, { shellfish: ["shrimp", "prawn", "crab", "lobster", "clam", "mussel", "oyster", "scallop"], fish: ["fish", "salmon", "tuna", "cod", "tilapia", "anchovy", "sardine"] })],
  [/^egg|eggs and omelet/, () => ["eggs"]],
  [/rice|grains/, (n) => GF_GRAIN.some((g) => has(n, g)) ? [] : ["wheat"]],
  // whole meats/poultry carry no big-9 themselves. But FDC files meat ANALOGS (tofu, tempeh,
  // seitan) under meat categories like "Other Meats", so still scan the name for plant-protein
  // cues — a real chicken breast has none (-> []), tofu -> soybeans, seitan -> wheat.
  [/poultry|chicken|turkey|beef|pork|lamb|veal|game|meat|sausage|luncheon/, (n) => pick(n, { soybeans: ["soy", "soya", "tofu", "edamame", "tempeh", "miso"], wheat: ["seitan"] })],
  [/vegetable|fruit|fats and oils|salad dressing|spices and herbs|seasoning|beverage/, () => []],
];

// Keyword sets for scanning legally-enumerated ingredient statements (safe: statements name the
// allergen literally, e.g. "SESAME", so no "peanut butter"->milk class of false positive).
const STMT = {
  milk: ["milk", "cream", "cheese", "butter", "whey", "casein", "ghee", "lactose"],
  eggs: ["egg", "albumen"],
  fish: ["fish", "anchovy", "salmon", "tuna", "cod"],
  shellfish: ["shrimp", "prawn", "crab", "lobster", "clam", "mussel", "oyster", "scallop"],
  tree_nuts: ["almond", "walnut", "cashew", "pecan", "pistachio", "hazelnut", "macadamia"],
  peanuts: ["peanut"],
  wheat: ["wheat", "barley", "rye", "malt"],
  soybeans: ["soy", "soybean", "soya", "tofu", "edamame", "miso"],
  sesame: ["sesame", "tahini", "tehina"],
};

const normKey = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const toks = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);

// A candidate food is only relevant if it contains every query token; rank by fewest extra tokens
// (closest to being JUST the queried ingredient, not a composed dish), generic type as tiebreak.
function score(qToks, food) {
  const d = toks(food.description);
  if (!qToks.every((q) => d.includes(q))) return -Infinity;
  return -(d.length - qToks.length) + (GENERIC.includes(food.dataType) ? 0.5 : 0);
}

async function searchFdc(query) {
  const res = await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, pageSize: 25 }),
  });
  if (!res.ok) throw new Error(`FDC ${res.status}`);
  return (await res.json()).foods || [];
}

function derive(query, foods) {
  const qToks = toks(query);
  const ranked = foods.map((f) => [score(qToks, f), f]).filter(([s]) => s > -Infinity).sort((a, b) => b[0] - a[0]);
  const best = (ranked[0] || [])[1];

  const category = best?.foodCategory ?? null, canonical = best?.description ?? null;

  // WHOLE-FOOD path: if the best match maps to a category rule, that rule is authoritative — do NOT
  // mix in ingredient statements (branded prepared versions of a whole food, e.g. "eggplant parmesan"
  // sold as "eggplant", would otherwise contaminate a plain vegetable with milk/wheat).
  if (best) {
    const cat = (best.foodCategory || "").toLowerCase(), name = (best.description || "").toLowerCase();
    for (const [re, rule] of CATEGORY_RULES) if (re.test(cat)) return { allergens: rule(name).sort(), canonical, category };
  }

  // COMPOSED/UNKNOWN path: no category rule (hummus, sauces, prepared foods) — trust the legally-
  // enumerated ingredient statements, majority vote across products that ARE this ingredient.
  const stmts = foods.filter((f) => f.ingredients && score(qToks, f) > -Infinity).map((f) => String(f.ingredients).toLowerCase());
  if (!stmts.length) return { allergens: null, canonical, category }; // unresolved -> caller falls back
  const tally = {};
  for (const s of stmts) for (const [a, ks] of Object.entries(STMT)) if (ks.some((k) => has(s, k))) tally[a] = (tally[a] || 0) + 1;
  const stmtAllergens = Object.entries(tally).filter(([, c]) => c / stmts.length >= 0.5).map(([a]) => a);
  return { allergens: stmtAllergens.sort(), canonical, category };
}

// Look up one ingredient's allergens, cache-first. Returns { allergens, canonical, category } where
// allergens is a sorted big-9 subset, or null if FDC couldn't resolve it (caller falls back).
export async function findAllergens(ingredient) {
  const key = normKey(ingredient);
  if (!key) return { allergens: [], canonical: null, category: null };
  if (!API_KEY) return { allergens: null, canonical: null, category: null };

  const col = await getCollection("allergen_cache");
  const cached = await col.findOne({ _id: key });
  if (cached) return { allergens: cached.allergens, canonical: cached.canonical, category: cached.category };

  let result;
  try {
    result = derive(key, await searchFdc(key));
  } catch (e) {
    console.error(`[allergenFdc] lookup failed for "${ingredient}": ${e.message}`);
    return { allergens: null, canonical: null, category: null };
  }
  // Cache resolved answers only (including a definite empty []); leave null (unresolved) uncached
  // so a later run can retry once FDC coverage/among results changes.
  if (result.allergens !== null) {
    await col.updateOne(
      { _id: key },
      { $set: { ingredient: key, allergens: result.allergens, canonical: result.canonical, category: result.category, fetchedAt: new Date().toISOString() } },
      { upsert: true },
    );
  }
  return result;
}

// Warm the cache for a whole batch (a recipe's ingredients) in one pass, so the first miss pulls
// everything about to be needed instead of one-at-a-time. Concurrency-capped to be gentle on FDC.
export async function warmAllergenCache(ingredients, concurrency = 5) {
  const uniq = [...new Set(ingredients.map(normKey).filter(Boolean))];
  for (let i = 0; i < uniq.length; i += concurrency) {
    await Promise.all(uniq.slice(i, i + concurrency).map((ing) => findAllergens(ing).catch(() => null)));
  }
}
