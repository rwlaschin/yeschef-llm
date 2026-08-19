import { test } from "node:test";
import assert from "node:assert/strict";
import { cannedResponse } from "./cannedResponses.js";

const CTX = { meals: ["breakfast", "lunch", "dinner"], days: 3 };
// The exact nutrients contract — plan_library instruction + seed-recipes-nutrients.mjs.
const NUTRIENTS_HEADER = "Day | Mealtime | Calories | Protein g | Sodium mg | Carbs g";
const nut = (diet) => cannedResponse("nutrients", { item: diet, ctx: CTX });

test("nutrients emits the exact 4-column contract header", () => {
  assert.equal(nut("standard").split("\n")[0], NUTRIENTS_HEADER);
});

test("nutrients rows are all numeric in every column", () => {
  const rows = nut("standard").split("\n").slice(1);
  assert.equal(rows.length, CTX.days * CTX.meals.length);
  for (const r of rows) {
    const cols = r.split("|").map((c) => c.trim());
    assert.equal(cols.length, 6); // Day, Mealtime, + 4 numeric
    for (const n of cols.slice(2)) assert.ok(/^\d+$/.test(n), `non-numeric: "${n}" in "${r}"`);
  }
});

test("nutrients returns a DISTINCT table per diet — no two collapse", () => {
  // The regression: diets sharing coefficients used to emit byte-identical tables.
  const diets = ["standard", "gluten-free", "vegetarian", "lactose-free", "renal", "low-sodium", "diabetic"];
  const tables = diets.map(nut);
  assert.equal(new Set(tables).size, diets.length, "some diets returned identical tables");
});

test("nutrients honors diet shaping (renal ↓ sodium & protein vs standard)", () => {
  const cell = (diet, i) => Number(nut(diet).split("\n")[2].split("|")[i].trim()); // day1 lunch row
  assert.ok(cell("renal", 4) < cell("standard", 4), "renal sodium not reduced");
  assert.ok(cell("renal", 3) < cell("standard", 3), "renal protein not reduced");
  assert.ok(cell("diabetic", 5) < cell("standard", 5), "diabetic carbs not reduced");
});

test("nutrients is deterministic — same input, same output", () => {
  assert.equal(nut("renal"), nut("renal"));
});

test("unknown subtype falls back to a generic stub", () => {
  assert.match(cannedResponse("wat", {}), /Canned wat response/);
});

test("planner returns a parseable YAML step routed back to the fake topic", () => {
  const out = cannedResponse("planner", {});
  assert.match(out, /```yaml/);
  assert.match(out, /subtype: task/);
});

test("compliance emits the terminal PASS block", () => {
  assert.match(cannedResponse("compliance", {}), /@@::PASS::@@/);
});

test("menu_plan echoes the unit context and yields a week of days", () => {
  const out = cannedResponse("menu_plan", { query: "regular / breakfast" });
  assert.match(out, /```yaml/);
  assert.match(out, /# unit: regular \/ breakfast/);
});

test("vegan pools stay meat-free across every course row", () => {
  const veganCtx = { item: "vegan", ctx: CTX };
  const grid = cannedResponse("protein_grid", veganCtx);
  const recipes = cannedResponse("recipes", veganCtx);
  assert.equal(grid.split("\n")[0], "Day | Mealtime | Type | Cut");
  assert.doesNotMatch(grid + recipes, /Chicken|Beef|Pork|Salmon|Turkey|Cod/);
  assert.doesNotMatch(JSON.stringify(JSON.parse(cannedResponse("recipe", { item: "vegan", query: "" }))), /Chicken|Beef|Pork|Salmon|Turkey|Cod/);
});

test("recipe with target lines returns a strict JSON array of canonical recipes", () => {
  const query = "1. Tofu — cut: firm, diet: vegan, mealtime: lunch";
  const out = cannedResponse("recipe", { item: "vegan", query });
  assert.equal(typeof out, "string");
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed) && parsed.length > 0);
  for (const r of parsed) {
    assert.equal(typeof r.name, "string");
    assert.ok(Array.isArray(r.components));
    assert.ok(Array.isArray(r.method), "canonical recipes carry their method");
    assert.equal(typeof r.nutrition, "object");
  }
});

test("recipe echoes the proteinType requested in the prompt, multi-word included", () => {
  const query = "Suggest one recipe. Respond with ONLY a JSON array.\n\n1. Greek yogurt — cut: plain, diet: regular, mealtime: breakfast";
  const parsed = JSON.parse(cannedResponse("recipe", { query }));
  for (const r of parsed) assert.equal(r.proteinType, "Greek yogurt");
});

test("recipe builds the recipe FROM the requested protein — body matches, not just the label", () => {
  const query = "1. Greek yogurt — cut: plain, diet: regular, mealtime: breakfast";
  const r = JSON.parse(cannedResponse("recipe", { query }))[0];
  const protein = r.components.find((c) => c.category === "protein");
  assert.equal(protein.ingredient, "Greek yogurt", "protein component must be the requested protein, not a foreign pool row");
  assert.match(r.name.toLowerCase(), /yogurt/);
});

test("recipe directions-style query returns a single recipe whose method derives from its own components", () => {
  // Mirrors buildDirectionsPrompt: dish name + one "<prep> <ingredient>" line per component.
  const query = "Yogurt bowl\nportioned Greek yogurt\ncooked Granola\nfresh Mango";
  const r = JSON.parse(cannedResponse("recipe", { query }));
  assert.equal(r.name, "Yogurt bowl", "directions response is the requested dish");
  assert.ok(Array.isArray(r.method) && r.method.length > 0);
  const text = r.method.map((s) => s.text).join(" ").toLowerCase();
  assert.match(text, /greek yogurt/, "steps reference the recipe's protein");
  assert.doesNotMatch(text, /spinach|broccoli/, "steps must not mention a vegetable the breakfast recipe never had");
});

test("recipe method steps are strict {text, phase, order} covering both phases", () => {
  const r = JSON.parse(cannedResponse("recipe", { item: "vegan", query: "" }));
  assert.ok(Array.isArray(r.method) && r.method.length > 0);
  const phases = new Set(["make_ahead", "on_line"]);
  for (const s of r.method) {
    assert.equal(typeof s.text, "string");
    assert.ok(s.text.length > 0);
    assert.ok(phases.has(s.phase), `bad phase: "${s.phase}"`);
    assert.equal(typeof s.order, "number");
  }
  // must cover both phases — make-ahead prep + on-line service
  const seen = new Set(r.method.map((s) => s.phase));
  assert.ok(seen.has("make_ahead") && seen.has("on_line"), "both phases present");
});

// ── recipes step is SEEDED from the proteins grid (Bug fix: recipes ignored the grid) ──────────
// payload.ctx.proteins carries the grid's per-slot proteins (normDiet → day → mealtime → {type,cut}).
// cannedRecipes must emit each slot's recipe FROM that protein so recipes MIRROR the proteins grid.
const recipeRows = (out) => out.split("\n").slice(1).map((l) => l.split("|").map((c) => c.trim()));
const proteinAt = (out, day, meal) => {
  const row = recipeRows(out).find((c) => c[0] === `Day ${day}` && c[1] === meal);
  // The protein is no longer its own column — it is the protein-tagged entry in Components.
  return row ? (((row[5] || "").split(";").find((x) => /:\s*protein\s*$/i.test(x)) || "").split(":")[0].trim() || null) : null;
};
const dishAt = (out, day, meal) => {
  const row = recipeRows(out).find((c) => c[0] === `Day ${day}` && c[1] === meal);
  return row ? row[2] : null;
};

test("recipes seeded from the grid emit each slot's assigned protein (mirrors the grid)", () => {
  const proteins = { "diet1": {
    1: { breakfast: { type: "Greek yogurt" }, lunch: { type: "Turkey", cut: "breast" }, dinner: { type: "Cod", cut: "fillet" } },
    2: { breakfast: { type: "Pork Loin", cut: "smoked" } },
  } };
  const out = cannedResponse("recipes", { item: "diet 1", ctx: { meals: ["breakfast", "lunch", "dinner"], days: 2, proteins } });
  assert.equal(proteinAt(out, 1, "breakfast"), "Greek yogurt");   // the reported bug: was "Baked cod"
  assert.equal(proteinAt(out, 1, "lunch"), "Turkey");
  assert.equal(proteinAt(out, 1, "dinner"), "Cod");
  assert.equal(proteinAt(out, 2, "breakfast"), "Pork Loin");
  // dish reflects the grid protein (Greek yogurt → the yogurt-bowl pool row)
  assert.match(dishAt(out, 1, "breakfast"), /yogurt/i);
});

test("recipes seed matches the unit's diet even when item is null (single-diet grid)", () => {
  const proteins = { "diet1": { 1: { breakfast: { type: "Greek yogurt" } } } };
  const out = cannedResponse("recipes", { item: null, ctx: { meals: ["breakfast"], days: 1, proteins } });
  assert.equal(proteinAt(out, 1, "breakfast"), "Greek yogurt");
});

test("recipes fall back to the diet pool when no grid proteins are provided", () => {
  const out = cannedResponse("recipes", { item: "vegan", ctx: { meals: ["breakfast"], days: 1 } });
  const p = proteinAt(out, 1, "breakfast");
  assert.ok(["Tofu", "Lentil", "Chickpea", "Black bean", "Tempeh", "Quinoa", "Edamame", "Seitan"].includes(p), `vegan pool protein, got "${p}"`);
});

const HEADER6 = "Day | Mealtime | Dish | Kind | Diets | Components";
// 0 Day | 1 Mealtime | 2 Dish | 3 Kind | 4 Diets | 5 Components
const KIND = 3, DIETS = 4, COMPONENTS = 5;
// Ingredients live in Components alone now, as `name:category` pairs.
const ingredientsOf = (cell) => (cell || "").split(";").map((x) => x.split(":")[0].trim()).filter(Boolean);

test("every emitted dish is a prepared dish, never a bare ingredient", () => {
  const ctx = { meals: ["lunch"], days: 1, courseCounts: { entree: 1, soup: 1, starch: 1, vegetable: 1, side: 2, dessert: 1 } };
  const rows = cannedResponse("courses", { item: "regular", ctx }).split("\n").slice(1)
    .map((l) => l.split("|").map((c) => c.trim()));
  for (const c of rows) {
    const dish = c[2];
    if (c[KIND] === "beverage" && c[COMPONENTS] === `${c[2]}:beverage`) continue;
    for (const raw of ingredientsOf(c[COMPONENTS])) {
      assert.notEqual(dish.toLowerCase(), raw.toLowerCase(), `"${dish}" is a bare ingredient, not a dish`);
    }
    assert.doesNotMatch(dish, /^Buttered barley$/i, "a raw grain is not plated");
  }
  const names = rows.map((c) => c[2]);
  assert.equal(new Set(names).size, names.length, "no dish is served twice in one slot");
});

test("soups are named dishes, not `<vegetable> soup`", () => {
  const ctx = { meals: ["lunch"], days: 1, courseCounts: { soup: 1 } };
  for (const diet of ["regular", "vegan", "vegetarian"]) {
    const row = cannedResponse("courses", { item: diet, ctx }).split("\n")[1].split("|").map((c) => c.trim());
    assert.doesNotMatch(row[2], /^(pea|green beans|carrot|zucchini|mushroom) soup$/i,
      `"${row[2]}" is an ingredient with the word soup after it`);
    assert.match(row[2], /soup|bisque|chowder/i);
  }
});

test("no dish is a bare pool ingredient and barley is never plated as a starch", () => {
  const ctx = { meals: ["lunch"], days: 1 };
  for (const diet of ["regular", "vegan", "vegetarian", "renal"]) {
    const rows = cannedResponse("courses", { item: diet, ctx }).split("\n").slice(1)
      .map((l) => l.split("|").map((c) => c.trim()));
    for (const c of rows) {
      assert.doesNotMatch(c[2], /^barley$/i, "barley is not plated");
      // A drink IS its ingredient (`Coffee` / `Coffee:beverage`) — but only in exactly that form.
      if (c[KIND] === "beverage" && c[COMPONENTS] === `${c[2]}:beverage`) continue;
      for (const raw of ingredientsOf(c[COMPONENTS])) {
        assert.notEqual(c[2].toLowerCase(), raw.toLowerCase(), `"${c[2]}" is a bare ingredient`);
      }
    }
  }
});

// ── the dish model: a course is its own dish, daypart-aware, declaring its own diets ────────────
// Every kind at once, so nothing hides behind a template that never configures it.
const ALL_KINDS = { appetizer: 1, soup: 2, salad: 1, entree: 1, starch: 1, vegetable: 1, side: 2, dessert: 1, beverage: 1 };
const allRows = (subtype, diet, meals, days = 3, courseCounts = ALL_KINDS) =>
  cannedResponse(subtype, { item: diet, ctx: { meals, days, courseCounts } })
    .split("\n").slice(1).map((l) => l.split("|").map((c) => c.trim()));

// Plant milks carry the word "milk" but no animal; strip them before looking for one.
const ANIMAL = /\b(beef|pork|lamb|veal|chicken|turkey|duck|salmon|cod|tilapia|fish|shrimp|bacon|sausage|ham|eggs?|butter|buttered|buttermilk|cheese|yogurt|paneer|gelatin|honey|cream|milk|whey|lard|gravy|ranch|tartar)\b/i;
const animalFree = (s) => !ANIMAL.test(String(s).replace(/\b(soy|rice|oat|almond|coconut)\s+milk\b/gi, ""));

test("a vegan slot carries no animal product on ANY row — dish, components and drinks alike", () => {
  // The guarantee the pools existed for, now that every course is its own dish rather than a string
  // spun off the entrée: it has to hold for the whole slot, not just the entrée row.
  for (const meals of [["breakfast"], ["lunch"], ["dinner"], ["breakfast", "lunch", "dinner"]]) {
    for (const subtype of ["recipes", "courses"]) {
      for (const row of allRows(subtype, "vegan", meals)) {
        for (const cell of row) {
          assert.ok(animalFree(cell), `vegan ${subtype} row carries an animal product: "${row.join(" | ")}"`);
        }
      }
    }
  }
});

test("vegetarian slots carry no meat, poultry or seafood on any row", () => {
  const FLESH = /\b(beef|pork|lamb|veal|chicken|turkey|duck|salmon|cod|tilapia|fish|shrimp|bacon|sausage|ham|gelatin|gravy)\b/i;
  for (const subtype of ["recipes", "courses"]) {
    for (const row of allRows(subtype, "vegetarian", ["breakfast", "lunch", "dinner"])) {
      for (const cell of row) assert.doesNotMatch(cell, FLESH, `vegetarian row: "${row.join(" | ")}"`);
    }
  }
});

test("breakfast is its own daypart — no dinner dish lands on a breakfast tray", () => {
  const DINNER_ONLY = /\b(egg noodles|barley|couscous|farro|wild rice|mashed potatoes|pilaf|stew|meatloaf|brisket|schnitzel|tagine|kebab)\b/i;
  for (const diet of ["standard", "vegan", "vegetarian", "renal", "diabetic", "low-sodium"]) {
    for (const subtype of ["recipes", "courses"]) {
      for (const row of allRows(subtype, diet, ["breakfast"], 7)) {
        assert.doesNotMatch(row.join(" "), DINNER_ONLY, `${diet} breakfast row: "${row.join(" | ")}"`);
      }
    }
  }
});

// ── a dish DECLARES the diets it satisfies ──────────────────────────────────────────────────────
// The `Diets` column is the whole fix for "hovering a card highlights no diet": the frontend used to
// INFER a dish's diets by comparing dish names across diets, and since every diet's build names its
// dishes differently, nothing ever matched. Diets is APPENDED after Kind so index readers of the
// original eight columns are unaffected.
const cols = (out) => out.split("\n").slice(1).map((l) => l.split("|").map((c) => c.trim()));
const KEYS = ["standard", "diabetic", "low-sodium", "renal", "gluten-free", "vegetarian", "vegan", "low-fat", "lactose-free"];

test("recipes emits the entrée only, on the six-column header", () => {
  const out = cannedResponse("recipes", { item: "regular", ctx: { meals: ["lunch"], days: 1 } });
  const [header, ...rows] = out.split("\n");
  assert.equal(header, HEADER6, "no positional ingredient columns — Components carries the ingredients");
  const cells = rows.map((l) => l.split("|").map((c) => c.trim()));
  assert.equal(cells.length, 1, "one lunch slot yields exactly one entrée row");
  assert.equal(cells[0][KIND], "entree");
  assert.equal(cells[0][2], "Beef stew");
  assert.equal(cells[0][COMPONENTS], "Beef:protein; Carrot:vegetable; Beef stock:seasoning",
    "the entrée states its own protein first, then what is cooked with it");
});

test("courses emits every position except the entrée, on the same six columns", () => {
  const out = cannedResponse("courses", { item: "regular", ctx: { meals: ["lunch"], days: 1 } });
  const [header, ...rows] = out.split("\n");
  assert.equal(header, HEADER6);
  const cells = rows.map((l) => l.split("|").map((c) => c.trim()));
  assert.ok(!cells.some((c) => c[KIND] === "entree"), "courses never repeats the entrée");
  assert.equal(cells[0][KIND], "appetizer", "the first course row is the appetizer position");
  for (const c of cells) { assert.equal(c[0], "Day 1"); assert.equal(c[1], "lunch"); }
});

test("every row declares at least one real diet key, and the unit's own diet is among them", () => {
  for (const diet of KEYS) {
    for (const meal of ["breakfast", "lunch", "dinner"]) {
      for (const subtype of ["recipes", "courses"]) {
        for (const c of allRows(subtype, diet, [meal], 3)) {
          const declared = c[DIETS].split(",").map((s) => s.trim()).filter(Boolean);
          assert.ok(declared.length, `no declared diets: "${c.join(" | ")}"`);
          for (const d of declared) assert.ok(KEYS.includes(d), `"${d}" is not a diet key`);
          assert.ok(declared.includes(diet), `a ${diet} row is not declared for ${diet}: "${c.join(" | ")}"`);
        }
      }
    }
  }
});

test("a dish shared across diets declares the same diets wherever it is served", () => {
  // The property the underline depends on: two diets served the same dish must agree about who it
  // serves, or the segments would differ card to card for one dish.
  const byName = new Map();
  for (const diet of KEYS) {
    for (const meal of ["breakfast", "lunch", "dinner"]) {
      for (const c of allRows("courses", diet, [meal], 5)) {
        const prev = byName.get(c[2]);
        if (prev) assert.equal(c[DIETS], prev, `"${c[2]}" declares different diets on different trays`);
        else byName.set(c[2], c[DIETS]);
      }
    }
  }
});

test("an entrée is ONE DISH — one entree row per slot, stating its own protein", () => {
  // The double-starch bug was the entrée row carrying the pool row's starch in a positional column
  // while a starch COURSE was served beside it. With no positional columns the entrée states only
  // its own recipe, and a starch on the tray is a row of its own with Kind `starch`.
  for (const diet of ["standard", "diabetic", "renal", "vegan"]) {
    for (const meal of ["breakfast", "lunch", "dinner"]) {
      for (const c of allRows("recipes", diet, [meal], 7)) {
        assert.equal(c[KIND], "entree");
        const cats = (c[COMPONENTS] || "").split(";").map((x) => (x.split(":")[1] || "").trim().toLowerCase()).filter(Boolean);
        assert.ok(cats.includes("protein"), `entrée states no protein: "${c.join(" | ")}"`);
        assert.ok(!cats.includes("starch") || cats.filter((x) => x === "starch").length === 1,
          `entrée names two starches: "${c.join(" | ")}"`);
      }
    }
  }
});

test("a service configured for two entrées gets two DIFFERENT entrées", () => {
  for (const diet of ["standard", "diabetic", "vegan", "renal"]) {
    for (const meal of ["breakfast", "lunch", "dinner"]) {
      const rows = allRows("recipes", diet, [meal], 3, { entree: 2 });
      const bySlot = new Map();
      for (const r of rows) {
        const k = `${r[0]}|${r[1]}`;
        bySlot.set(k, [...(bySlot.get(k) ?? []), r[2]]);
      }
      for (const [slot, names] of bySlot) {
        assert.equal(names.length, 2, `${diet} ${slot} emitted ${names.length} entrées, not 2`);
        assert.notEqual(names[0], names[1], `${diet} ${slot} serves the same entrée twice`);
      }
    }
  }
});

test("a sauce is served only beside a dish it belongs to — never tartar sauce with a stew", () => {
  const SAUCES = ["Gravy", "Tartar sauce", "Cranberry sauce", "Sour cream", "Ranch dressing"];
  const FISH = /cod|tilapia|salmon|fish|lox|cakes/i;
  let sauced = 0;
  for (const diet of KEYS) {
    for (const meal of ["breakfast", "lunch", "dinner"]) {
      for (let days = 1; days <= 7; days++) {
        const ctx = { meals: [meal], days, courseCounts: { entree: 1, side: 2 } };
        const rows = cols(cannedResponse("recipes", { item: diet, ctx }))
          .concat(cols(cannedResponse("courses", { item: diet, ctx })));
        const bySlot = new Map();
        for (const r of rows) {
          const k = `${r[0]}|${r[1]}`;
          bySlot.set(k, [...(bySlot.get(k) ?? []), r]);
        }
        for (const [, slot] of bySlot) {
          const entree = slot.find((r) => r[KIND] === "entree")?.[2] ?? "";
          const sauces = slot.filter((r) => SAUCES.includes(r[2])).map((r) => r[2]);
          assert.ok(sauces.length <= 1, `${diet} ${meal} serves ${sauces.length} sauces beside "${entree}"`);
          for (const s of sauces) {
            sauced++;
            if (s === "Tartar sauce") assert.match(entree, FISH, `tartar sauce beside "${entree}"`);
            if (s === "Gravy") assert.match(entree, /roast|meatloaf|schnitzel|loin|brisket|patty|hash/i, `gravy beside "${entree}"`);
            if (s === "Cranberry sauce") assert.match(entree, /turkey|roast chicken/i, `cranberry sauce beside "${entree}"`);
          }
        }
      }
    }
  }
  assert.ok(sauced > 0, "no sauce was ever served — the pairing rule cannot be exercised");
});

// ── ONE DISH, ONE NAME: the entrée catalogue is shared, not per-diet ─────────────────────────────
// The reported bug: one breakfast cell offered "Egg scramble", "Egg & veggie scramble" and "Plain
// egg scramble" as three dishes. They were one dish, reworded once per diet, because the entrée
// pools were keyed BY DIET. Every entrée a diet can be served, at both dayparts — 30 days covers
// the whole rotation of either catalogue.
const entreeNames = (meal) => {
  const names = new Map(); // dish → {protein, diets}, so drift across diets/dayparts shows up
  for (const diet of [...KEYS, "halal", "kosher"]) {
    for (const c of allRows("recipes", diet, [meal], 30, { entree: 2 })) names.set(c[2], { protein: ingredientsOf(c[COMPONENTS])[0], diets: c[DIETS] });
  }
  return names;
};
const ALL_ENTREES = () => new Map([...entreeNames("breakfast"), ...entreeNames("lunch"), ...entreeNames("dinner")]);

test("one scrambled-egg dish and one yogurt dish exist, not one per diet", () => {
  // Keyed on the PROTEIN, not the wording: "Tofu scramble" is a different dish, "Plain egg
  // scramble" was the same one wearing a diet's name.
  const of = (protein, re) => [...ALL_ENTREES()].filter(([n, v]) => v.protein === protein && re.test(n)).map(([n]) => n);
  assert.deepEqual(of("Egg", /scrambl/i), ["Scrambled eggs"], "more than one scrambled-egg dish");
  assert.deepEqual(of("Greek yogurt", /./), ["Yogurt parfait"], "more than one yogurt dish");
});

test("no entrée name carries a diet word — a diet is declared, never spelled into the name", () => {
  const DIET_WORD = /\b(plain|unsalted|no[- ]added[- ]salt|no[- ]salt|low[- ]sodium|salt[- ]free|sugar[- ]free|gluten[- ]free|certified|gf|diabetic|renal|vegan|vegetarian|low[- ]fat|lactose[- ]free)\b/i;
  for (const name of ALL_ENTREES().keys()) {
    assert.doesNotMatch(name, DIET_WORD, `"${name}" spells a diet into the dish name`);
  }
});

test("an entrée name is a DISH, never a dish plus the side beside it", () => {
  // "Pork & chickpeas" is an entrée and a side sharing one name. A compound name is allowed only
  // where the second item is cooked INTO the dish and the kitchen plates it as one thing.
  const COOKED_IN = ["Ham and cheese omelet"];
  for (const name of ALL_ENTREES().keys()) {
    assert.doesNotMatch(name, /&/, `"${name}" joins two servable items with &`);
    if (/ and /i.test(name)) assert.ok(COOKED_IN.includes(name), `"${name}" reads as a dish plus its side`);
  }
});

test("an entrée dish declares the SAME diets on every tray and at every daypart", () => {
  // One dish means one declaration. Two rows of one dish disagreeing is the per-diet pool bug
  // growing back, whatever the names say.
  const seen = new Map();
  for (const meal of ["breakfast", "lunch", "dinner"]) {
    for (const [name, { diets }] of entreeNames(meal)) {
      const prev = seen.get(name);
      if (prev) assert.equal(diets, prev, `"${name}" declares different diets on different trays`);
      else seen.set(name, diets);
    }
  }
});

test("a canned recipe is a DISH, not a plate — its components are its own", () => {
  // Replaces "recipe is mealtime-aware". The user opened "Egg scramble" and found Egg + Toast +
  // Mushroom + Banana: a MEAL. Toast and a banana are dishes at their own course positions.
  const r = JSON.parse(cannedResponse("recipe", { item: "standard", query: "1. Egg — cut: scrambled, diet: standard, mealtime: breakfast" }))[0];
  assert.equal(r.name, "Scrambled eggs");
  const ingredients = r.components.map((c) => c.ingredient.toLowerCase());
  assert.equal(ingredients[0], "egg", "the dish leads with its own protein");
  for (const plated of ["toast", "bread", "mushroom", "banana", "granola", "orange", "hash brown"]) {
    assert.ok(!ingredients.some((i) => i.includes(plated)), `"${plated}" is plated beside the dish, not cooked into it: ${ingredients.join(", ")}`);
  }
  // The guarantee the deprecated test really protected: yogurt never lands next to spinach.
  const y = JSON.parse(cannedResponse("recipe", { query: "1. Greek yogurt — cut: , diet: regular, mealtime: breakfast" }))[0];
  assert.doesNotMatch(y.summary.toLowerCase(), /spinach|broccoli/);
  assert.ok(!y.components.some((c) => c.category === "vegetable"), "a yogurt parfait has no vegetable in it");
});

test("every diet is offered at least two entrées at every daypart", () => {
  // A one-dish set makes a two-entrée service print the same dish twice, and makes a week of menus
  // the same dish seven times. The collapse must not thin a diet below a real choice.
  const thin = [];
  for (const diet of [...KEYS, "halal", "kosher"]) {
    for (const meal of ["breakfast", "lunch", "dinner"]) {
      const names = new Set([...entreeNames(meal).keys()].filter(Boolean));
      const own = new Set(allRows("recipes", diet, [meal], 30, { entree: 2 }).map((c) => c[2]));
      if (own.size < 2) thin.push(`${diet}/${meal} → ${[...own].join(", ")} (of ${names.size})`);
    }
  }
  assert.deepEqual(thin, [], `fewer than two entrées for:\n${thin.join("\n")}`);
});

test("the chef's count decides how many positions a kind gets, drinks included", () => {
  const kindsOf = (t) => {
    const k = t.split("\n")[0].split("|").map((c) => c.trim()).indexOf("Kind");
    return cols(t).map((c) => c[k]);
  };
  const ctx = { meals: ["lunch"], days: 1, courseCounts: { entree: 1, soup: 2, side: 2, dessert: 1, beverage: 2 } };
  const rest = kindsOf(cannedResponse("courses", { item: "standard", ctx }));
  assert.equal(rest.filter((k) => k === "beverage").length, 2, "asking for 2 beverages yields 2, not the whole set");
  assert.equal(rest.filter((k) => k === "soup").length, 2);
  assert.equal(rest.filter((k) => k === "side").length, 2);
  assert.ok(!rest.includes("entree"), "courses never repeats the entrée");

  const one = kindsOf(cannedResponse("courses", { item: "standard", ctx: { ...ctx, courseCounts: { beverage: 1 } } }));
  assert.deepEqual(one, ["beverage"], "one drink means one row");
});

test("repeated positions are different dishes", () => {
  const ctx = { meals: ["lunch"], days: 1, courseCounts: { soup: 2, side: 2, beverage: 2 } };
  const rows = cols(cannedResponse("courses", { item: "standard", ctx }));
  for (const kind of ["soup", "side", "beverage"]) {
    const names = rows.filter((c) => c[KIND] === kind).map((c) => c[2]);
    assert.ok(names.length, `${kind} emitted no rows at all`);
    assert.equal(new Set(names).size, names.length, `${kind} repeats the same dish: ${names.join(" + ")}`);
  }
});

// ── recipe_detail ───────────────────────────────────────────────────────────────────────────────
// The detail step fans over the recipes/courses ROWS, so a unit is handed one row as `item`. These
// assert the emitted TEXT contract (the `Recipe Detail system` form, which recipeShared.ts
// parseRecipeDetails reads); the dish contract itself is recipeTemplate.js's, tested there.
const HEADER_CELLS = ["Day", "Mealtime", "Dish", "Kind", "Diets", "Components"];
const asRow = (cells) => Object.fromEntries(HEADER_CELLS.map((h, i) => [h, cells[i] ?? ""]));
const detailOf = (row) => cannedResponse("recipe_detail", { item: row, ctx: {} });
const taggedLines = (out, tag) => out.split("\n").filter((l) => l.startsWith(`${tag}: `)).map((l) => l.slice(tag.length + 2).split("|").map((c) => c.trim()));
const ENTREE_ROW = asRow(["Day 1", "lunch", "Beef stew", "entree", "standard", "Beef:protein; Carrot:vegetable; Beef stock:seasoning"]);
const SIDE_ROW = asRow(["Day 1", "lunch", "Coleslaw", "side", "standard", "Cabbage:vegetable"]);

test("recipe_detail writes ONE block for the row's own dish, named exactly as the row names it", () => {
  const out = detailOf(ENTREE_ROW);
  assert.equal(out.split("\n").filter((l) => l.startsWith("DISH: ")).length, 1, "one dish per unit");
  assert.equal(out.split("\n")[0], "DISH: Beef stew", "the block opens with the row's dish name");
  assert.match(out, /^YIELD: \d+$/m);
  assert.match(out, /^PORTION: .+$/m);
});

test("recipe_detail measures the row's OWN ingredients, seasonings split out of the components", () => {
  const comps = taggedLines(detailOf(ENTREE_ROW), "COMPONENT");
  assert.deepEqual(comps.map((c) => c[0]), ["Beef", "Carrot"], "the row's ingredients, in the row's order");
  for (const [, category, quantity, unit, prep] of comps) {
    assert.notEqual(category, "seasoning", "a seasoning is never a component");
    assert.ok(Number(quantity) > 0, `unmeasured component: ${quantity}`);
    assert.ok(unit && prep, "every component states a unit and a prep state");
  }
  assert.deepEqual(taggedLines(detailOf(ENTREE_ROW), "SEASONING").map((s) => s[0]), ["Beef stock"]);
  for (const [, quantity, unit] of taggedLines(detailOf(ENTREE_ROW), "SEASONING")) {
    assert.ok(Number(quantity) > 0 && unit, "'to taste' is not a quantity");
  }
});

test("recipe_detail steps are ordered, temperature-bearing, and end by portioning", () => {
  for (const row of [ENTREE_ROW, SIDE_ROW]) {
    const steps = taggedLines(detailOf(row), "STEP");
    assert.ok(steps.length >= 5, `${row.Dish}: fewer than five steps`);
    const phases = steps.map((s) => s[0]);
    for (const p of phases) assert.ok(["make_ahead", "on_line"].includes(p), `bad phase "${p}"`);
    assert.ok(phases.includes("on_line"), `${row.Dish}: nothing happens at service`);
    assert.ok(!phases.slice(phases.indexOf("on_line")).includes("make_ahead"), `${row.Dish}: a cook is sent backwards`);
    for (const [, , tempF, text] of steps) {
      // A step that cooks, chills or holds owes the temperature that controls it.
      if (/^(cook|chill|cool|hold|thaw|sear|roast|bake|braise|steam)/i.test(text)) {
        assert.match(tempF, /^\d+$/, `${row.Dish}: "${text}" states no criticalTempF`);
      }
      assert.ok(!text.includes("|"), "step text never carries a pipe");
    }
    assert.match(steps[steps.length - 1][3], /^Portion /, `${row.Dish}: does not end by portioning`);
  }
});

test("a fake side is not a fake entrée — the detail is written from the dish it was given", () => {
  const entree = detailOf(ENTREE_ROW);
  const side = detailOf(SIDE_ROW);
  assert.notEqual(entree, side);
  assert.match(entree, /STEP: on_line \| - \| 135 \|/, "a hot course is hot-held at 135");
  assert.match(side, /STEP: make_ahead \| \d+ \| 41 \|/, "a cold course is chilled to 41");
  assert.doesNotMatch(side, /135/, "a cold side is never hot-held");
});

test("every dish a canned build names gets a detail block for THAT dish", () => {
  const ctx = { meals: ["lunch"], days: 1, courseCounts: { entree: 1, soup: 1, salad: 1, side: 2, dessert: 1 } };
  for (const subtype of ["recipes", "courses"]) {
    for (const cells of cols(cannedResponse(subtype, { item: { diet: "standard", day: 1 }, ctx }))) {
      const row = asRow(cells);
      const out = cannedResponse("recipe_detail", { item: row, ctx });
      assert.equal(out.split("\n")[0], `DISH: ${row.Dish}`, `detail renamed "${row.Dish}"`);
      assert.ok(taggedLines(out, "COMPONENT").length, `"${row.Dish}" has no measured components`);
    }
  }
});

// ── one tray, one dish: pools OVERLAP across positions ──────────────────────────────────────────
// Measured over 9 diets × 3 dayparts × 14 days: 44 slots served one dish twice, because the
// salad/side and starch/side pools share entries (`Coleslaw` is both a salad and a side, `Dinner
// roll` both a starch and a side). A tray that offers the same dish at two positions is one dish
// short, not a menu.
test("no slot serves the same dish at two positions, across every diet and daypart", () => {
  const positions = { entree: 1, appetizer: 1, soup: 1, salad: 1, starch: 1, vegetable: 1, side: 2, dessert: 1 };
  const clashes = [];
  for (const diet of KEYS) {
    for (const meal of ["breakfast", "lunch", "dinner"]) {
      const ctx = { meals: [meal], days: 14, courseCounts: positions };
      const rows = cols(cannedResponse("recipes", { item: diet, ctx }))
        .concat(cols(cannedResponse("courses", { item: diet, ctx })));
      const bySlot = new Map();
      for (const r of rows) bySlot.set(`${r[0]}|${r[1]}`, [...(bySlot.get(`${r[0]}|${r[1]}`) ?? []), r[2]]);
      for (const [slot, names] of bySlot) {
        if (new Set(names).size !== names.length) clashes.push(`${diet} ${slot}: ${names.join(" + ")}`);
      }
    }
  }
  assert.deepEqual(clashes, [], `${clashes.length} slot(s) serve one dish twice`);
});

// A position asked for MORE dishes than its pool holds must still not repeat one — the floor is "at
// least this many DIFFERENT dishes", so exhausting the pool is a short tray, never a doubled dish.
test("a position asked for more dishes than its pool holds never repeats one", () => {
  const ctx = { meals: ["lunch"], days: 1, courseCounts: { side: 6 } };
  const names = cols(cannedResponse("courses", { item: "standard", ctx })).map((c) => c[2]);
  assert.deepEqual([...new Set(names)], names, `side repeats a dish: ${names.join(" + ")}`);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// DATA INTEGRITY: the eight food-pyramid tiers, and PLURAL ingredient names
// ════════════════════════════════════════════════════════════════════════════════════════════════
// Every ingredient the fakes emit is a `Ingredient:category` pair in the Components cell (the row's
// ONLY ingredient carrier) or a component of a `recipe` JSON block. This corpus is every pair a full
// canned build can produce: all 9 diet keys + the 2 restrictions, all 3 dayparts, every course kind
// configured, 30 days (a full rotation of either entrée catalogue).
const CORPUS_DIETS = ["standard", "diabetic", "low-sodium", "renal", "gluten-free", "vegetarian", "vegan", "low-fat", "lactose-free", "halal", "kosher"];
const CORPUS_COUNTS = { appetizer: 1, soup: 2, salad: 1, entree: 2, starch: 1, vegetable: 1, side: 2, dessert: 1, beverage: 2 };
// [ingredient, category] for every pair the faker can emit, each pair once.
const emittedPairs = () => {
  const pairs = new Map(); // `${name}:${category}` → [name, category]
  const add = (name, category) => { if (name) pairs.set(`${name}:${category}`, [name, category]); };
  for (const diet of CORPUS_DIETS) {
    for (const meal of ["breakfast", "lunch", "dinner"]) {
      for (const subtype of ["recipes", "courses"]) {
        const out = cannedResponse(subtype, { item: diet, ctx: { meals: [meal], days: 30, courseCounts: CORPUS_COUNTS } });
        for (const line of out.split("\n").slice(1)) {
          for (const part of (line.split("|")[5] || "").split(";")) {
            const [name, category] = part.split(":").map((s) => (s || "").trim());
            add(name, category);
          }
        }
      }
      const one = JSON.parse(cannedResponse("recipe", { item: diet, query: "" }));
      for (const c of one.components) add(c.ingredient, c.category);
    }
  }
  return [...pairs.values()];
};

// ── Rule 2: component categories are food-pyramid tiers, exactly these eight words ───────────────
const TIERS = ["protein", "starch", "vegetable", "fruit", "dairy", "fat", "seasoning", "beverage"];

test("every emitted category is one of the eight food-pyramid tiers", () => {
  const offenders = emittedPairs()
    .filter(([, category]) => !TIERS.includes(category))
    .map(([name, category]) => `${name}:${category}`);
  assert.deepEqual(offenders, []);
});

test("stock, broth, dressing and vinaigrette are tagged seasoning, never fat", () => {
  const offenders = emittedPairs()
    .filter(([name, category]) => /\b(stock|broth|dressing|vinaigrette)\b/i.test(name) && category !== "seasoning")
    .map(([name, category]) => `${name}:${category}`);
  assert.deepEqual(offenders, []);
});

// DRY beans, not fresh pods: green beans are a vegetable (the pod is eaten), so the predicate must
// not sweep them in.
test("nuts, dry beans, lentils and chickpeas are tagged protein", () => {
  const offenders = emittedPairs()
    .filter(([name, category]) => /\b(almonds?|walnuts?|pecans?|lentils?|chickpeas?|(?:black|kidney|pinto|navy|white|dry)\s+beans?)\b/i.test(name) && category !== "protein")
    .map(([name, category]) => `${name}:${category}`);
  assert.deepEqual(offenders, []);
});
