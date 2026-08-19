// Graph data for the Explore view — nodes + relationships among them, fetched over Bolt (the
// app's connection). A whole-graph fetch is naturally a single Cypher traversal; the GraphQL
// query tab is separate. Returns a normalized { nodes, relationships } the client renders.
import neo4j, { Session, isInt } from 'neo4j-driver'
import { auraStatus } from '../../utils/aura'

let driver: any = null
function getDriver() {
  if (!driver) {
    const uri = process.env.NEO4J_URI
    const username = process.env.NEO4J_USERNAME
    const password = process.env.NEO4J_PASSWORD
    if (!uri || !username || !password) throw new Error('Neo4j credentials not configured')
    driver = neo4j.driver(uri, neo4j.auth.basic(username, password), {
      connectionTimeout: 5000, connectionAcquisitionTimeout: 8000, maxConnectionPoolSize: 5, maxTransactionRetryTime: 5000,
    })
  }
  return driver
}

// Neo4j Integers → JS numbers; leave everything else as-is (recursively for arrays/objects).
function plain(v: any): any {
  if (isInt(v)) return v.inSafeRange() ? v.toNumber() : v.toString()
  if (Array.isArray(v)) return v.map(plain)
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o: any = {}; for (const k of Object.keys(v)) o[k] = plain(v[k]); return o
  }
  return v
}

export default defineEventHandler(async (event) => {
  let session: Session | null = null
  try {
    const { limit } = await readBody(event).catch(() => ({}))
    const cap = Math.min(Math.max(Number(limit) || 300, 1), 2000)

    session = getDriver().session({ defaultAccessMode: neo4j.session.READ })
    const result = await session.run(
      `MATCH (n) WITH n LIMIT toInteger($limit)
       WITH collect(n) AS ns
       UNWIND ns AS n
       OPTIONAL MATCH (n)-[r]->(m) WHERE m IN ns
       WITH ns, collect(DISTINCT r) AS rs
       RETURN ns AS nodes, rs AS rels`,
      { limit: cap },
    )

    const row = result.records[0]
    const rawNodes = (row?.get('nodes') ?? []) as any[]
    const rawRels = (row?.get('rels') ?? []).filter(Boolean) as any[]

    const nodes = rawNodes.map((n) => ({ id: n.elementId, labels: n.labels as string[], properties: plain(n.properties) }))
    const relationships = rawRels.map((r) => ({
      id: r.elementId, type: r.type, from: r.startNodeElementId, to: r.endNodeElementId, properties: plain(r.properties),
    }))

    return { nodes, relationships }
  } catch (err: any) {
    const state = await auraStatus(process.env.NEO4J_URI)
    if (state && state !== 'running') throw createError({ statusCode: 503, statusMessage: `Neo4j is ${state} — resume the instance and retry.` })
    throw createError({ statusCode: 500, statusMessage: `Neo4j graph fetch failed: ${err.message}` })
  } finally {
    if (session) await session.close()
  }
})
