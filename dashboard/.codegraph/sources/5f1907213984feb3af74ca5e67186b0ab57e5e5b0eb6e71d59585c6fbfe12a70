// Neo4j GraphQL — run IN-PROCESS via the Neo4j GraphQL Library over the Bolt driver (the same
// connection the app uses). Aura does NOT expose an HTTP GraphQL endpoint, so the old approach of
// POSTing to a URL got a 403 from the DB host. Here we instead:
//   1. introspect the live graph → GraphQL type definitions (@neo4j/introspector)
//   2. build an executable schema from them (@neo4j/graphql)
//   3. execute the client's query/introspection against that schema (translates to Cypher)
// The schema is cached per env so we only introspect once.
import neo4j from 'neo4j-driver'
import { Neo4jGraphQL } from '@neo4j/graphql'
import { toGraphQLTypeDefs } from '@neo4j/introspector'
import { graphql, type GraphQLSchema } from 'graphql'

type Built = { driver: any; schema: GraphQLSchema }
const cache: Record<string, Promise<Built>> = {}

function makeDriver(prod: boolean) {
  const uri = (prod && process.env.NEO4J_URI_PROD) || process.env.NEO4J_URI
  const username = (prod && process.env.NEO4J_USERNAME_PROD) || process.env.NEO4J_USERNAME
  const password = (prod && process.env.NEO4J_PASSWORD_PROD) || process.env.NEO4J_PASSWORD
  if (!uri || !username || !password) throw new Error('Neo4j credentials not configured')
  // Tight timeouts: a paused/unreachable instance must fail fast, never hang Nitro.
  return neo4j.driver(uri, neo4j.auth.basic(username, password), {
    connectionTimeout: 5000,
    connectionAcquisitionTimeout: 8000,
    maxConnectionPoolSize: 5,
    maxTransactionRetryTime: 5000,
  })
}

async function build(prod: boolean): Promise<Built> {
  const driver = makeDriver(prod)
  const sessionFactory = () => driver.session({ defaultAccessMode: neo4j.session.READ })
  const typeDefs = await toGraphQLTypeDefs(sessionFactory)   // generate the schema from the live graph
  const neoSchema = new Neo4jGraphQL({ typeDefs, driver })
  const schema = await neoSchema.getSchema()
  return { driver, schema }
}

export default defineEventHandler(async (event) => {
  const { query, variables, env } = await readBody(event)
  if (!query) throw createError({ statusCode: 400, statusMessage: 'GraphQL query is required' })

  const prod = env === 'production'
  const key = prod ? 'prod' : 'local'

  try {
    // Build (and cache) the schema; on failure drop the cache so the next attempt retries.
    if (!cache[key]) cache[key] = build(prod).catch((e) => { delete cache[key]; throw e })
    const { schema, driver } = await cache[key]

    // Execute against the schema — introspection and data queries both flow through here.
    // Result is { data, errors }, which is exactly what the client already expects.
    return await graphql({ schema, source: query, variableValues: variables, contextValue: { executionContext: driver } })
  } catch (err: any) {
    const detail = err?.message || 'request failed'
    console.error('Neo4j GraphQL failed:', detail)
    throw createError({ statusCode: 502, statusMessage: `Neo4j GraphQL request failed: ${detail}` })
  }
})
