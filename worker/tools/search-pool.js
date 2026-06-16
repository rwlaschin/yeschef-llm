// worker/tools/search-pool.js — free-tier web_search provider pool.
//
// WHY: Ollama's hosted /web_search bills against OLLAMA_API_KEY and 429s when its (small) free quota
// is gone, which terminal-fails grounding steps. We pool several providers' FREE tiers and pick ONE
// per query by WEIGHTED RANDOM (proportional to each provider's free capacity) — NOT priority/drain.
// Spreading is deliberate: the keyless fallback (DDG) is RATE-LIMITED and dies if hammered, and the
// keyed tiers throttle better when load is even. The PROVIDER LIST is hardcoded here (on the box).
//
// QUOTA TRACKING (Firestore, native path — one record PER DAY):
//   tools_limits (collection) / web_search (doc) / <provider> (subcollection) / <YYYY-MM-DD> (doc)
//       { usage, createdAt: <day 00:00 UTC>, expireAt: <createdAt + 30d> }
//   - write = set(.../<today>, { usage: increment(n), createdAt, expireAt }, {merge:true}) — the day
//             is the doc id, so it's exactly 1 record/day with no read-before-write.
//   - gate  = sum `usage` across the <provider> subcollection (<=30 day-docs, TTL-bounded) = rolling
//             30-day total; drop the provider once it's at/over its cap.
//   - TTL on `expireAt` (per provider collection-group; see scripts/setup-firestore-ttl.js) drops
//     stale day-docs, so the subcollection IS the auto-decaying sliding window.
//
// TRANSPORT: node:http(s), NOT global fetch — Node's fetch (undici) has a hidden ~300s headers/body
// timeout that fires independently of our AbortController (it killed healthy Ollama gens; see
// ollama.js). node:http has no built-in timeout, so the AbortController below is the ONLY one. Under
// heavy CPU load the event loop is starved and that timer fires LATE — accepted: the call resolves or
// aborts once the loop frees and routes to the next provider; it never blocks generation (the model
// is paused awaiting the tool result). Searches are SERIALIZED (one socket in flight per query).
import http from "node:http";
import https from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FieldValue } from "firebase-admin/firestore";

const execFileP = promisify(execFile);

const ROOT = "tools_limits";
const TOOL = "web_search";
const HTTP_TIMEOUT_MS = parseInt(process.env.WEB_SEARCH_HTTP_TIMEOUT_MS, 10) || 8000;

// ---- provider table (hardcoded) -------------------------------------------------
// weight   relative PICK PROBABILITY (the "daily est"), ~ free daily capacity. NOT enforced — only
//          biases the weighted-random pick toward roomier providers. brave≈66/day, others ~33.
// cap      the WINDOW TOTAL ("max max") — the provider's whole free quota over the rolling 30 days
//          (brave 2000/mo, tavily 1000/mo, ollama free tier ~1000). The ONLY enforced gate.
// uncapped never gated, chosen only when every capped provider is exhausted (the keyless backstop).
// key()    provider is ENABLED only when its credential is present (no key → silently skipped).
const PROVIDERS = [
  { id: "ollama_api", weight: 33, cap: 1000,     key: () => !!process.env.OLLAMA_API_KEY, search: ollamaSearch },
  { id: "brave_api",  weight: 66, cap: 2000,     key: () => !!process.env.BRAVE_API_KEY,  search: braveSearch  },
  { id: "tavily_api", weight: 33, cap: 1000,     key: () => !!process.env.TAVILY_API_KEY, search: tavilySearch },
  { id: "ddg",        weight: 1,  cap: Infinity, key: () => true, uncapped: true,          search: ddgSearch    },
];

// Provider subcollection names — exported so the TTL setup enables a policy on each collection-group.
export const SEARCH_PROVIDER_GROUPS = PROVIDERS.map((p) => p.id);

// ---- transport ------------------------------------------------------------------
// One-shot request → resolves the raw response-body string. Rejects with an Error carrying .status
// and .auth (401/403) on a non-2xx, so callers can tell a dead key (pin to cap) from a transient
// miss (route around). `label` tags errors per provider/tool.
export function httpRaw(method, urlStr, { headers = {}, body = null, timeoutMs = HTTP_TIMEOUT_MS } = {}, label) {
  const url = new URL(urlStr);
  const lib = url.protocol === "https:" ? https : http;
  const payload = body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
  const reqHeaders = { ...headers };
  if (payload != null) reqHeaders["Content-Length"] = Buffer.byteLength(payload);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method, headers: reqHeaders, signal: ctl.signal }, (res) => {
      res.setEncoding("utf8");
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        clearTimeout(timer);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const e = new Error(`${label} ${res.statusCode} ${res.statusMessage || ""} ${data.slice(0, 200)}`.trim());
          e.status = res.statusCode;
          e.auth = res.statusCode === 401 || res.statusCode === 403;
          return reject(e);
        }
        resolve(data);
      });
    });
    req.once("error", (err) => {
      clearTimeout(timer);
      req.destroy();
      reject(ctl.signal.aborted ? new Error(`${label} timeout ${timeoutMs}ms`) : err);
    });
    if (payload != null) req.write(payload);
    req.end();
  });
}

// JSON variant — the search adapters' transport.
export async function httpJson(method, urlStr, opts = {}, label) {
  const headers = { Accept: "application/json", ...(opts.headers || {}) };
  const data = await httpRaw(method, urlStr, { ...opts, headers }, label);
  try { return JSON.parse(data); }
  catch (err) { throw new Error(`${label} bad JSON: ${err.message}`); }
}

// DDG (duck-duck-scrape) drives its own HTTPS internally — no AbortController hook — so bound it here.
export function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// ---- adapters ------------------------------------------------------------------
// Each adapter: build url → headers → body? → httpJson → map the hits to [{ title, url, content }]
// (the shape condenseToolResult expects). The map normalizes each provider's differing field names
// (brave: description, ollama/tavily: content) and tolerates missing fields.
async function ollamaSearch(query, max_results) {
  const base = process.env.OLLAMA_WEB_BASE || "https://ollama.com/api";
  const url = `${base}/web_search`;
  const headers = { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}`, "Content-Type": "application/json" };
  const body = { query, max_results: Math.min(max_results, 10) }; // Ollama caps max_results at 10
  const j = await httpJson("POST", url, { headers, body }, "ollama_api");
  return (j.results || []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", content: r.content ?? "" }));
}

async function braveSearch(query, max_results) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(max_results, 20)}`;
  const headers = { "X-Subscription-Token": process.env.BRAVE_API_KEY };
  const j = await httpJson("GET", url, { headers }, "brave_api");
  return (j.web?.results || []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", content: r.description ?? "" }));
}

async function tavilySearch(query, max_results) {
  const url = "https://api.tavily.com/search";
  const headers = { Authorization: `Bearer ${process.env.TAVILY_API_KEY}`, "Content-Type": "application/json" };
  const body = { query, max_results: Math.min(max_results, 20), search_depth: "basic" };
  const j = await httpJson("POST", url, { headers, body }, "tavily_api");
  return (j.results || []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", content: r.content ?? "" }));
}

async function ddgSearch(query, max_results) {
  // Dynamic import so the module loads even before the dep is installed (a missing dep just fails DDG,
  // not the whole pool). duck-duck-scrape scrapes DDG's HTML endpoint — keyless, rate-limited.
  const { search, SafeSearchType } = await import("duck-duck-scrape");
  const r = await withTimeout(search(query, { safeSearch: SafeSearchType.MODERATE }), HTTP_TIMEOUT_MS, "ddg");
  return (r.results || []).slice(0, max_results).map((x) => ({ title: x.title ?? "", url: x.url ?? "", content: x.description ?? "" }));
}

// Exported only so search-pool.test.js can exercise an adapter against a local server (the others are
// structurally identical). The pool itself reaches adapters through the PROVIDERS table.
export const __adapters = { ollamaSearch, braveSearch, tavilySearch };

// ---- web_fetch ------------------------------------------------------------------
// Single-URL fetch via CURL — NOT Ollama's hosted /web_fetch (which shares the same metered weekly
// quota as search; once it 429s, every call burns a dead round-trip). curl is in the worker image,
// follows redirects, handles TLS/gzip, and has no quota to exhaust. We then reduce the HTML to text;
// condenseToolResult clips it to WEB_FETCH_CHARS, so we hand back the whole reduced text.
function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"');
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]*\n[ \t]*\n+/g, "\n\n")
    .trim();
}

export async function fetchPage(url) {
  const maxTime = Math.ceil(HTTP_TIMEOUT_MS / 1000);
  let html;
  try {
    const { stdout } = await execFileP(
      "curl",
      ["-sSL", "--compressed", "--max-time", String(maxTime), "-A", "Mozilla/5.0 (compatible; yeschef-bot)", url],
      { maxBuffer: 8 * 1024 * 1024 }
    );
    html = stdout;
  } catch (err) {
    throw new Error(`web_fetch curl failed: ${(err.stderr || err.message || "").toString().trim().slice(0, 200)}`);
  }
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim());
  return { title, url, content: htmlToText(html) };
}

// ---- Firestore quota tracking ---------------------------------------------------
// The current UTC day, clamped to 00:00, plus the matching doc-id and 30-day expiry.
export function today() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const expireAt = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
  return { day: start.toISOString().slice(0, 10), createdAt: start, expireAt };
}

export async function recordUse(db, providerId, n) {
  const { day, createdAt, expireAt } = today();
  const ref = db.doc(`${ROOT}/${TOOL}/${providerId}/${day}`);
  await ref.set({ usage: FieldValue.increment(n), createdAt, expireAt }, { merge: true });
}

// Rolling 30-day usage = sum of the (<=30) day-docs in the provider's subcollection. TTL keeps it small.
export async function windowUsage(db, providerId) {
  const snap = await db.collection(`${ROOT}/${TOOL}/${providerId}`).get();
  let sum = 0;
  snap.forEach((d) => { sum += d.get("usage") || 0; });
  return sum;
}

// ---- selection ------------------------------------------------------------------
// Weighted random WITHOUT replacement → a weighted primary plus a weighted failover ORDER.
function weightedShuffle(items) {
  const pool = items.map((p) => ({ p, w: p.weight }));
  const out = [];
  while (pool.length) {
    const total = pool.reduce((s, x) => s + x.w, 0);
    let r = Math.random() * total;
    let i = 0;
    while (i < pool.length - 1 && (r -= pool[i].w) > 0) i++;
    out.push(pool[i].p);
    pool.splice(i, 1);
  }
  return out;
}

// Pick a provider and run the search. Returns { results, provider } or { error }. Serialized: tries
// providers in (weighted) order, one in flight at a time, until one returns; DDG is the last resort.
//
// FLOW:  get avails → select → RESERVE → use → (on out-of-quota) pin to cap.
//   - RESERVE before the search: the search is SLOW (~seconds) and reserving only AFTER it would
//     leave a long window where N concurrent agents all read "free" and pile past the cap. Bumping
//     usage +1 FIRST (a fast atomic increment) shrinks that race window to the increment latency.
//   - On 429 (out of quota): pin the window sum to its cap (MAX) so it's OFF immediately — one 429
//     turns it off for everyone, instead of leaking +1 at a time. Stored, so it sticks. The SLIDING
//     WINDOW re-enables it on its own as old day-docs TTL-expire (no manual blackball clear).
//
// `deps` is injectable for unit tests (search-pool.test.js); it defaults to the Firestore-backed
// helpers, and `providers` to the hardcoded table, so callers just pass { query, max_results, db }.
export async function searchPool({ query, max_results, db, providers = PROVIDERS, deps = {} }) {
  const record = deps.recordUse || recordUse;
  const usage = deps.windowUsage || windowUsage;

  const enabled = providers.filter((p) => p.key());
  if (!enabled.length) return { error: "web_search: no providers configured" };

  // get avails: window sum per CAPPED provider; uncapped providers are never gated.
  const capped = enabled.filter((p) => !p.uncapped);
  const sums = new Map();
  await Promise.all(capped.map(async (p) => sums.set(p.id, await usage(db, p.id).catch(() => 0))));

  // Everyone under their cap (uncapped always qualifies) goes into ONE weighted pick — fallbacks
  // compete in the random draw by their weight, they're just never dropped by the cap gate.
  const order = weightedShuffle(enabled.filter((p) => p.uncapped || sums.get(p.id) < p.cap));
  if (!order.length) return { error: "web_search: all providers exhausted" };

  let lastErr;
  for (const p of order) {
    await record(db, p.id, 1).catch(() => {}); // RESERVE before use
    try {
      const results = await p.search(query, max_results);
      return { results, provider: p.id };
    } catch (err) {
      lastErr = err;
      // out of quota / dead key → pin the window sum to MAX so the gate drops it next query. We already
      // reserved +1, so the extra delta needed to reach the cap is MAX - (priorSum + 1).
      if ((err.status === 429 || err.auth) && !p.uncapped) {
        const toCap = p.cap - ((sums.get(p.id) ?? 0) + 1);
        if (toCap > 0) await record(db, p.id, toCap).catch(() => {});
      }
      console.warn(`[search-pool] ${p.id} failed: ${err.message} — next provider`);
    }
  }
  return { error: `web_search: all providers failed — ${lastErr?.message || "unknown"}` };
}
