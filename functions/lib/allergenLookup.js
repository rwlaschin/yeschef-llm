// Deterministic FALCPA big-9 allergen lookup — a keyword match against known ingredient names,
// not an LLM guess. Allergens are a finite, well-defined list; a small model hallucinates on this
// task (invents allergens that aren't there, misses obvious ones like soy in tofu). A curated keyword
// map is cheap, reproducible, and auditable — no model call, no failure mode beyond "keyword missing"
// (fixed by adding a keyword, not by re-prompting).
const KEYWORDS = {
  milk: ["milk", "cream", "cheese", "butter", "yogurt", "yoghurt", "whey", "casein", "ghee", "buttermilk", "custard", "half and half", "half-and-half"],
  eggs: ["egg", "eggs", "mayonnaise", "mayo", "meringue", "aioli"],
  fish: ["fish", "salmon", "tuna", "cod", "tilapia", "anchovy", "anchovies", "sardine", "halibut", "trout", "bass", "worcestershire"],
  shellfish: ["shrimp", "prawn", "crab", "lobster", "clam", "mussel", "oyster", "scallop", "crawfish", "crayfish"],
  tree_nuts: ["almond", "walnut", "cashew", "pecan", "pistachio", "hazelnut", "macadamia", "brazil nut", "pine nut"],
  peanuts: ["peanut"],
  wheat: ["wheat", "flour", "bread", "pasta", "noodle", "tortilla", "couscous", "cracker", "breadcrumb", "panko", "bulgur", "farro", "seitan"],
  soybeans: ["soy", "soya", "tofu", "edamame", "miso", "tempeh"],
  sesame: ["sesame", "tahini"],
};

// Normalize an ingredient string for matching: lowercase, strip quantity/prep noise words won't hurt
// since we're doing substring containment, not exact match.
const norm = (s) => String(s ?? "").toLowerCase();

// Scan a list of ingredient names (already cut/prep-normalized by categorize) for FALCPA-9 allergens.
// Returns the sorted, deduped subset of the big-9 that matched — no free text, no hallucination.
export function detectAllergens(ingredientNames) {
  const found = new Set();
  for (const raw of ingredientNames) {
    const name = norm(raw);
    for (const [allergen, keywords] of Object.entries(KEYWORDS)) {
      if (keywords.some((k) => name.includes(k))) found.add(allergen);
    }
  }
  return [...found].sort();
}
