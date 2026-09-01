import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { MemoryBuffer, runMemoryBufferTool, subjectKey, MEMORY_BUFFER_TOOL_NAME, WINDOW_CHARS } from "./memory-buffer.js";
import { DEFAULT_TOOLS } from "../../config/tools.js";

// Every test injects an in-memory database, so no test touches the filesystem. Only the close test
// builds a file-backed buffer, which is the one thing that has a directory to remove.
const buff = () => new MemoryBuffer(new DatabaseSync(":memory:"));
const rows = (b) => b.db.prepare("select subject, body from entries order by rowid").all().map((r) => ({ subject: r.subject, body: r.body }));
const run = (b, args) => runMemoryBufferTool(b, args);
const NO_MATCH = "No match.";
const NOTHING_STORED = "Empty.";

test("a rewrite genuinely erases", () => {
  const b = buff();
  assert.deepEqual(run(b, { op: "write", text: "Lemon — strikes: low-sodium" }), { stored: true, replaced: false });
  assert.deepEqual(run(b, { op: "write", text: "Lemon — strikes: none" }), { stored: true, replaced: true });
  assert.deepEqual(run(b, { op: "query", match: "Lemon strikes" }), { found: true, text: "Lemon — strikes: none", more: false });
  assert.deepEqual(rows(b), [{ subject: "lemon", body: "Lemon — strikes: none" }]);
});

test("a drifted label still overwrites", () => {
  const b = buff();
  for (const text of ["Almonds:nut", "Almonds:starch", "Almonds:nuts"]) run(b, { op: "write", text });
  assert.deepEqual(rows(b), [{ subject: "almonds", body: "Almonds:nuts" }]);
});

test("no subject ever appears in any value returned to the model", () => {
  const b = buff();
  assert.deepEqual(run(b, { op: "write", text: "Zubrowka — strikes: none" }), { stored: true, replaced: false });
  assert.deepEqual(run(b, { op: "query", match: "Zubrowka strikes" }), { found: true, text: "Zubrowka — strikes: none", more: false });
  assert.deepEqual(run(b, { op: "read" }), { text: "", more: false, exhausted: true });
  assert.deepEqual(run(b, { op: "erase" }), { erased: true });
  // The derived key exists and is recorded internally — it just never crosses back to the model.
  assert.equal(b.calls[0].subject, "zubrowka");
});

test("FTS5 syntax from the model is neutralised, not passed through", () => {
  const b = buff();
  const body = "Vegan bowl — body: tofu and brown rice";
  run(b, { op: "write", text: body });
  const want = [
    ['"a" OR b*', "a or b", { found: false, note: NO_MATCH }],
    ["body:x", "body x", { found: false, note: NO_MATCH }],
    ["NEAR(a b, 2)", "near a b 2", { found: false, note: NO_MATCH }],
    ["-vegan", "vegan", { found: true, text: body, more: false }],
    ["***", "", { found: false, note: NO_MATCH }],
  ];
  for (const [match, tokenised, expected] of want) {
    assert.deepEqual(run(b, { op: "query", match }), expected, match);
    assert.equal(b.calls[b.calls.length - 1].match, tokenised, match);
  }
});

test("query matches a stem, not just the exact word", () => {
  const b = buff();
  const body = "Friday — plan: two desserts and a side";
  run(b, { op: "write", text: body });
  assert.deepEqual(run(b, { op: "query", match: "dessert" }), { found: true, text: body, more: false });
});

test("query is lexical and says so by missing a synonym", () => {
  const b = buff();
  run(b, { op: "write", text: "Friday — plan: a vegetarian entree" });
  assert.deepEqual(run(b, { op: "query", match: "meat free meal" }), { found: false, note: NO_MATCH });
});

test("query returns the window AROUND the matched words, not the top of the entry", () => {
  const b = buff();
  run(b, { op: "write", text: `Doc — ${"filler. ".repeat(500)}the sodium figure is 480 mg per serving.` });
  const got = run(b, { op: "query", match: "sodium" });
  assert.equal(got.found, true);
  assert.match(got.text, /the sodium figure is 480 mg per serving\.$/);
  assert.equal(got.text.indexOf("sodium"), 40); // 40 chars of run-up, not the entry's head
  // …and `read` continues AFTER that window rather than from the top of the entry.
  assert.deepEqual(run(b, { op: "read" }), { text: "", more: false, exhausted: true });
});

test("read walks an entry in windows and reports exhaustion", () => {
  const b = buff();
  run(b, { op: "write", text: `Body — ${"x".repeat(WINDOW_CHARS * 2 + 10)}` });
  const a = run(b, { op: "read" });
  const c = run(b, { op: "read" });
  const d = run(b, { op: "read" });
  assert.deepEqual([a.text.length, c.text.length, d.text.length], [WINDOW_CHARS, WINDOW_CHARS, 17]);
  assert.deepEqual([a.more, c.more, d.more], [true, true, false]);
  assert.equal(a.text, `Body — ${"x".repeat(WINDOW_CHARS - 7)}`);
  assert.equal(d.text, "x".repeat(17));
  // Exhaustion STAYS exhausted. Nulling the cursor here sent read 5 back to window 1, so a model
  // that kept reading looped over the same window forever and was never told it had seen it.
  assert.deepEqual(run(b, { op: "read" }), { text: "", more: false, exhausted: true });
  assert.deepEqual(run(b, { op: "read" }), { text: "", more: false, exhausted: true });
  assert.deepEqual(run(b, { op: "read" }), { text: "", more: false, exhausted: true });
  assert.equal(run(b, { op: "read", restart: true }).text, a.text); // only restart goes back
});

test("the window is a hard slice, not a line-trimmed one", () => {
  const b = buff();
  const text = `Lines — ${"y".repeat(WINDOW_CHARS - 10)}\nsecond line\n${"z".repeat(WINDOW_CHARS)}`;
  run(b, { op: "write", text });
  assert.equal(run(b, { op: "read" }).text, text.slice(0, WINDOW_CHARS));
});

test("read restart returns to the start of the current entry", () => {
  const b = buff();
  const text = `Body — ${"x".repeat(WINDOW_CHARS * 3)}`;
  run(b, { op: "write", text });
  assert.equal(run(b, { op: "read" }).text, text.slice(0, WINDOW_CHARS));
  assert.equal(run(b, { op: "read" }).text, text.slice(WINDOW_CHARS, WINDOW_CHARS * 2));
  assert.equal(run(b, { op: "read", restart: true }).text, text.slice(0, WINDOW_CHARS));
});

test("read with no cursor opens on the most recently written entry", () => {
  const b = buff();
  run(b, { op: "write", text: "Alpha — first entry" });
  run(b, { op: "write", text: "Beta — second entry" });
  assert.deepEqual(run(b, { op: "read" }), { text: "Beta — second entry", more: false });
});

test("query returns one window, and repeating it walks the ranking n+1 with no total", () => {
  const b = buff();
  const bodies = [
    "one — tofu rice",
    "two — tofu and brown rice with extra filler words to make this entry longer",
    "three — tofu and brown rice plus even more filler words padding this entry out",
  ];
  for (const text of bodies) run(b, { op: "write", text });
  const seen = [0, 1, 2].map(() => run(b, { op: "query", match: "tofu rice" }));
  assert.deepEqual(seen, [
    { found: true, text: bodies[0], more: true },   // bm25 ranks the shortest match first
    { found: true, text: bodies[1], more: true },
    { found: true, text: bodies[2], more: false },  // the 2nd row's absence is what ends it — never a count
  ]);
});

test("erase with no argument drops the entry the cursor is on", () => {
  const b = buff();
  run(b, { op: "write", text: "Lemon — strikes: none" });
  run(b, { op: "write", text: "Cream — strikes: lactose-free" });
  run(b, { op: "query", match: "Lemon strikes" });
  assert.deepEqual(run(b, { op: "erase" }), { erased: true });
  assert.deepEqual(run(b, { op: "query", match: "Lemon strikes" }), { found: false, note: NO_MATCH });
  assert.deepEqual(rows(b), [{ subject: "cream", body: "Cream — strikes: lactose-free" }]);
});

test("a bare erase with nothing open erases nothing", () => {
  const b = buff();
  for (const text of ["A — one", "B — two", "C — three"]) run(b, { op: "write", text });
  const got = run(b, { op: "erase" });
  assert.equal(got.erased, false);
  assert.match(got.note, /No entry is open/);
  assert.deepEqual(rows(b).map((r) => r.subject), ["a", "b", "c"]);
});

test("a single-character word survives tokenising", () => {
  const b = buff();
  const body = "Supplement — vitamin d, 800 IU";
  run(b, { op: "write", text: body });
  assert.deepEqual(run(b, { op: "query", match: "vitamin d" }), { found: true, text: body, more: false });
  assert.equal(b.calls[b.calls.length - 1].match, "vitamin d");
  // "vitamin" alone would still hit, so the pin is the recorded query, not just the hit.
  assert.equal(run(b, { op: "query", match: "omega 3" }).found, false);
  assert.equal(b.calls[b.calls.length - 1].match, "omega 3");
});

test("query anchors the window on the longest word, not the first", () => {
  const b = buff();
  run(b, { op: "write", text: `Doc — ${"filler word. ".repeat(200)}the sodium figure is 480 mg.` });
  const got = run(b, { op: "query", match: "word sodium" });
  assert.match(got.text, /the sodium figure is 480 mg\.$/);
  assert.equal(got.text.indexOf("sodium"), 40);
});

test("erase with a match drops the matching entries only", () => {
  const b = buff();
  run(b, { op: "write", text: "Lemon — strikes: none" });
  run(b, { op: "write", text: "Cream — strikes: lactose-free" });
  assert.deepEqual(run(b, { op: "erase", match: "lactose free" }), { erased: true });
  assert.deepEqual(rows(b), [{ subject: "lemon", body: "Lemon — strikes: none" }]);
});

test("the worst measured case stays inside its budget", () => {
  const b = buff();
  const filler = "institutional menu planning and regulatory guidance text. ".repeat(5700);
  for (let i = 0; i < 120; i++) run(b, { op: "write", text: `Doc ${i} — ${filler} the sodium figure is 480 mg.` });
  const ms = (fn) => { const t0 = process.hrtime.bigint(); const r = fn(); return [Number(process.hrtime.bigint() - t0) / 1e6, r]; };
  const [everywhere, hit] = ms(() => run(b, { op: "query", match: "regulatory guidance" }));
  const [nowhere, miss] = ms(() => run(b, { op: "query", match: "zzqqx" }));
  assert.match(hit.text, /regulatory guidance/);
  assert.deepEqual(miss, { found: false, note: NO_MATCH });
  // snippet() took 2,070 ms here for two 330 KB rows because it re-tokenizes each whole body;
  // instr() measured 16.6 ms. This is the tripwire for that regression.
  assert.ok(everywhere < 500, `term in every entry took ${everywhere.toFixed(1)} ms`);
  assert.ok(nowhere < 5, `no-match took ${nowhere.toFixed(3)} ms`);
});

test("a large body does not enter the heap", () => {
  const b = buff();
  run(b, { op: "write", text: `Big — ${"a".repeat(10 * 1024 * 1024)}` });
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 100; i++) assert.equal(run(b, { op: "read" }).text.length, WINDOW_CHARS);
  const grew = (process.memoryUsage().heapUsed - before) / 1048576;
  assert.ok(grew < 5, `heap grew ${grew.toFixed(1)} MB over 100 reads of a 10 MB entry`);
});

test("an unknown op is an error, not a silent no-op", () => {
  const b = buff();
  const want = { error: "memory_buffer needs op: one of write, read, query, erase." };
  assert.deepEqual(run(b, { op: "digest" }), want);
  assert.deepEqual(run(b, {}), want);
  assert.deepEqual(rows(b), []);
});

test("write with no text is an error", () => {
  const b = buff();
  assert.deepEqual(run(b, { op: "write" }), { error: "memory_buffer write needs text." });
  assert.deepEqual(run(b, { op: "write", text: "   " }), { error: "memory_buffer write needs text." });
  assert.deepEqual(rows(b), []);
});

test("every call is recorded in order, including one that threw", () => {
  const b = buff();
  run(b, { op: "write", text: "Lemon — strikes: low-sodium" });
  run(b, { op: "write", text: "Lemon — strikes: none" });
  b.query = () => { throw new Error("engine down"); };
  assert.deepEqual(run(b, { op: "query", match: "Lemon" }), { error: "engine down" });
  assert.deepEqual(b.calls.map((c) => [c.n, c.op, c.subject, c.replaced, c.error]), [
    [1, "write", "lemon", null, null],
    [2, "write", "lemon", "Lemon — strikes: low-sodium", null],
    [3, "query", null, null, "engine down"],
  ]);
  assert.equal(b.calls[1].wrote, "Lemon — strikes: none");
});

test("the snapshot carries subjects and sizes but not body text", () => {
  const b = buff();
  const body = "q".repeat(347790);
  run(b, { op: "write", text: `Payload — ${body}` });
  const snap = b.snapshot();
  assert.deepEqual(snap.entries.map((e) => ({ subject: e.subject, bytes: e.bytes })), [{ subject: "payload", bytes: 347800 }]);
  assert.equal(snap.calls.length, 1);
  assert.equal(snap.calls[0].wrote.length, 201, "the record clips the body to 200 chars + an ellipsis");
  assert.ok(JSON.stringify(snap).length < 1000, `snapshot is ${JSON.stringify(snap).length} chars`);
});

// Not a lock on WHICH verbs exist — adding one is a design decision, not a regression. The
// invariant is that the schema and the dispatcher agree: a verb the model is offered must be
// executable, and one it is not offered must not be. Both halves fail on a real mistake (a verb
// advertised but never implemented; a verb reachable but undocumented) and neither fails on a
// deliberate fifth verb, because config and code move together.
test("every verb the tool advertises is executable, and nothing else is", () => {
  const def = DEFAULT_TOOLS.find((t) => t.name === MEMORY_BUFFER_TOOL_NAME);
  assert.ok(def, "memory_buffer is missing from DEFAULT_TOOLS");
  const advertised = def.parameters.properties.op.enum;
  assert.ok(advertised.length > 0);
  const rejection = "memory_buffer needs op: one of write, read, query, erase.";
  for (const op of advertised) {
    const b = buff();
    run(b, { op: "write", text: "Lemon — strikes: none" }); // so read/query/erase have something to act on
    assert.notEqual(run(b, { op }).error, rejection, `advertised verb "${op}" is not dispatched`);
  }
  for (const op of ["digest", "list", "keys", "count", "fetch"]) {
    assert.ok(!advertised.includes(op), `test needs updating: "${op}" is now advertised`);
    assert.equal(run(buff(), { op }).error, rejection, `unadvertised verb "${op}" is reachable`);
  }
});

// The setup is the ONLY way material the model never held gets in: a 350 KB document cannot arrive
// by the model writing text it does not have. These pin that it is reachable before any write.
test("seeded material is queryable before the model writes anything", () => {
  const b = buff();
  b.seed([`Audit — ${"filler. ".repeat(200)}the sodium figure is 480 mg per serving.`, "Diets — renal, low-sodium, regular"]);
  const got = run(b, { op: "query", match: "sodium figure" });
  assert.equal(got.found, true);
  assert.match(got.text, /the sodium figure is 480 mg per serving\.$/);
  assert.deepEqual(rows(b).map((r) => r.subject), ["audit", "diets"]);
  assert.equal(b.calls.filter((c) => c.op === "setup").length, 2);
});

test("the model can correct a seeded entry by rewriting its first line", () => {
  const b = buff();
  b.seed(["Lemon — strikes: low-sodium"]);
  assert.deepEqual(run(b, { op: "write", text: "Lemon — strikes: none" }), { stored: true, replaced: true });
  assert.deepEqual(rows(b), [{ subject: "lemon", body: "Lemon — strikes: none" }]);
  assert.equal(b.calls[1].replaced, "Lemon — strikes: low-sodium");
});

test("the snapshot separates what was seeded from what the model wrote", () => {
  const b = buff();
  b.seed(["Given — the step's material"]);
  run(b, { op: "write", text: "Mine — what I concluded" });
  assert.deepEqual(b.snapshot().calls.map((c) => [c.op, c.subject]), [["setup", "given"], ["write", "mine"]]);
});

test("seed ignores empty and blank entries", () => {
  const b = buff();
  b.seed(["Real — content", "", "   ", null, undefined]);
  assert.deepEqual(rows(b).map((r) => r.subject), ["real"]);
  assert.equal(b.calls.length, 1);
});

// A miss on an EMPTY buffer and a miss on a full one are different facts, and the model has no list
// op to tell them apart. Without this it cannot know whether to retry with other words.
test("a miss says whether the buffer is empty or the words were wrong", () => {
  const b = buff();
  assert.deepEqual(run(b, { op: "query", match: "sodium" }), { found: false, note: NOTHING_STORED });
  b.seed(["Audit — the potassium figure is 20 mg"]);
  assert.deepEqual(run(b, { op: "query", match: "sodium" }), { found: false, note: NO_MATCH });
  assert.deepEqual(run(b, { op: "query", match: "!!!" }), { found: false, note: NO_MATCH });
  run(b, { op: "erase", match: "potassium" });
  assert.deepEqual(run(b, { op: "query", match: "sodium" }), { found: false, note: NOTHING_STORED });
});

test("close removes the temp directory", () => {
  const b = new MemoryBuffer();
  const dir = b.dir;
  assert.equal(fs.existsSync(dir), true);
  b.close();
  assert.equal(fs.existsSync(dir), false);
});

test("subjectKey collapses a drifted first line to one key", () => {
  assert.equal(subjectKey("Almonds:nut"), "almonds");
  assert.equal(subjectKey("Lemon — strikes: none"), "lemon");
  assert.equal(subjectKey("  Two   Words  \nrest"), "two words");
  assert.equal(subjectKey(""), "");
});

// MEASURED on real model typos: Damerau distance 1 covers vegetarain/vegetarian, soduim/sodium and
// glutin/gluten. It deliberately does NOT reach brocolli/broccoli (distance 2), because the same
// threshold that reaches it also equates lemon and melon — two real foods, so the wrong window
// would come back as if it were right.
test("a one-edit typo finds the stored word and says which word was used", () => {
  const b = buff();
  run(b, { op: "write", text: "Diets — vegetarian mains, sodium limits, gluten notes" });
  assert.deepEqual(run(b, { op: "query", match: "vegetarain" }), {
    found: true,
    text: "Diets — vegetarian mains, sodium limits, gluten notes",
    more: false,
    near: "vegetarian",
  });
  assert.equal(run(b, { op: "query", match: "soduim" }).near, "sodium");
  assert.equal(run(b, { op: "query", match: "glutin" }).near, "gluten");
});

test("a two-edit difference between two real words is not treated as a typo", () => {
  const b = buff();
  run(b, { op: "write", text: "Melon — honeydew, cantaloupe" });
  assert.deepEqual(run(b, { op: "query", match: "lemon" }), { found: false, note: NO_MATCH });
});

test("a word that matched exactly is never replaced by a near one", () => {
  const b = buff();
  run(b, { op: "write", text: "Sodium — 600 mg cap" });
  const out = run(b, { op: "query", match: "sodium" });
  assert.equal(out.found, true);
  assert.equal(out.near, undefined);
});

test("short words are not corrected, so an exact three-letter query stays exact", () => {
  const b = buff();
  run(b, { op: "write", text: "Oat — rolled, steel cut" });
  assert.deepEqual(run(b, { op: "query", match: "eat" }), { found: false, note: NO_MATCH });
});

// FTS5 tokenises an unbroken run of letters as ONE term, so both sides of the typo check are
// unbounded in length. The matrix version was O(m*n) per candidate term — 10,000 characters against
// a same-length stored term was a 100,000,000-cell allocation inside the vocab loop, per word.
test("a 10,000-character word is compared in linear time, not by an n-squared matrix", () => {
  const b = buff();
  run(b, { op: "write", text: `Blob — ${"a".repeat(10000)}` });          // one 10k term, stored
  const near = `${"a".repeat(9999)}b`;                                   // one edit from it
  const t0 = process.hrtime.bigint();
  const hit = run(b, { op: "query", match: near });
  const miss = run(b, { op: "query", match: `${"c".repeat(5000)}${"d".repeat(5000)}` });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(hit.near, "a".repeat(10000));
  assert.equal(miss.found, false);
  // MEASURED 0.448 ms (hit) and 0.110 ms (miss). 10 is the budget, not the measurement — a return
  // to any per-candidate matrix blows it by orders of magnitude, which is what this line is for.
  assert.ok(ms < 10, `two 10k-character typo checks took ${ms.toFixed(1)} ms`);
});

// What llama3.1:8b sent on a live run for a schema-declared boolean.
test("restart sent as the string \"true\" restarts the entry, as the boolean does", () => {
  const b = buff();
  run(b, { op: "write", text: `Blob — ${"x".repeat(WINDOW_CHARS * 2)}` });
  const first = run(b, { op: "read" }).text;
  run(b, { op: "read" });
  assert.deepEqual(run(b, { op: "read", restart: "true" }).text, first);
  assert.deepEqual(run(b, { op: "read", restart: true }).text, first);
});

// What a model actually sends for an enum: the verb in the wrong case, padded, or a whole sentence.
// Nothing longer than the longest verb can be a verb, so it never reaches a comparison — and the
// run doc keeps the rejected value rather than a blank.
test("a padded op is trimmed, and the verb is case-insensitive", () => {
  const b = buff();
  assert.deepEqual(run(b, { op: " WRITE ", text: "Sodium — 600 mg cap" }), { stored: true, replaced: false });
  assert.deepEqual(run(b, { op: "\tQuery\n", match: "sodium" }), { found: true, text: "Sodium — 600 mg cap", more: false });
  assert.deepEqual(b.calls.map((c) => c.op), ["write", "query"]);
});

test("an op that is too long, empty, or not a string is rejected and recorded as sent", () => {
  const b = buff();
  const bad = "write the sodium total into the buffer";
  for (const args of [{ op: bad }, { op: "" }, { op: "   " }, { op: 7 }, {}]) {
    assert.deepEqual(run(b, args), { error: "memory_buffer needs op: one of write, read, query, erase." });
  }
  assert.deepEqual(b.calls.map((c) => c.op), [bad, "", "", "", ""]);
  assert.deepEqual(b.calls.map((c) => c.error), Array(5).fill("memory_buffer needs op: one of write, read, query, erase."));
});
