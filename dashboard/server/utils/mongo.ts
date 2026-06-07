import { MongoClient } from 'mongodb'

// HMR-safe MongoDB client cache that also RECOVERS from network changes.
//
// Two problems this solves:
//  1) HMR leak: Nitro/Vite reload server modules on edit; a module-level client
//     would be dropped (not closed) each reload and leak connection pools until
//     Atlas's cap is hit. globalThis survives HMR, so we cache one client per URI.
//  2) Network switching (laptop WiFi/VPN/sleep): with default options a query
//     hangs ~30s on an empty topology (routers=[], readers=[], writers=[]). We
//     tune the driver to fail fast + retry and to heartbeat often, so its built-in
//     monitoring (SDAM) rediscovers the cluster on the new network automatically.
//     evict-on-topology-death is a safety net to rebuild a client that truly dies.
const store: Map<string, Promise<MongoClient>> =
  (globalThis as any).__mongoClients ||= new Map()

const OPTIONS = {
  maxPoolSize: 20,
  // Fail an op in a few seconds (instead of hanging ~30s) when the topology is
  // empty after a network change — pairs with retry below for transparent recovery.
  serverSelectionTimeoutMS: 8000,
  socketTimeoutMS: 45000,
  // Detect topology changes faster, and drop sockets stranded by the old network.
  heartbeatFrequencyMS: 5000,
  maxIdleTimeMS: 30000,
  retryReads: true,
  retryWrites: true,
}

function connect(uri: string): Promise<MongoClient> {
  const p = (async () => {
    const client = new MongoClient(uri, OPTIONS)
    // If the topology dies (network gone), drop this cached client so the next
    // getMongoClient() builds a fresh one that rediscovers on the new network.
    const evict = () => { if (store.get(uri) === p) store.delete(uri) }
    client.on('error', evict)
    client.on('topologyClosed', evict)
    try {
      await client.connect()
      return client
    } catch (err) {
      store.delete(uri)
      throw err
    }
  })()
  store.set(uri, p)
  return p
}

// Return the cached client (or connect once). No per-call liveness ping: the
// driver's SDAM monitoring rediscovers the cluster on its own after a network
// change, and the caller's query already fails fast + retries via the options
// above — so recovery is automatic without doubling round-trips.
export function getMongoClient(uri: string): Promise<MongoClient> {
  return store.get(uri) || connect(uri)
}
