// THE CANONICAL SHAPE OF ONE DISH — the single contract both the fake generator and the real prompt
// must satisfy. A recipe is a QUANTITATIVE, REPEATABLE instruction list: measured ingredients, a
// yield and portion, and ordered steps carrying the times and temperatures a cook and an HACCP log
// both need. Anything that cannot be executed twice with the same result is not a recipe.
//
// Every field here maps to what the write path already accepts (RecipeBulkInput / MethodStepInput in
// yeschef/lib/db/neo4jGraphql.ts) — `criticalTempF` and `timeMin` are first-class there and were
// simply never asked for. Fields the write path CANNOT store (yield, allergens, equipment) are
// carried on the dish but must be stripped before a bulk write; see RECIPE_UNWRITABLE.

export const COURSE_KINDS = [
  "entree", "soup", "salad", "starch", "vegetable", "side", "dessert", "beverage", "appetizer",
];
export const COMPONENT_CATEGORIES = [
  "protein", "starch", "vegetable", "fruit", "beverage", "dairy", "fat", "seasoning",
];
// Foodservice volume units appear on real production sheets; converting them would change the
// number a cook reads off the recipe, so they are accepted as written.
export const UNITS = [
  "oz", "lb", "cup", "tbsp", "tsp", "each", "g", "ml", "slice", "portion",
  "fl oz", "gal", "qt", "pt",
];
export const PHASES = ["make_ahead", "on_line"];

// Carried on the dish for the kitchen, but NOT accepted by RecipeBulkInput today. Listed so the
// write path can strip them deliberately rather than 400 on an unknown field.
export const RECIPE_UNWRITABLE = ["yieldPortions", "portionSize", "equipment", "allergens", "nutrition"];

// FDA Food Code hold/cook anchors. A step that cooks, cools, reheats or holds must state its
// temperature — a step saying "cook the chicken through" is not repeatable and is not an HACCP
// record.
export const COOKING_VERBS = /\b(sear|roast|bake|braise|boil|simmer|steam|poach|fry|saut|grill|cook|reheat|chill|cool|hold|thaw)/i;
const PORTION_VERBS = /\b(portion|plate|scoop|ladle|serve|garnish)/i;

// A METHOD STEP IS AN IMPERATIVE, so a cooking INSTRUCTION leads its clause: "Sear the beef…",
// "Hold for hot service…", "Rest 15 minutes. Hold at 135…". The same word inside a noun phrase
// DESCRIBES THE FOOD instead — "Portion 6 oz of braised beef" cooks nothing — and testing the whole
// sentence made every dish whose NAME carries a cooking word fail on its own portioning step
// (`Braised beef with barley`, `Grilled chicken breast`, any roast or bake). Matching at a clause
// start enforces exactly what the rule is for; the dish name is dropped first so an echo of it can
// never lead a clause either. This NARROWS a false positive, not the rule: "Grill the chicken until
// done" still leads its clause and is still caught.
const CLAUSE_START = "(?:^|[.;:!?]\\s*|\\b(?:then|and)\\s+)";
// AN IMPERATIVE IS NEVER INFLECTED. "Cooked rice held below 135 °F is a Bacillus cereus risk" and
// "Braised beef" name a FOOD, not an action, and both can lead a clause — the same false positive
// CLAUSE_START was written for, one step further in. Blocking the -ed/-ing/-d/-s forms drops the
// participles and keeps every imperative, since no imperative carries those endings. This can only
// REMOVE a detection, never add one: a step that genuinely instructs still matches.
const NOT_INFLECTED = "(?!ed\\b|ing\\b|d\\b|s\\b)";
// TIME IS A DIFFERENT QUESTION FROM TEMPERATURE, and only some steps have an answer to it.
//   COOK / REHEAT — temperature, and a time ONLY when there is no temperature. A step that records
//   a criticalTempF has the thermometer as its control and is repeatable without a clock: "reheat
//   to 165 °F for 15 seconds" is a complete HACCP record, and the Food Code publishes exactly that
//   — a temperature and a dwell AT that temperature, never a cooking duration. Demanding minutes on
//   top can only be satisfied by inventing them, and a fabricated clock time is worse than absent:
//   it invites a cook to pull at the timer rather than at the probe. Gate on the FIELD, not on a
//   number in the prose — "Bake at 400 °F convection" is an oven setting, and a step may not buy
//   its way out of the clock by naming a temperature it never records.
//   COOL / CHILL — both numbers, always. Cooling is the one case where the clock IS the standard:
//   135→70 within 2 h and 70→41 within 6 h total (Food Code 3-501.14(A)) is a mandated rate, so a
//   cooling step owes its duration whatever its temperature field says.
//   HOLD / THAW — temperature ONLY. A hold lasts as long as service lasts and a thaw as long as the
//   product takes; neither has a duration to state. Demanding one here forced a fabricated number
//   onto every hold step — the 8 hold steps in dishFixtures carried timeMin values (2, 5, 10, 20,
//   60) that appear nowhere in their own text, invented purely to satisfy this rule. A validator
//   that can only be passed by making a number up is measuring compliance with itself.
const COOKS = new RegExp(`${CLAUSE_START}(?:sear|roast|bake|braise|boil|simmer|steam|poach|fry|saut|grill|cook|reheat|chill|cool)${NOT_INFLECTED}`, "i");
const HOLDS = new RegExp(`${CLAUSE_START}(?:hold|thaw)${NOT_INFLECTED}`, "i");
const COOLS = new RegExp(`${CLAUSE_START}(?:chill|cool)${NOT_INFLECTED}`, "i");
// The dish name is stripped before either test so an echo of it can never lead a clause.
const instructionsIn = (text, name) => {
  const t = String(text ?? "");
  const n = String(name ?? "").trim();
  const stripped = n ? t.split(n).join(" ") : t;
  return { cooks: COOKS.test(stripped), holds: HOLDS.test(stripped), cools: COOLS.test(stripped) };
};

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// Returns [] when the dish is a valid standardized recipe, else one string per defect. Callers treat
// a non-empty array as a failure — there is no "mostly valid".
export function validateDish(d) {
  const e = [];
  const at = (s) => `${d && d.name ? d.name : "(unnamed)"}: ${s}`;
  if (!d || typeof d !== "object") return ["not an object"];

  if (!d.name || typeof d.name !== "string") e.push(at("missing name"));
  if (!COURSE_KINDS.includes(d.kind)) e.push(at(`kind "${d.kind}" is not a course kind`));
  if (!Array.isArray(d.diets) || !d.diets.length) e.push(at("declares no diets"));

  // Yield + portion are what make a recipe scalable to a census; without them the numbers cannot be
  // multiplied or costed.
  if (!isNum(d.yieldPortions) || d.yieldPortions <= 0) e.push(at("missing a positive yieldPortions"));
  if (!d.portionSize) e.push(at("missing portionSize"));

  if (!Array.isArray(d.components) || !d.components.length) e.push(at("has no components"));
  for (const c of d.components ?? []) {
    const w = `component "${c?.ingredient ?? "?"}"`;
    if (!c?.ingredient) e.push(at(`${w} has no ingredient`));
    if (!COMPONENT_CATEGORIES.includes(c?.category)) e.push(at(`${w} category "${c?.category}" invalid`));
    // A quantity of 0 is the tell of a default nobody chose.
    if (!isNum(c?.quantity) || c.quantity <= 0) e.push(at(`${w} has no measured quantity`));
    if (!UNITS.includes(c?.unit)) e.push(at(`${w} unit "${c?.unit}" invalid`));
    if (!c?.prep) e.push(at(`${w} has no prep state`));
    // Seasonings live in their own list; salt hidden among components is invisible to a
    // low-sodium review.
    if (c?.category === "seasoning") e.push(at(`${w} is a seasoning and belongs in seasonings[]`));
  }

  for (const s of d.seasonings ?? []) {
    const w = `seasoning "${s?.ingredient ?? "?"}"`;
    if (!s?.ingredient) e.push(at(`${w} has no ingredient`));
    if (!isNum(s?.quantity) || s.quantity <= 0) e.push(at(`${w} is not measured ("to taste" is not a quantity)`));
    if (!UNITS.includes(s?.unit)) e.push(at(`${w} unit "${s?.unit}" invalid`));
  }

  const steps = Array.isArray(d.method) ? d.method : [];
  // HOW MANY steps a dish takes is a property of the dish, not of the contract. A hot chocolate
  // cinnamon mocha may need five and a chilled fruit cup two; no standardized-recipe practice sets a
  // floor. Only the absence of a method is a defect — everything below tests what the steps SAY.
  if (!steps.length) e.push(at("has no method — nothing to execute"));
  steps.forEach((s, i) => {
    const w = `step ${i}`;
    if (!s?.text) e.push(at(`${w} has no text`));
    if (s?.order !== i) e.push(at(`${w} is out of order (order=${s?.order})`));
    if (!PHASES.includes(s?.phase)) e.push(at(`${w} phase "${s?.phase}" invalid`));
    const { cooks, holds, cools } = instructionsIn(s?.text, d?.name);
    if (cooks || holds) {
      if (!isNum(s?.criticalTempF)) e.push(at(`${w} cooks or holds but states no criticalTempF`));
      // A cook owes a time only when it records no temperature — with neither, nothing controls it.
      // Cooling owes both: 3-501.14(A) mandates the rate, not just the endpoint.
      if (cooks && !isNum(s?.timeMin) && (cools || !isNum(s?.criticalTempF))) {
        e.push(at(`${w} cooks but states no timeMin`));
      }
    }
  });
  // make_ahead work precedes service work, so a cook reading top-to-bottom is never sent backwards.
  const firstOnLine = steps.findIndex((s) => s?.phase === "on_line");
  if (firstOnLine >= 0 && steps.slice(firstOnLine).some((s) => s?.phase === "make_ahead")) {
    e.push(at("make_ahead step appears after an on_line step"));
  }
  if (firstOnLine < 0) e.push(at("has no on_line step — nothing happens at service"));
  if (steps.length && !PORTION_VERBS.test(steps[steps.length - 1]?.text ?? "")) {
    e.push(at("does not end by portioning or plating"));
  }
  return e;
}

// A DISH, not a meal and not an ingredient. Both failures shipped: "Margarine" as a side, and
// "breakfast" as a thing with a recipe.
export function validateIsSingleDish(d) {
  const e = [];
  const name = String(d?.name ?? "");
  if (/\b(breakfast|lunch|dinner|supper|tray|meal|plate\b.*\band\b)/i.test(name)) {
    e.push(`${name}: reads as a meal, not a single dish`);
  }
  // The name must say how it is prepared — a bare commodity is an ingredient.
  const bare = (d?.components ?? []).some((c) => String(c?.ingredient ?? "").toLowerCase() === name.toLowerCase());
  if (bare) e.push(`${name}: is a bare ingredient, not a prepared dish`);
  return e;
}

export const validateRecipe = (d) => [...validateDish(d), ...validateIsSingleDish(d)];
