// Deterministic category correction for ingredients the categorize prompt ALREADY names explicitly
// as examples (e.g. "vegetable=onion/garlic/peppers/tomato/broccoli/carrots/..."). The model
// contradicts its own given list often enough on these common, unambiguous ingredients (carrot →
// starch, tomato → fruit, broth → beverage, garlic → seasoning) that re-prompting isn't fixing it —
// this is a lookup, not a judgment call, for exactly the words the prompt already pins down.
// Deliberately narrow: only ingredients that are unambiguous AND already an explicit prompt example.
// Genuinely ambiguous ingredients (not in this map) are left to the model's judgment.
const OVERRIDES = {
  // Oils in aerosol form — the 3b model repeatedly tags these "beverage" (the word "spray"),
  // and no prompt wording has fixed it, so pin them deterministically.
  fat: ["cooking spray", "nonstick spray", "non-stick spray", "pan spray", "oil spray", "baking spray"],
  vegetable: ["onion", "garlic", "pepper", "bell pepper", "tomato", "broccoli", "carrot", "mushroom", "celery",
    "lettuce", "spinach", "kale", "cabbage", "zucchini", "cucumber", "eggplant", "squash", "cauliflower"],
  seasoning: ["broth", "stock", "salt", "pepper", "cumin", "paprika", "turmeric", "oregano", "basil",
    "thyme", "cinnamon", "nutmeg", "vinegar", "honey", "sugar", "parsley", "cilantro", "bay leaf", "bay leaves",
    "cayenne", "chili powder", "garlic powder", "onion powder", "ginger", "rosemary", "dill", "sage",
    "coriander", "curry powder", "allspice", "clove", "vanilla extract", "mustard powder", "za'atar"],
};

const norm = (s) => String(s ?? "").toLowerCase().trim();

// Pepper is both a vegetable (bell pepper) and a seasoning (ground black pepper) — resolve by
// whether "bell"/a color qualifies it as the vegetable, else default to the seasoning meaning.
function resolvePepper(name) {
  return /bell pepper|red pepper|green pepper|yellow pepper|orange pepper/.test(name) ? "vegetable" : "seasoning";
}

// Return the corrected category for an ingredient name, or null if no override applies (leave the
// model's category as-is).
export function overrideCategory(ingredientName) {
  const name = norm(ingredientName);
  if (/\bpepper\b/.test(name) && !/peppercorn/.test(name)) return resolvePepper(name);
  for (const [category, keywords] of Object.entries(OVERRIDES)) {
    if (keywords.some((k) => name.includes(k))) return category;
  }
  return null;
}
