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

    driver = neo4j.driver(uri, neo4j.auth.basic(username, password))
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
    console.error('Neo4j query failed:', err)
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
