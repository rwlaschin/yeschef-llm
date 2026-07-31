// Deterministic FALCPA big-9 allergen keyword scan — a RECALL BACKSTOP, not the primary detector.
// The per-ingredient LLM step in categorize.js is authoritative and owns the nuanced calls (family
// reasoning like barley→wheat, and negatives like "peanut butter" is NOT dairy). This scan only
// catches the literal, unambiguous cases the model might miss.
//
// Two rules keep it from producing false positives on its own:
//   1. Match on WORD BOUNDARIES, not raw substring — so "egg" no longer fires on "eggplant",
//      "soy" no longer fires on "soybean-free", etc.
//   2. Only UNAMBIGUOUS keywords live here. Words that flip allergen depending on what precedes
//      them — "butter" (dairy vs. peanut/cocoa/shea butter), "cream" (dairy vs. cream of tartar),
//      "flour" (wheat vs. almond/coconut/rice flour) — are DELIBERATELY omitted; disambiguating
//      them needs the semantic step, and hardcoding an exclusion list here only catches the
//      variants we happened to think of.
const KEYWORDS = {
  milk: ["milk", "cheese", "yogurt", "yoghurt", "whey", "casein", "ghee", "buttermilk", "custard", "half and half", "half-and-half"],
  eggs: ["egg", "eggs", "mayonnaise", "mayo", "meringue", "aioli"],
  fish: ["fish", "salmon", "tuna", "cod", "tilapia", "anchovy", "anchovies", "sardine", "halibut", "trout", "bass", "worcestershire"],
  shellfish: ["shrimp", "prawn", "crab", "lobster", "clam", "mussel", "oyster", "scallop", "crawfish", "crayfish"],
  tree_nuts: ["almond", "walnut", "cashew", "pecan", "pistachio", "hazelnut", "macadamia", "brazil nut", "pine nut"],
  peanuts: ["peanut"],
  wheat: ["wheat", "bread", "pasta", "noodle", "tortilla", "couscous", "cracker", "breadcrumb", "panko", "bulgur", "farro", "seitan"],
  soybeans: ["soy", "soya", "tofu", "edamame", "miso", "tempeh"],
  sesame: ["sesame", "tahini"],
};

const norm = (s) => String(s ?? "").toLowerCase();

// Word-boundary test — the keyword must appear as a whole word (or hyphen/space-delimited phrase),
// not embedded in a larger word. Cached per keyword.
const rxCache = new Map();
function hasWord(name, keyword) {
  let rx = rxCache.get(keyword);
  if (!rx) {
    rx = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    rxCache.set(keyword, rx);
  }
  return rx.test(name);
}

// Scan a list of ingredient names (already cut/prep-normalized by categorize) for FALCPA-9 allergens.
// Returns the sorted, deduped subset of the big-9 that matched — no free text, no hallucination.
export function detectAllergens(ingredientNames) {
  const found = new Set();
  for (const raw of ingredientNames) {
    const name = norm(raw);
    for (const [allergen, keywords] of Object.entries(KEYWORDS)) {
      if (keywords.some((k) => hasWord(name, k))) found.add(allergen);
    }
  }
  return [...found].sort();
}
