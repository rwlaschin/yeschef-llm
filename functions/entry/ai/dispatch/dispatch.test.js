import { test } from "node:test";
import assert from "node:assert/strict";
import { tableRows } from "./dispatch.js";

// The declared column contract of the recipes/courses tables, as the step def carries it.
const COLUMNS = ["Day", "Mealtime", "Dish", "Kind", "Diets", "Components"];
// The contract those tables carried BEFORE the four positional ingredient columns were dropped. The
// verbatim job responses below were written against it, and runs written against it are still stored
// in Firestore, so tableRows must go on keying them.
const COLUMNS10 = ["Day", "Mealtime", "Dish", "Protein", "Starch", "Vegetable", "Fruit", "Kind", "Diets", "Components"];

// Verbatim responses from job 70899f8d-af4f-45b5-a64c-7cd5de401705 (llama3_1_8b_v1). The recipes
// units wrote the header; the courses units did NOT — which is what silently ate a dish row and
// keyed the survivors by dish names, so every {{row.*}} rendered empty.
const RECIPES_WITH_HEADER = `Day | Mealtime | Dish | Protein | Starch | Vegetable | Fruit | Kind | Diets | Components
1 | lunch | Braised beef with barley | Beef | Barley |  |  | entree | standard | Beef:protein; Barley:starch

Why:
Diet — included all diets from the plan, excluded none.`;

const COURSES_NO_HEADER = `Here are the rows for Day 1:

1 | lunch | Sliced carrots |  |  | Carrots:vegetable |  | side | standard, vegetarian, vegan | Carrots:vegetable
1 | dinner | Steamed green beans |  |  | Green beans:vegetable |  | side | standard, vegetarian, vegan | Green beans:vegetable
1 | lunch | Roasted sweet potato |  | Sweet potatoes |  |  | starch | standard, gluten-free | Sweet potatoes:starch
1 | dinner | Sautéed spinach with garlic |  |  | Spinach:vegetable; Garlic:seasoning |  | side | standard, vegetarian, vegan | Spinach:vegetable; Garlic:seasoning`;

test("a response WITH the header keys rows by it and does not treat it as data", () => {
  const { rows, error } = tableRows(RECIPES_WITH_HEADER, COLUMNS10);
  assert.equal(error, undefined);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]), COLUMNS10);
  assert.equal(rows[0].Dish, "Braised beef with barley");
  assert.equal(rows[0].Kind, "entree");
  assert.equal(rows[0].Day, "1");
});

test("a response WITHOUT the header keeps every row and still keys them correctly", () => {
  const { rows, error } = tableRows(COURSES_NO_HEADER, COLUMNS10);
  assert.equal(error, undefined);
  assert.equal(rows.length, 4, "no dish row may be eaten as a header");
  assert.deepEqual(rows.map((r) => r.Dish),
    ["Sliced carrots", "Steamed green beans", "Roasted sweet potato", "Sautéed spinach with garlic"]);
  assert.deepEqual(rows.map((r) => r.Kind), ["side", "side", "starch", "side"]);
  assert.ok(rows.every((r) => r.Day === "1" && r.Mealtime));
});

test("a header written in a different order is still a header, and keys the rows as written", () => {
  const swapped = ["Mealtime", "Day", ...COLUMNS.slice(2)].join(" | ");
  const { rows } = tableRows(`${swapped}\nlunch | 1 | Sliced carrots |  |  | Carrots:vegetable |  | side | standard | Carrots:vegetable`, COLUMNS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Day, "1");
  assert.equal(rows[0].Mealtime, "lunch");
});

// A SHORT row cannot be keyed — the declared columns are not a prefix of it — so it stays an error.
// (Extra TRAILING cells are tolerated; see the overload tests below.)
test("a row whose width does not match the columns is an error, not a half-keyed row", () => {
  const { rows, error } = tableRows("1 | lunch | Sliced carrots", COLUMNS);
  assert.equal(rows, undefined);
  assert.match(error, /has 3 cell\(s\), expected at least 6/);
});

test("a row that is empty in every column is an error", () => {
  const { error } = tableRows(`${COLUMNS.join(" | ")}\n|${COLUMNS.map(() => "").join("|")}|`, COLUMNS);
  assert.match(error, /empty in every column/);
});

test("no declared columns cannot be keyed and is an error, never a guessed header", () => {
  const { error } = tableRows(COURSES_NO_HEADER, []);
  assert.match(error, /declares no `columns`/);
});

test("no piped line at all is not a table", () => {
  const { error } = tableRows("I could not produce a menu for this slot.", COLUMNS);
  assert.match(error, /produced no table/);
});

test("a declared header with no data lines is zero rows, not an error", () => {
  const { rows, error } = tableRows(`${COLUMNS.join(" | ")}\n|---|---|`, COLUMNS);
  assert.equal(error, undefined);
  assert.deepEqual(rows, []);
});

// A step may OVERLOAD its table with trailing columns the pipeline does not consume — courses now
// appends `Reason` (prompt_library "Reason column mechanism"), while recipes does not. Build Recipe
// Details fans over BOTH via rowsOf and can carry only ONE `columns` declaration, so the parser has
// to key the declared columns and drop what follows. Extras are keyable (the declared columns are a
// prefix); a SHORT row is not, and stays an error.
const COURSES_WITH_REASON = `Day | Mealtime | Dish | Kind | Diets | Components | Reason
1 | lunch | Roasted Sweet Potato | side | standard, diabetic | Sweet Potato:starch | sweet roast contrasts the braise`;

test("an overloaded table keys the declared columns and ignores the trailing extras", () => {
  const { rows, error } = tableRows(COURSES_WITH_REASON, COLUMNS);
  assert.equal(error, undefined);
  assert.equal(rows.length, 1, "the 7-cell header must be read as a header, never as data");
  assert.deepEqual(Object.keys(rows[0]), COLUMNS, "Reason must not leak into the keyed row");
  assert.equal(rows[0].Dish, "Roasted Sweet Potato");
  assert.equal(rows[0].Components, "Sweet Potato:starch");
  assert.equal(rows[0].Kind, "side");
});

// Measured on job 6be54418 run 002-0000: a unit writing several day-blocks restated the header before
// each one — 7 headers, 7 data rows. Only the first was consumed as the header, so the other 6 keyed
// as rows whose every cell is a column NAME, and rowsOf would turn each into its own downstream unit.
test("a header repeated between blocks is skipped, never keyed as a row", () => {
  const block = (d, dish) => `${COLUMNS.join(" | ")}\n${d} | lunch | ${dish} | entree | standard | Beef:protein`;
  const { rows, error } = tableRows([block(1, "Braised Beef"), block(2, "Grilled Chicken")].join("\n\n"), COLUMNS);
  assert.equal(error, undefined);
  assert.equal(rows.length, 2, "the restated header must not become a row");
  assert.deepEqual(rows.map((r) => r.Dish), ["Braised Beef", "Grilled Chicken"]);
  assert.ok(rows.every((r) => r.Day !== "Day"), "no row may key a column NAME as its value");
});

test("an overloaded table WITHOUT a header still keys the declared columns", () => {
  const body = COURSES_WITH_REASON.split("\n")[1];
  const { rows, error } = tableRows(body, COLUMNS);
  assert.equal(error, undefined);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Components, "Sweet Potato:starch");
  assert.equal(rows[0].Day, "1");
});
