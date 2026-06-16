// Proof of the deterministic-key inventory core (no Firestore, no LLM):
//   normalize(name) -> code unit-convert -> append ONE doc per SOURCE LINE (id = source-anchored)
//   -> finalize folds by (key, baseUnit), summing in code.
//
// Proves: (1) consistent keys across parallel "hosts"; (2) EXACT totals; (3) idempotent under replay;
// (4) two recipes' identical "1/2 cup tomato" both count (the source-anchored-id requirement);
// (5) a content-keyed id UNDERCOUNTS (demonstrates the bug we're avoiding);
// (6) distinguishing modifiers are NEVER stripped — black pepper != pepper, parmesan != cheese,
//     scallion/green onion != onion; (7) volume vs mass of the same ingredient stay separate (no guessing).
// Run: node functions/scripts/inventory-core-proof.mjs

// ---- conservative normalize: case / whitespace / punctuation + MINIMAL singularize. NEVER strips modifiers ----
const SINGULAR_KEEP = new Set(["molasses", "hummus", "couscous", "watercress", "asparagus", "swiss"]);
function singularize(w) {
  if (SINGULAR_KEEP.has(w)) return w;
  if (/sses$/.test(w)) return w;            // molasses-class (safety net)
  if (/oes$/.test(w)) return w.slice(0, -2); // tomatoes -> tomato, potatoes -> potato
  if (/ies$/.test(w)) return w.slice(0, -3) + "y"; // berries -> berry
  if (/s$/.test(w) && !/ss$/.test(w) && w.length > 3) return w.slice(0, -1); // carrots -> carrot, oats -> oat
  return w;
}
function normalize(name) {
  return String(name).toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, " ")  // punctuation -> space (keep hyphen)
    .replace(/\s+/g, " ").trim()
    .split(" ").map(singularize).join(" ")
    .replace(/\s/g, "-");
}

// ---- deterministic unit conversion to a base: volume->ml, mass->g, count/unknown-> kept as-is (own line) ----
const VOL = { tsp: 4.93, tbsp: 14.79, cup: 236.59, ml: 1, l: 1000, "fl-oz": 29.57, pint: 473.18, quart: 946.35, gallon: 3785.4 };
const MASS = { mg: 0.001, g: 1, kg: 1000, oz: 28.35, lb: 453.59 };
function convert(qty, unit) {
  const u = String(unit || "").toLowerCase().trim().replace(/\s+/g, "-");
  if (u in VOL) return { value: qty * VOL[u], base: "ml" };
  if (u in MASS) return { value: qty * MASS[u], base: "g" };
  return { value: qty, base: u || "each" }; // can / bunch / clove / to-taste -> never guessed
}

// ---- the doc store (stand-in for Firestore docs). Same id => OVERWRITE (idempotent). ----
const store = new Map();
function appendLine(docId, doc) { store.set(docId, doc); }

// a worker processes some recipe-units; EACH ingredient line -> ONE source-anchored doc.
function processUnit(recipeUnitId, lines) {
  lines.forEach((ln, i) => {
    const key = normalize(ln.name);
    const { value, base } = convert(ln.qty, ln.unit);
    appendLine(`${recipeUnitId}#${i}`, { key, value, base, raw: ln.name });
  });
}

// finalize: fold all docs by (key, base), summing value IN CODE.
function finalize() {
  const totals = new Map();
  for (const { key, value, base } of store.values()) {
    const k = `${key}|${base}`;
    totals.set(k, (totals.get(k) || 0) + value);
  }
  return totals;
}

// ============================ TEST DATA (messy, multi-supplier, parallel hosts) ============================
// Two DIFFERENT recipes each use 1/2 cup tomato — must sum to 1 cup, not collapse to 1/2.
const HOSTS = {
  hostA: {                                  // machine A: days 1-2
    "recipes-001": [
      { name: "Tomatoes", qty: 0.5, unit: "cup" },     // recipe 1, line 0  (1/2 cup #1)
      { name: "black pepper", qty: 2, unit: "tsp" },
      { name: "Parmesan cheese", qty: 30, unit: "g" },
    ],
    "recipes-002": [
      { name: "tomato", qty: 0.5, unit: "cup" },        // recipe 2, line 0  (1/2 cup #2 — DIFFERENT source)
      { name: "pepper", qty: 1, unit: "tsp" },          // generic pepper — must NOT merge with black pepper
      { name: "scallion", qty: 3, unit: "each" },
    ],
  },
  hostB: {                                  // machine B: days 3-4 (runs concurrently)
    "recipes-003": [
      { name: "TOMATO", qty: 1, unit: "cup" },          // same ingredient, different host -> same key
      { name: "green onion", qty: 2, unit: "each" },    // semantic dup of scallion -> stays separate (SKU layer later)
      { name: "McCormick Black Pepper 16oz", qty: 1, unit: "tsp" }, // supplier variant -> separate (under-merge, safe)
    ],
    "recipes-004": [
      { name: "cheese", qty: 50, unit: "g" },           // generic cheese — must NOT merge with parmesan
      { name: "onion", qty: 1, unit: "each" },          // yellow onion — must NOT merge with scallion/green onion
      { name: "tomato", qty: 200, unit: "g" },          // tomato by MASS -> different base than the cup ones
    ],
  },
  hostC: {                                  // machine C: the SAME recipe on two different days (cycle menu repeat)
    // Identical content AND identical line numbers — they must BOTH count because they are different MENU SLOTS.
    // The unit id is the engine's slot coordinate (day/meal/diet), which is unique per occurrence by construction.
    "d01-breakfast-regular": [
      { name: "Eggs", qty: 2, unit: "each" },           // day 1, line 0
      { name: "salt", qty: 1, unit: "tsp" },            // day 1, line 1
    ],
    "d05-breakfast-regular": [
      { name: "Eggs", qty: 2, unit: "each" },           // day 5, line 0 — same text, same line no, DIFFERENT slot
      { name: "salt", qty: 1, unit: "tsp" },            // day 5, line 1
    ],
  },
};

// ---- run the two hosts "in parallel" (interleaved unit order shouldn't matter) ----
const units = [];
for (const host of Object.keys(HOSTS)) for (const u of Object.keys(HOSTS[host])) units.push([u, HOSTS[host][u]]);
// process in REVERSE order to show the fold is order-independent (concurrency-safe)
[...units].reverse().forEach(([id, lines]) => processUnit(id, lines));

const before = finalize();
const docsBefore = store.size;

// ---- IDEMPOTENCY: replay one whole unit (at-least-once redelivery / step retry) ----
processUnit(units[0][0], units[0][1]);   // re-process recipes-001
const after = finalize();
const docsAfter = store.size;

// ============================ ASSERTIONS ============================
const cup = VOL.cup;
const checks = [];
const eq = (a, b, t = 1e-6) => Math.abs(a - b) < t;
const g = (m, k) => m.get(k) || 0;

checks.push(["½cup + ½cup + 1cup tomato (volume) = 2 cups", eq(g(before, "tomato|ml"), 2 * cup), `${g(before, "tomato|ml").toFixed(1)}ml vs ${(2 * cup).toFixed(1)}ml`]);
checks.push(["tomato by MASS kept separate from volume", eq(g(before, "tomato|g"), 200), `${g(before, "tomato|g")}g`]);
checks.push(["black pepper NOT merged into pepper", g(before, "black-pepper|ml") > 0 && g(before, "pepper|ml") > 0 && !before.has("pepper-only-collapse"), `black-pepper=${g(before, "black-pepper|ml").toFixed(2)}ml, pepper=${g(before, "pepper|ml").toFixed(2)}ml`]);
checks.push(["'parmesan cheese' NOT merged into generic 'cheese'", g(before, "parmesan-cheese|g") === 30 && g(before, "cheese|g") === 50, `parmesan-cheese=${g(before, "parmesan-cheese|g")}g, cheese=${g(before, "cheese|g")}g (distinct keys, no over-merge)`]);
checks.push(["scallion / green-onion / onion all distinct", g(before, "scallion|each") === 3 && g(before, "green-onion|each") === 2 && g(before, "onion|each") === 1, `scallion=3? green-onion=2? onion=1?`]);
checks.push(["supplier variant stays its own key (under-merge, safe)", store.size && [...store.values()].some((d) => d.key === "mccormick-black-pepper-16oz"), `key present`]);
checks.push(["consistent key across hosts (Tomatoes/tomato/TOMATO -> tomato)", normalize("Tomatoes") === "tomato" && normalize("TOMATO") === "tomato" && normalize("tomato") === "tomato", normalize("Tomatoes")]);
checks.push(["modifier preserved (molasses NOT singularized to molasse)", normalize("molasses") === "molasses", normalize("molasses")]);
checks.push(["IDEMPOTENT: replay changed nothing (docs)", docsBefore === docsAfter, `${docsBefore} -> ${docsAfter}`]);
checks.push(["IDEMPOTENT: replay changed nothing (tomato total)", eq(g(before, "tomato|ml"), g(after, "tomato|ml")), `${g(before, "tomato|ml").toFixed(1)} -> ${g(after, "tomato|ml").toFixed(1)}`]);

// ---- demonstrate the BUG the source-anchored id avoids: a CONTENT-keyed id undercounts ----
const contentStore = new Map();
for (const [, lines] of units) lines.forEach((ln) => {
  const key = normalize(ln.name); const { value, base } = convert(ln.qty, ln.unit);
  contentStore.set(`${key}|${value}|${base}`, { key, value, base }); // BUG: id encodes content
});
let contentTomatoMl = 0; for (const d of contentStore.values()) if (d.key === "tomato" && d.base === "ml") contentTomatoMl += d.value;
checks.push(["CONTROL: content-keyed id UNDERCOUNTS the two ½ cups", contentTomatoMl < 2 * cup, `content-keyed=${contentTomatoMl.toFixed(1)}ml (lost a ½ cup) vs source-anchored=${g(before, "tomato|ml").toFixed(1)}ml`]);

// ---- identical recipe on two different days BOTH count (slot-anchored id), and a SLOT-LESS id collapses them ----
checks.push(["identical recipe on 2 days BOTH count (eggs d01 + d05 = 4)", g(before, "egg|each") === 4, `egg=${g(before, "egg|each")} each`]);
const slotless = new Map();
for (const [, lines] of units) lines.forEach((ln, i) => {
  const key = normalize(ln.name); const { value, base } = convert(ln.qty, ln.unit);
  slotless.set(`${key}#${i}`, { key, value, base }); // BUG: id omits the day/slot -> d01 & d05 eggs collide on egg#0
});
let slotlessEggs = 0; for (const d of slotless.values()) if (d.key === "egg") slotlessEggs += d.value;
checks.push(["CONTROL: slot-less id (key#line) collapses the two days' eggs", slotlessEggs < 4, `slot-less=${slotlessEggs} (d01 & d05 collided) vs slot-anchored=${g(before, "egg|each")}`]);

// ============================ REPORT ============================
console.log("\n=== INVENTORY CORE PROOF ===\n");
console.log(`docs written (one per source line): ${docsBefore}`);
console.log("finalized order list (key | base : total):");
[...before.entries()].sort().forEach(([k, v]) => console.log(`   ${k.padEnd(28)} ${v.toFixed(2)}`));
console.log("\nchecks:");
let pass = 0;
for (const [name, ok, detail] of checks) { console.log(`   ${ok ? "PASS" : "FAIL"}  ${name}  [${detail}]`); if (ok) pass++; }
console.log(`\n${pass}/${checks.length} passed`);
process.exit(pass === checks.length ? 0 : 1);
