// Unpause the AuraDB instance via the Aura platform API. Manual trigger (health badge button);
// the same auraResume() helper is what a scheduled keep-alive would call.
export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({}))
  const prod = body?.env === 'production'
  const uri = (prod && process.env.NEO4J_URI_PROD) || process.env.NEO4J_URI

  const res = await auraResume(uri, prod)
  if (!res.ok) {
    throw createError({ statusCode: 502, statusMessage: `Resume failed: ${res.error}` })
  }
  return res // { ok: true, status: 'resuming' } — reaches 'running' in ~1 min
})
