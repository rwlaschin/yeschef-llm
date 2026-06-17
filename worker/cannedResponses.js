// Canned responses for the fake/test transport (FAKE_TOPIC). A fake job dispatches
// its steps here instead of a model topic; this returns deterministic output per
// subtype, written through the worker's normal Firestore path — no Ollama, no delay.
//
// compliance must emit a terminal status block (@@::PASS::@@) so the worker marks the
// run success, exactly like a real compliance step. Other subtypes return plain text
// (no block → success).

function cannedCompliance() {
  return [
    "## Compliance check",
    "",
    "- ✅ Therapeutic diets meet CMS dietary standards (§483.60).",
    "- ✅ Allergen and restriction controls satisfied.",
    "- ✅ Texture modification validated against IDDSI framework.",
    "- ✅ Sodium and carbohydrate targets within range.",
    "",
    "@@::PASS::@@",
  ].join("\n");
}

function cannedMenuPlan(payload) {
  // The unit prompt (payload.query) carries the rendered diet/meal for this fanout unit.
  const ctx = String(payload?.query || "").slice(0, 120);
  return [
    "```yaml",
    "week: 1",
    "days:",
    "  monday:",
    "    breakfast: Oatmeal with berries",
    "    lunch: Herb-roasted chicken",
    "    dinner: Baked salmon & rice",
    "  tuesday:",
    "    breakfast: Scrambled eggs & toast",
    "    lunch: Lentil & vegetable stew",
    "    dinner: Turkey meatloaf & potatoes",
    "```",
    ctx ? `# unit: ${ctx}` : "",
  ].filter(Boolean).join("\n");
}

function cannedRecipe() {
  return [
    "## Herb-Roasted Chicken",
    "",
    "**Yield:** 100 servings",
    "",
    "### Ingredients",
    "- Boneless chicken thigh — 15 kg",
    "- Olive oil — 1 L",
    "- Fresh thyme & rosemary — 2 bunches",
    "- Low-sodium broth — 5 L",
    "",
    "### Method",
    "1. Season chicken with herbs and a little oil.",
    "2. Roast at 175°C until internal temp reaches 74°C.",
    "3. Rest 5 minutes and portion (blend with warm broth for pureed service).",
  ].join("\n");
}

const BY_SUBTYPE = {
  compliance: cannedCompliance,
  menu_plan:  cannedMenuPlan,
  recipe:     cannedRecipe,
};

export function cannedResponse(subtype, payload = {}) {
  const fn = BY_SUBTYPE[subtype];
  if (fn) return fn(payload);
  // Unknown subtype → a generic, success-shaped stub.
  return `Canned ${subtype || "step"} response.`;
}
