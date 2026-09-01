// Storage OUTSIDE the model's context that it can rewrite and search. Two measured failures, one
// tool. (1) A stream cannot erase: a diet audit emitted "Lemon — strikes: low-sodium", could not
// retract it, and carried the wrong strike into the final row. A write that overwrites IS the
// erasure. (2) A payload does not fit context: 347,790 chars of web results left 4 tokens of the
// real prompt (index.js:514), so the step produced nothing. The buffer holds it and hands back one
// window at a time.
//
// The store is PER RUN and not durable — one FTS5 table in a tempfile that close() removes. It is
// deliberately NOT a module-level singleton: concurrent generations would then share one buffer,
// and one run's close() would delete another's data. What survives is the run doc's `memory` field.
//
// FTS5 is LEXICAL: it matches words and their stems, not meanings. Measured on 30 real model
// outputs, `meat free meal` misses a body saying `vegetarian`. A one-edit typo is recovered on the
// miss path (nearWords); `brocolli`/`broccoli` is two edits, so it stays a miss.
// `read` — not `query` — is the guaranteed path to a payload the model itself just stored.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const MEMORY_BUFFER_TOOL_NAME = "memory_buffer";
export const WINDOW_CHARS = 400;      // ~100 tokens at 4 chars/token
const RECORD_CHARS = 200;             // per-record clip: the run doc shares a 1 MiB limit with `response`
const LEAD_CHARS = 40;                // chars of run-up before a query match, so the window has context

const NO_MATCH = "No match.";
const NOTHING_STORED = "Empty.";
const NEAR_EDITS = 1;   // Damerau distance. MEASURED: 1 catches vegetarain/vegetarian, soduim/sodium
                        // and glutin/gluten, and REFUSES lemon/melon (2) — two real words a looser
                        // threshold would have silently confused. brocolli/broccoli is 2, so it misses.
const OP_MAX_LEN = 5;    // "write" / "query" / "erase" — the longest verb. Nothing longer is one.
const NEAR_MIN_LEN = 4; // below this, one edit reaches too many unrelated words (cat/cot/cut)

// ONE edit apart, transposition included — decided in a single linear pass with no allocation. The
// edit-distance MATRIX this replaces was O(m*n) in space and time PER CANDIDATE TERM, and neither
// side is bounded: FTS5 tokenises a 10,000-character run of letters as one term, so two of them
// meant a 100,000,000-cell matrix inside the vocab loop. At a threshold of one edit the matrix
// answers nothing the three cases below do not: after the first mismatch, either the tails match
// (substitution), the two chars are swapped and the tails match (transposition), or one string has
// one extra char and the tails match (insertion/deletion). Any second mismatch is already 2 edits.
// Indices only — no slice, no destructure, nothing allocated. A slice of a 10,000-character term
// copies the term to compare it, once per candidate; the loops below read it in place.
const tailEq = (a, b, i, j) => {          // a[i..] === b[j..], both tails the same length
  for (; i < a.length; i++, j++) if (a[i] !== b[j]) return false;
  return true;
};
const nearBy = (a, b) => {
  const m = a.length, n = b.length;
  if (m === n) {
    let i = 0;
    while (i < m && a[i] === b[i]) i++;
    if (i === m) return false;                                        // identical, not a typo of itself
    if (tailEq(a, b, i + 1, i + 1)) return true;                      // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && tailEq(a, b, i + 2, i + 2); // transposition
  }
  if (m + 1 !== n && n + 1 !== m) return false;
  const short = m < n ? a : b, long = m < n ? b : a;                  // long has the one extra char
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  return tailEq(short, long, i, i + 1);                               // insertion / deletion
};

// The internal key, never returned to the model. The same model wrote "Almonds:nut",
// "Almonds:starch" and "Almonds:nuts" across three runs, so cutting the first line at its first
// separator is what makes its third write overwrite its first two.
export function subjectKey(text) {
  return String(text ?? "").split("\n")[0].split(/[:—|\t-]/)[0].toLowerCase().trim().replace(/\s+/g, " ");
}

// FTS5 syntax must never reach the model, so it never comes back either: `match` is reduced to
// plain words. Lowercasing is what disarms AND/OR/NOT/NEAR, which are operators only in uppercase.
// Single characters are KEPT — dropping them silently turned "vitamin d" into "vitamin" and
// "omega 3" into "omega", which is the model's query quietly answering a different question.
const plainWords = (s) => String(s ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];

const clip = (s) => (s.length > RECORD_CHARS ? `${s.slice(0, RECORD_CHARS)}…` : s);

// One tracking record per call, pushed BEFORE the verb runs: a verb that threw is otherwise
// indistinguishable from one never called. `op` is "setup" for what the step was handed.
const record = (buff, op) => {
  const rec = { n: buff.calls.length + 1, op, at: new Date().toISOString(), subject: null, replaced: null, wrote: null, match: null, found: null, chars: 0, error: null };
  buff.calls.push(rec);
  return rec;
};

export class MemoryBuffer {
  // `db` is passed in by tests (an in-memory database, so no test touches the filesystem);
  // production passes nothing and gets a tempfile.
  constructor(db) {
    this.calls = [];
    this.cursor = null;
    this.dir = null;
    if (db) this.db = db;
    else {
      this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-buffer-"));
      this.db = new DatabaseSync(path.join(this.dir, "store.db"));
    }
    // Scratch, not a record of anything: durability across a crash is not wanted, and paging is
    // what keeps a 38 MB store off the heap (measured +1 MB heapUsed).
    this.db.exec("pragma mmap_size = 1073741824");
    this.db.exec("pragma journal_mode = WAL");
    this.db.exec("pragma synchronous = OFF");
    this.db.exec("create virtual table if not exists entries using fts5(subject, body, tokenize='porter unicode61')");
    this.db.exec("create virtual table if not exists vocab using fts5vocab(entries, 'row')");
    // Compiled ONCE. Re-preparing per call cost 531.6 ms against 337.3 ms over 20,000 reads —
    // a third of the loop spent recompiling the same six statements.
    this.st = {
      body: this.db.prepare("select body from entries where subject = ?"),
      drop: this.db.prepare("delete from entries where subject = ?"),
      add: this.db.prepare("insert into entries (subject, body) values (?, ?)"),
      newest: this.db.prepare("select subject from entries order by rowid desc limit 1"),
      any: this.db.prepare("select 1 from entries limit 1"),
      // Every indexed term, for the nearby-word retry. Built by FTS5, so it costs nothing to keep.
      // Only terms within ONE character of the query word can be one edit away, so the length
      // window is a filter, not a hint — it is what keeps the vocab loop off every other term.
      terms: this.db.prepare("select term, doc from vocab where length(term) between ? and ? order by doc desc"),
      window: this.db.prepare("select substr(body, ? + 1, ?) as win, length(body) > ? + ? as more from entries where subject = ?"),
      rank: this.db.prepare("select subject, max(0, instr(lower(body), ?) - ?) as off from entries where entries match ? order by bm25(entries) limit 2 offset ?"),
      dropMatch: this.db.prepare("delete from entries where rowid in (select rowid from entries where entries match ?)"),
      sizes: this.db.prepare("select subject, length(body) as bytes from entries order by rowid"),
    };
  }

  // SETUP: material the step was HANDED, in the buffer before the model's first token. Without it
  // the only way in is the model writing text it already holds — which cannot be true of a payload
  // too big for its context, so the 347,790-char case would be unreachable and `query`/`read` would
  // have nothing to find in round 1. Recorded as op "setup", so the run doc shows what was seeded
  // versus what the model wrote.
  seed(texts) {
    for (const text of texts) {
      if (String(text ?? "").trim()) this.write(text, record(this, "setup"));
    }
  }

  write(text, rec) {
    const body = String(text);
    const subject = subjectKey(body) || `entry ${this.calls.length}`;
    const prev = this.st.body.get(subject);
    this.db.exec("begin");
    this.st.drop.run(subject);
    this.st.add.run(subject, body);
    this.db.exec("commit");
    if (this.cursor?.subject === subject) this.cursor.off = 0;
    rec.subject = subject;
    rec.wrote = clip(body);
    rec.replaced = prev ? clip(prev.body) : null;
    return { stored: true, replaced: !!prev };
  }

  read(restart, rec) {
    if (!this.cursor) {
      const subject = this.st.newest.get()?.subject;
      if (!subject) return { text: "", more: false, exhausted: true };
      this.cursor = { subject, off: 0, match: null, n: 0 };
    }
    if (restart) this.cursor.off = 0;
    rec.subject = this.cursor.subject;
    const row = this.st.window.get(this.cursor.off, WINDOW_CHARS, this.cursor.off, WINDOW_CHARS, this.cursor.subject);
    // The cursor is KEPT past the end. Nulling it here sent the next `read` back to this same
    // entry at offset 0, so a model that kept reading silently looped over window 1 forever and
    // was never told it had already seen it. `restart: true` is the only way back to the start.
    if (!row || !row.win) return { text: "", more: false, exhausted: true };
    this.cursor.off += WINDOW_CHARS;
    return { text: row.win, more: !!row.more };
  }

  // n+1, never a count: two rows are asked for and one is returned, so the second row's existence
  // is what `more` reports. Repeating the same words walks the ranking.
  //
  // NOT snippet(): measured on 120 entries of 330 KB, snippet() takes 2,070 ms for two rows because
  // it re-tokenizes each whole body to place its window. instr() is a C byte scan over the same two
  // bodies — 16.6 ms — and it returns a position, so query positions the cursor and `read` produces
  // the window. The model gets a full WINDOW_CHARS around its words instead of 66 chars, and a
  // following `read` continues from there instead of from the top.
  // Every stored word within one edit of a query word, substituted in. A stored payload the model
  // cannot re-derive is unreachable if one mistyped letter is a dead end, and the model has no list
  // op to recover with — so the miss path spends one vocab scan before giving up.
  nearWords(words) {
    let changed = false;
    const out = [];
    for (const w of words) {
      let hit = null;
      if (w.length >= NEAR_MIN_LEN) {
        // Ordered by doc count, so the FIRST near term is the most common one — a tie between two
        // equally-near words is settled by which is actually written more, not by rowid.
        for (const row of this.st.terms.all(w.length - NEAR_EDITS, w.length + NEAR_EDITS)) {
          if (row.term !== w && nearBy(w, row.term)) { hit = row.term; break; }
        }
      }
      out.push(hit ?? w);
      if (hit) changed = true;
    }
    return changed ? out : null;
  }

  // Position on the LONGEST word, not the first: "word sodium" positioned on the first "word",
  // 13 chars in, and handed back a window that never mentioned sodium. Longest is a proxy for most
  // specific — ponytail: no term statistics, so a long common word still beats a short rare one;
  // upgrade to the rarest term (an fts5vocab count) only if that shows up in practice.
  rank(words, n) {
    let anchor = words[0];
    for (let i = 1; i < words.length; i++) if (words[i].length > anchor.length) anchor = words[i];
    return this.st.rank.all(anchor, LEAD_CHARS + 1, words.join(" "), n);
  }

  query(match, rec) {
    const words = plainWords(match);
    const q = words.join(" ");
    rec.match = q;
    const miss = () => ({ found: false, note: this.st.any.get() ? NO_MATCH : NOTHING_STORED });
    if (!words.length) return miss();
    const n = this.cursor?.match === q ? this.cursor.n + 1 : 0;
    let used = words;
    let rows = this.rank(words, n);
    if (!rows.length) {
      const near = this.nearWords(words);
      if (!near) { rec.found = false; return miss(); }
      rows = this.rank(near, n);
      if (!rows.length) { rec.found = false; return miss(); }
      used = near;
    }
    rec.found = true;
    // The cursor tracks the query the ROWS came from, so repeating the mistyped words walks the
    // corrected ranking instead of restarting it at offset 0.
    this.cursor = { subject: rows[0].subject, off: rows[0].off, match: q, n };
    rec.subject = rows[0].subject;
    const out = { found: true, text: this.read(false, rec).text, more: rows.length > 1 };
    // The model is TOLD its words were changed — silently answering a different question than the
    // one asked is the failure this whole retry could otherwise introduce.
    if (used !== words) out.near = used.join(" ");
    return out;
  }

  erase(match, rec) {
    const q = plainWords(match).join(" ");
    rec.match = q || null;
    if (q) this.st.dropMatch.run(q);
    else if (this.cursor) {
      rec.subject = this.cursor.subject;
      this.st.drop.run(this.cursor.subject);
    } else {
      // A bare erase with nothing open used to drop EVERY entry. The model asked to drop "what I
      // am finished with" and lost the whole buffer, including what it had not read yet.
      return { erased: false, note: "No entry is open. Give the words of what to drop." };
    }
    this.cursor = null;
    return { erased: true };
  }

  // Plain objects, not the null-prototype rows node:sqlite returns — this goes straight into a
  // Firestore document, which rejects anything that isn't a plain object.
  snapshot() {
    const entries = [];
    for (const r of this.st.sizes.all()) entries.push({ subject: r.subject, bytes: r.bytes });
    return {
      calls: this.calls,
      entries,
    };
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
    if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

// The record is pushed BEFORE the verb runs: a tool that threw is otherwise indistinguishable from
// one that was never called.
export function runMemoryBufferTool(buff, args) {
  // `op` is a schema-declared string, so it is not type-tested — just folded to lower case ("WRITE"
  // and "Write" are the verb) and length-gated: the longest verb is 5 chars, so anything empty or
  // longer cannot be a verb and is rejected before a single comparison runs. A model that put a
  // whole sentence in `op` otherwise made four string compares against it.
  const raw = args.op?.trim?.().toLowerCase?.() ?? "";
  const op = raw.length > 0 && raw.length <= OP_MAX_LEN ? raw : "";
  const rec = record(buff, op || clip(raw)); // the run doc shows the REJECTED value, not a blank
  let out;
  try {
    switch (op) {
      case "write":
        out = String(args.text ?? "").trim()
          ? buff.write(args.text, rec)
          : { error: "memory_buffer write needs text." };
        break;
      // `restart: "true"` — the STRING — is what llama3.1:8b actually sent on a live run, for an
      // argument the schema declares as a boolean. `=== true` silently ignored it and handed back
      // the next window instead of the first, so the model re-read what it had already seen.
      case "read":
        out = buff.read(args.restart === true || args.restart === "true", rec);
        break;
      case "query":
        out = buff.query(args.match, rec);
        break;
      case "erase":
        out = buff.erase(args.match, rec);
        break;
      default:
        out = { error: "memory_buffer needs op: one of write, read, query, erase." };
    }
  } catch (err) {
    out = { error: err?.message || String(err) };
  }
  if (out.error) rec.error = out.error;
  rec.chars = typeof out.text === "string" ? out.text.length : 0;
  return out;
}
