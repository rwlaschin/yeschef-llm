// functions/lib/mongo.js — shared (global) MongoDB client for the orchestrator function.
//
// ONE client per process, cached on globalThis so it survives module re-evaluation and is reused
// across invocations (Cloud Run keeps the container warm) — never a new connection per request.
// Same resilient options the worker (worker/index.js) and dashboard (server/utils/mongo.ts) use, so
// a network blip fails fast + retries instead of hanging. Reads MONGO_URI / MONGO_DB from the env
// (wired into the dev emulator by scripts/dev.js and into the deployed function at deploy time).
import { MongoClient } from "mongodb";

const DB = () => process.env.MONGO_DB || "yeschef";

const OPTIONS = {
  serverSelectionTimeoutMS: 8000,
  socketTimeoutMS: 45000,
  heartbeatFrequencyMS: 5000,
  maxIdleTimeMS: 30000,
  retryReads: true,
  retryWrites: true,
};

function client() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI not set — the orchestrator needs it to reach Mongo (plan_library)");
  }
  if (!globalThis.__yclMongo) {
    const c = new MongoClient(process.env.MONGO_URI, OPTIONS);
    // Cache the connect PROMISE; on failure drop it so the next call reconnects on a fresh network.
    globalThis.__yclMongo = c.connect().catch((e) => { globalThis.__yclMongo = null; throw e; });
  }
  return globalThis.__yclMongo;
}

export async function getCollection(name) {
  const c = await client();
  return c.db(DB()).collection(name);
}
