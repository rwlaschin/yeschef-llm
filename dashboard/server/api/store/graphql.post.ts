// Server-side proxy for the Neo4j Aura GraphQL API. The browser can't call the Aura endpoint
// directly — it's cross-origin (CORS-blocked) and would expose the Basic-auth credentials. The
// client posts { query, variables, env } here; we attach the creds server-side and forward.
// Env toggle mirrors health.get.ts: prefer *_PROD when present, fall back to the base vars.
export default defineEventHandler(async (event) => {
  const { query, variables, env } = await readBody(event)

  if (!query) {
    throw createError({ statusCode: 400, statusMessage: 'GraphQL query is required' })
  }

  const prod = env === 'production'
  const endpoint = (prod && process.env.GRAPHQL_ENDPOINT_PROD) || process.env.GRAPHQL_ENDPOINT
  const username = (prod && process.env.NEO4J_USERNAME_PROD) || process.env.NEO4J_USERNAME
  const password = (prod && process.env.NEO4J_PASSWORD_PROD) || process.env.NEO4J_PASSWORD

  if (!endpoint || !username || !password) {
    throw createError({ statusCode: 500, statusMessage: 'Neo4j GraphQL endpoint/credentials not configured' })
  }

  const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')

  try {
    // GraphQL transport: errors come back in the 200 body as { errors }, so pass the body through
    // verbatim — the client already distinguishes res.errors from res.data.
    return await $fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: { query, variables },
    })
  } catch (err: any) {
    // Non-2xx (auth failure, endpoint down) — surface the upstream message.
    const detail = err?.data?.message || err?.data || err?.message || 'request failed'
    console.error('Neo4j GraphQL proxy failed:', detail)
    throw createError({ statusCode: 502, statusMessage: `Neo4j GraphQL request failed: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` })
  }
})
