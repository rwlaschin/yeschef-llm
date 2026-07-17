// JWT gate for /ai. Verifies a Firebase ID token (Bearer) on every request except
// the routes that must stay open:
//   /health  — liveness probe
//   /events  — Pub/Sub PUSH (Google OIDC token, NOT a user token)
//
// Mirrors the dnd-community-and-marketplace verifyJWT: an LRU cache keyed by the raw
// token holds the decoded token until just before its `exp`, so repeated calls in a
// burst skip the round-trip — but ~5% of hits re-verify anyway so a revoked/disabled
// token can't ride a cached entry for long. The decoded token (uid + custom claims:
// role/companyId/isSuper) is attached as req.user.
import { getAuth } from "firebase-admin/auth";
import { LRUCache } from "lru-cache";

const PUBLIC = new Set(["/health", "/events", "/categorize", "/capacity-detect"]);
const CACHE_MAX = 2000;
const SKEW_MS = 60 * 1000;       // expire cache entries a minute before the token does
const REVERIFY_RATE = 0.05;      // 5% of cache hits re-verify against Firebase

// Token → decoded-token cache. Needs lru-cache v10+ (named LRUCache export + per-set {ttl}).
const cache = new LRUCache({ max: CACHE_MAX });

export async function requireAuth(req, reply) {
  if (req.raw.method === "OPTIONS") return; // CORS preflight
  const url = (req.routeOptions?.url || req.url || "").split("?")[0];
  if (PUBLIC.has(url)) return;

  const hdr = req.headers["authorization"] || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : null;
  if (!token) {
    reply.code(401).send({ error: "Unauthorized" });
    return reply;
  }

  // Cache hit (most of the time) — skip the round-trip.
  if (Math.random() >= REVERIFY_RATE) {
    const cached = cache.get(token);
    if (cached) { req.user = cached; return; }
  }

  try {
    const decoded = await getAuth().verifyIdToken(token);
    const expMs = typeof decoded?.exp === "number" ? decoded.exp * 1000 : null;
    const ttl = expMs != null ? Math.max(0, expMs - Date.now() - SKEW_MS) : 0;
    if (ttl > 0) cache.set(token, decoded, { ttl });
    req.user = decoded;
  } catch {
    reply.code(401).send({ error: "Unauthorized" });
    return reply;
  }
}
