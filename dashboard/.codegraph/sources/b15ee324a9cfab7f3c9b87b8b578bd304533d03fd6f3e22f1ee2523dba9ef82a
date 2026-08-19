import neo4j, { Session } from 'neo4j-driver'

let driver: any = null

function getDriver() {
  if (!driver) {
    const uri = process.env.NEO4J_URI
    const username = process.env.NEO4J_USERNAME
    const password = process.env.NEO4J_PASSWORD

    if (!uri || !username || !password) {
      throw new Error('Neo4j credentials not configured')
    }

    // Tight timeouts: a paused/unreachable instance must fail FAST, never hang the Nitro server.
    driver = neo4j.driver(uri, neo4j.auth.basic(username, password), {
      connectionTimeout: 5000,
      connectionAcquisitionTimeout: 8000,
      maxConnectionPoolSize: 5,
      maxTransactionRetryTime: 5000,
    })
  }
  return driver
}

export default defineEventHandler(async (event) => {
  let session: Session | null = null

  try {
    const body = await readBody(event)
    const { query } = body

    if (!query) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Cypher query is required',
      })
    }

    const driver = getDriver()
    session = driver.session()
    const result = await session.run(query)

    const records = result.records.map((record) => {
      const data: any = {}
      record.keys.forEach((key) => {
        const value = record.get(key)
        data[key] = value && typeof value.properties === 'object' ? value.properties : value
      })
      return data
    })

    return records
  } catch (err) {
    console.error('Neo4j query failed:', err.message)
    // If the instance is paused/resuming, say so plainly (the bolt error is cryptic).
    const state = await auraStatus(process.env.NEO4J_URI)
    if (state && state !== 'running') {
      throw createError({ statusCode: 503, statusMessage: `Neo4j is ${state} — resume the instance and retry.` })
    }
    throw createError({
      statusCode: 500,
      statusMessage: `Neo4j query failed: ${err.message}`,
    })
  } finally {
    if (session) {
      await session.close()
    }
  }
})
