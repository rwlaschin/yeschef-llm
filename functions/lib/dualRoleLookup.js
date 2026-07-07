// Deterministic dual-plating-role lookup — a small, finite, regulation-grounded exception list,
// not an open-ended reasoning problem (unlike allergen-family inference, where a fixed list can't
// generalize to novel grains). These are foods that USDA/institutional meal-pattern rules explicitly
// recognize as counting toward TWO plate components at once:
//   - cheese, yogurt: NSLP meat-alternate qualifying dairy foods -> dairy AND protein
//   - beans, lentils, peas: USDA MyPlate Protein Foods Group explicitly states these count as
//     EITHER the vegetable subgroup OR a protein food -> protein AND vegetable
// A lookup guarantees this split regardless of whether the model (3b dev or 70b prod) reliably
// follows the prompt instruction — code is the right tool for a fixed, known exception list; the
// prompt's own dual-role instruction still covers genuinely novel cases outside this list.
const DUAL_ROLE = {
  cheese: ["dairy", "protein"],
  yogurt: ["dairy", "protein"],
  yoghurt: ["dairy", "protein"],
  beans: ["protein", "vegetable"],
  lentils: ["protein", "vegetable"],
  lentil: ["protein", "vegetable"],
  peas: ["protein", "vegetable"],
  chickpeas: ["protein", "vegetable"],
  garbanzo: ["protein", "vegetable"],
};

const norm = (s) => String(s ?? "").toLowerCase();

// Return the [categoryA, categoryB] pair for an ingredient name, or null if it isn't a known
// dual-role exception. Substring match so "cheddar cheese", "black beans", "green lentils" etc. hit.
export function dualRoleFor(ingredientName) {
  const name = norm(ingredientName);
  for (const [keyword, pair] of Object.entries(DUAL_ROLE)) {
    if (name.includes(keyword)) return pair;
  }
  return null;
}
