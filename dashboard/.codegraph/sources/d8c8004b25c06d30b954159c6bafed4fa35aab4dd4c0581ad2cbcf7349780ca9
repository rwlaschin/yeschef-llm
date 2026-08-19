// Neo4j Aura platform API client — instance lifecycle (status / resume). Shared by the health
// badge and the resume endpoint (and any future keep-alive). All calls are tightly timed so a
// slow/unreachable API can never hang the Nitro server.
//
// Creds: AURA_API_CLIENT_ID / AURA_API_CLIENT_SECRET (OAuth client_credentials), *_PROD optional.
// Instance id = the subdomain of NEO4J_URI (neo4j+s://<id>.databases.neo4j.io).
const API = 'https://api.neo4j.io'

const creds = (prod = false) => ({
  cid: (prod && process.env.AURA_API_CLIENT_ID_PROD) || process.env.AURA_API_CLIENT_ID,
  secret: (prod && process.env.AURA_API_CLIENT_SECRET_PROD) || process.env.AURA_API_CLIENT_SECRET,
})
const instanceId = (uri?: string) => uri?.match(/\/\/([^.]+)\./)?.[1]

async function token(prod = false): Promise<string | null> {
  const { cid, secret } = creds(prod)
  if (!cid || !secret) return null
  const r: any = await $fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${cid}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    timeout: 5000,
  })
  return r?.access_token || null
}

// Status cached 30s (incl. failures) — health polls every 5s; without this a down Neo4j makes
// every poll pay two API round-trips, which is what bogged the server.
let _cache: { status: string | null; ts: number } | null = null
export async function auraStatus(neo4jUri?: string, prod = false): Promise<string | null> {
  if (_cache && Date.now() - _cache.ts < 30_000) return _cache.status
  const set = (s: string | null) => { _cache = { status: s, ts: Date.now() }; return s }
  const id = instanceId(neo4jUri)
  if (!id) return set(null)
  try {
    const t = await token(prod)
    if (!t) return set(null)
    const r: any = await $fetch(`${API}/v1/instances/${id}`, { headers: { Authorization: `Bearer ${t}` }, timeout: 5000 })
    return set(r?.data?.status || null)
  } catch {
    return set(null)
  }
}

// Resume a paused instance. Returns the new status ("resuming"); takes ~1 min to reach "running".
export async function auraResume(neo4jUri?: string, prod = false): Promise<{ ok: boolean; status?: string; error?: string }> {
  const id = instanceId(neo4jUri)
  if (!id) return { ok: false, error: 'instance id not derivable from NEO4J_URI' }
  const t = await token(prod)
  if (!t) return { ok: false, error: 'Aura API credentials not configured' }
  try {
    const r: any = await $fetch(`${API}/v1/instances/${id}/resume`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: {}, timeout: 15000 })
    _cache = null // bust the status cache so the badge reflects "resuming" immediately
    return { ok: true, status: r?.data?.status }
  } catch (e: any) {
    const msg = e?.data?.message || e?.data?.errors?.[0]?.message || e?.message || 'resume failed'
    // Already running → Aura rejects the resume; that's success for our purposes (idempotent).
    if (/running/i.test(msg)) return { ok: true, status: 'running' }
    return { ok: false, error: msg }
  }
}
