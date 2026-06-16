// worker/tools/search-pool.test.js — the web_search provider pool.
//   • selection (searchPool): Firestore helpers injected via `deps` → in-memory map, no Firestore.
//   • transport (httpJson/withTimeout) + an adapter: exercised against a local http server.
//   • quota helpers (today/recordUse/windowUsage): exercised against a tiny in-memory Firestore stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { searchPool, httpJson, withTimeout, today, recordUse, windowUsage, fetchPage, __adapters } from "./search-pool.js";

// Start a throwaway http server returning `handler(req)` → { status, json }. Returns { base, close }.
async function localServer(handler) {
  const server = http.createServer((req, res) => {
    const { status = 200, json = {}, raw, stall } = handler(req) || {};
    if (stall) return; // never respond → exercises the client timeout
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(raw != null ? raw : JSON.stringify(json));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

// Minimal Firestore stub: doc(path).set({...},{merge}) applies FieldValue.increment sentinels;
// collection(path).get() yields the day-docs under it with .forEach + d.get(field).
function stubDb() {
  const docs = new Map(); // path -> data
  const incOf = (v) => (v && typeof v === "object" && typeof v.operand === "number" ? v.operand : null);
  return {
    docs,
    doc: (path) => ({
      set: async (data, { merge } = {}) => {
        const prev = merge ? docs.get(path) || {} : {};
        const next = { ...prev };
        for (const [k, v] of Object.entries(data)) {
          const inc = incOf(v);
          next[k] = inc != null ? (next[k] || 0) + inc : v;
        }
        docs.set(path, next);
      },
    }),
    collection: (prefix) => ({
      get: async () => {
        const hits = [...docs.entries()].filter(([p]) => p.startsWith(`${prefix}/`));
        return { forEach: (fn) => hits.forEach(([, data]) => fn({ get: (f) => data[f] })) };
      },
    }),
  };
}

// In-memory stand-in for the Firestore window-usage store. windowUsage returns the running sum;
// recordUse adds to it — exactly what the real day-doc increment + 30-day subcollection sum do.
function fakeStore(initial = {}) {
  const usage = new Map(Object.entries(initial));
  return {
    usage,
    deps: {
      windowUsage: async (_db, id) => usage.get(id) || 0,
      recordUse: async (_db, id, n) => usage.set(id, (usage.get(id) || 0) + n),
    },
  };
}

const HIT = [{ title: "t", url: "u", content: "c" }];
const provider = (id, opts = {}) => ({
  id,
  weight: opts.weight ?? 1,
  cap: opts.cap ?? 100,
  uncapped: opts.uncapped ?? false,
  key: () => opts.key ?? true,
  search: opts.search ?? (async () => HIT),
});

test("returns results from an enabled provider and RESERVES +1", async () => {
  const store = fakeStore();
  const res = await searchPool({ query: "q", max_results: 3, db: null, providers: [provider("a")], deps: store.deps });
  assert.equal(res.provider, "a");
  assert.deepEqual(res.results, HIT);
  assert.equal(store.usage.get("a"), 1); // reserved
});

test("reserve happens BEFORE the (slow) search", async () => {
  const store = fakeStore();
  let usageAtSearchTime = -1;
  const a = provider("a", { search: async () => { usageAtSearchTime = store.usage.get("a") || 0; return HIT; } });
  await searchPool({ query: "q", max_results: 3, db: null, providers: [a], deps: store.deps });
  assert.equal(usageAtSearchTime, 1); // the +1 was already written when search ran
});

test("skips a provider already at/over its cap", async () => {
  const store = fakeStore({ a: 100 }); // a is at cap
  const res = await searchPool({
    query: "q", max_results: 3, db: null,
    providers: [provider("a", { cap: 100 }), provider("b")],
    deps: store.deps,
  });
  assert.equal(res.provider, "b");
});

test("on 429, pins the provider's window sum to its cap (off now)", async () => {
  // Single provider → deterministic (no random draw); asserts the pin math, not the routing.
  const store = fakeStore({ a: 50 });
  const a = provider("a", { cap: 200, search: async () => { const e = new Error("quota"); e.status = 429; throw e; } });
  const res = await searchPool({ query: "q", max_results: 3, db: null, providers: [a], deps: store.deps });
  assert.equal(store.usage.get("a"), 200); // 50 prior + 1 reserve + 149 pin = cap
  assert.match(res.error, /all providers failed/);
});

test("auth failure (401) also pins to cap", async () => {
  const store = fakeStore({ a: 0 });
  const a = provider("a", { cap: 100, search: async () => { const e = new Error("bad key"); e.status = 401; e.auth = true; throw e; } });
  await searchPool({ query: "q", max_results: 3, db: null, providers: [a], deps: store.deps });
  assert.equal(store.usage.get("a"), 100);
});

test("falls back to the uncapped provider when all capped are exhausted", async () => {
  const store = fakeStore({ a: 100, b: 100 });
  const res = await searchPool({
    query: "q", max_results: 3, db: null,
    providers: [provider("a"), provider("b"), provider("ddg", { uncapped: true })],
    deps: store.deps,
  });
  assert.equal(res.provider, "ddg");
});

test("uncapped provider competes IN the weighted pick (not just last-resort)", async () => {
  // a has weight 0 → the weighted draw lands on ddg first even though a is under cap. Proves the
  // uncapped fallback is part of the random pick, not appended after it.
  const store = fakeStore({ a: 0 });
  const a = provider("a", { weight: 0, search: async () => HIT });
  const ddg = provider("ddg", { uncapped: true, weight: 1, search: async () => [{ title: "d", url: "d", content: "d" }] });
  const res = await searchPool({ query: "q", max_results: 3, db: null, providers: [a, ddg], deps: store.deps });
  assert.equal(res.provider, "ddg");
});

test("transient error (5xx) does NOT pin to cap — just routes on", async () => {
  const store = fakeStore({ a: 0 });
  const a = provider("a", { cap: 100, search: async () => { const e = new Error("boom"); e.status = 503; throw e; } });
  const res = await searchPool({ query: "q", max_results: 3, db: null, providers: [a], deps: store.deps });
  assert.equal(store.usage.get("a"), 1); // only the reserve, no pin
  assert.match(res.error, /all providers failed/);
});

test("error when no providers are configured (no keys)", async () => {
  const store = fakeStore();
  const res = await searchPool({ query: "q", max_results: 3, db: null, providers: [provider("a", { key: false })], deps: store.deps });
  assert.match(res.error, /no providers configured/);
});

test("error when every provider (incl. uncapped) failed", async () => {
  const store = fakeStore();
  const boom = async () => { throw new Error("down"); };
  const res = await searchPool({
    query: "q", max_results: 3, db: null,
    providers: [provider("a", { search: boom }), provider("ddg", { uncapped: true, search: boom })],
    deps: store.deps,
  });
  assert.match(res.error, /all providers failed/);
});

// ---- transport: httpJson ----------------------------------------------------------
test("httpJson: 2xx returns parsed JSON", async () => {
  const srv = await localServer(() => ({ status: 200, json: { ok: 1 } }));
  try {
    assert.deepEqual(await httpJson("GET", srv.base, {}, "t"), { ok: 1 });
  } finally { srv.close(); }
});

test("httpJson: non-2xx rejects with .status and .auth=false", async () => {
  const srv = await localServer(() => ({ status: 404, json: { e: "nope" } }));
  try {
    await assert.rejects(httpJson("GET", srv.base, {}, "t"), (e) => e.status === 404 && e.auth === false);
  } finally { srv.close(); }
});

test("httpJson: 401 sets .auth=true", async () => {
  const srv = await localServer(() => ({ status: 401, json: {} }));
  try {
    await assert.rejects(httpJson("GET", srv.base, {}, "t"), (e) => e.status === 401 && e.auth === true);
  } finally { srv.close(); }
});

test("httpJson: malformed body rejects as bad JSON", async () => {
  const srv = await localServer(() => ({ status: 200, raw: "not json" }));
  try {
    await assert.rejects(httpJson("GET", srv.base, {}, "t"), /bad JSON/);
  } finally { srv.close(); }
});

test("httpJson: POST sends the body and times out when the server stalls", async () => {
  let received;
  const srv = await localServer((req) => { received = req.method; return { stall: true }; }); // never responds
  try {
    await assert.rejects(httpJson("POST", srv.base, { body: { a: 1 }, timeoutMs: 50 }, "t"), /timeout 50ms/);
    assert.equal(received, "POST");
  } finally { srv.close(); }
});

// ---- transport: withTimeout -------------------------------------------------------
test("withTimeout: resolves, propagates rejection, and fires on timeout", async () => {
  assert.equal(await withTimeout(Promise.resolve("v"), 100, "x"), "v");
  await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 100, "x"), /boom/);
  await assert.rejects(withTimeout(new Promise(() => {}), 20, "x"), /x timeout 20ms/);
});

// ---- adapter: ollamaSearch against a local server (others are structurally identical) -------------
test("ollamaSearch maps results and tolerates missing fields", async () => {
  const srv = await localServer(() => ({ status: 200, json: { results: [{ title: "T", url: "U", content: "C" }, {}] } }));
  const prev = process.env.OLLAMA_WEB_BASE;
  process.env.OLLAMA_WEB_BASE = srv.base;
  try {
    const out = await __adapters.ollamaSearch("q", 3);
    assert.deepEqual(out, [{ title: "T", url: "U", content: "C" }, { title: "", url: "", content: "" }]);
  } finally { process.env.OLLAMA_WEB_BASE = prev; srv.close(); }
});

// ---- quota helpers: today / recordUse / windowUsage -------------------------------
test("today: UTC-midnight createdAt, matching day id, +30d expiry", () => {
  const { day, createdAt, expireAt } = today();
  assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(createdAt.toISOString().slice(0, 10), day);
  assert.equal(createdAt.getUTCHours(), 0);
  assert.equal(expireAt.getTime() - createdAt.getTime(), 30 * 24 * 60 * 60 * 1000);
});

test("recordUse increments today's day-doc; windowUsage sums the subcollection", async () => {
  const db = stubDb();
  await recordUse(db, "brave_api", 1);
  await recordUse(db, "brave_api", 4);
  assert.equal(await windowUsage(db, "brave_api"), 5);
  assert.equal(await windowUsage(db, "tavily_api"), 0); // unrelated provider untouched

  const { day } = today();
  const doc = db.docs.get(`tools_limits/web_search/brave_api/${day}`);
  assert.equal(doc.usage, 5);
  assert.ok(doc.createdAt instanceof Date && doc.expireAt instanceof Date);
});

test("windowUsage sums across multiple day-docs", async () => {
  const db = stubDb();
  await db.doc("tools_limits/web_search/brave_api/2026-06-10").set({ usage: 30 }, { merge: true });
  await db.doc("tools_limits/web_search/brave_api/2026-06-11").set({ usage: 12 }, { merge: true });
  assert.equal(await windowUsage(db, "brave_api"), 42);
});

// ---- web_fetch: fetchPage (curl) --------------------------------------------------
test("fetchPage curls the URL and reduces HTML to title + text", async () => {
  const srv = await localServer(() => ({
    status: 200,
    raw: "<html><head><title>Hi &amp; Bye</title></head><body><p>Hello</p><script>var x=1;</script><p>World</p></body></html>",
  }));
  try {
    const out = await fetchPage(srv.base);
    assert.equal(out.title, "Hi & Bye");
    assert.match(out.content, /Hello/);
    assert.match(out.content, /World/);
    assert.doesNotMatch(out.content, /var x=1/); // <script> stripped
  } finally { srv.close(); }
});
