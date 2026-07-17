import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getWorkerRegions, getWorkerRegionNames, _resetRegionCache } from "./regions.js";
import { SEED_REGIONS } from "../../../config/regions.js";

// regions.js resolves Mongo via functions/lib/mongo.js (getCollection → MongoClient off MONGO_URI)
// and GCP via global fetch (metadata token/project-id + acceleratorTypes). Both are injected here
// through those exact seams — no real Mongo, no real GCP. getWorkerRegions() also keeps an in-process
// cache (the ~5% refresh); _resetRegionCache() clears it between tests.

const realFetch = globalThis.fetch;
const realUri = process.env.MONGO_URI;
const realRandom = Math.random;

// Fake Mongo collection over an in-memory doc map (keyed by _id). Records writes AND counts reads so
// the in-process-cache test can prove a cached read touches Mongo zero times.
function fakeCollection(docs = [], { throwOnFind = false } = {}) {
  const store = new Map((Array.isArray(docs) ? docs : [docs]).filter(Boolean).map((d) => [d._id, { ...d }]));
  const writes = [];
  let reads = 0;
  const coll = {
    async findOne(q) {
      reads++;
      if (throwOnFind) throw new Error("mongo down");
      return store.get(q._id) || null;
    },
    async updateOne(q, update, opts) {
      writes.push({ q, update, opts });
      const cur = store.get(q._id) || { _id: q._id };
      store.set(q._id, { ...cur, ...(update.$set || {}), ...(update.$setOnInsert || {}) });
    },
  };
  return { coll, writes, store, get reads() { return reads; } };
}

function installMongo(fake) {
  process.env.MONGO_URI = "mongodb://fake/db";
  if (fake === null) {
    globalThis.__yclMongo = Promise.reject(new Error("mongo unreachable"));
    globalThis.__yclMongo.catch(() => {});
    return;
  }
  globalThis.__yclMongo = Promise.resolve({ db: () => ({ collection: () => fake.coll }) });
}

function installFetch({ zones = {}, failMetadata = false, failCompute = false } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/service-accounts/default/token")) {
      if (failMetadata) return { ok: false, status: 500, async text() { return ""; } };
      return { ok: true, async text() { return JSON.stringify({ access_token: "tok" }); } };
    }
    if (u.includes("/project/project-id")) return { ok: true, async text() { return "proj-123"; } };
    if (u.includes("acceleratorTypes")) {
      if (failCompute) return { ok: false, status: 503, async text() { return "compute down"; } };
      const items = {};
      for (const [zone, hasL4] of Object.entries(zones)) {
        items[`zones/${zone}`] = { acceleratorTypes: hasL4 ? [{ name: "nvidia-l4" }] : [] };
      }
      return { ok: true, async json() { return { items }; } };
    }
    throw new Error(`unexpected fetch ${u}`);
  };
}

const CONFIG_US = { _id: "config", regionFilter: "us-" };
const fresh = (regions) => ({ _id: "l4_regions", fetchedAt: Date.now() - 60_000, regions });

beforeEach(() => {
  delete globalThis.__yclMongo;
  _resetRegionCache();
  // GCP project comes from env first — clear it so tests drive discovery through the fetch stub.
  delete process.env.GCP_PROJECT_ID;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Math.random = realRandom;
  if (realUri === undefined) delete process.env.MONGO_URI;
  else process.env.MONGO_URI = realUri;
  delete globalThis.__yclMongo;
});

test("fresh topology + us filter → returns filtered topology, no GCP call, no writes", async () => {
  const fake = fakeCollection([CONFIG_US, fresh([["us-east4", ["a", "c"]], ["us-west1", ["a", "b", "c"]]])]);
  installMongo(fake);
  globalThis.fetch = async () => { throw new Error("GCP must not be called on a fresh cache"); };

  const out = await getWorkerRegions();
  assert.deepEqual(out, [["us-east4", ["a", "c"]], ["us-west1", ["a", "b", "c"]]]);
  assert.equal(fake.writes.length, 0, "fresh cache + seeded config must not write");
});

test("region filter drops non-matching regions (only us- kept)", async () => {
  const fake = fakeCollection([CONFIG_US, fresh([["us-east4", ["a"]], ["europe-west4", ["a", "b"]], ["asia-south1", ["a"]]])]);
  installMongo(fake);

  const out = await getWorkerRegions();
  assert.deepEqual(out.map(([r]) => r), ["us-east4"]);
});

test("custom filter body is anchored as ^(body) — us OR europe kept, asia dropped", async () => {
  const fake = fakeCollection([{ _id: "config", regionFilter: "us-|europe-" }, fresh([["us-east4", ["a"]], ["europe-west4", ["a"]], ["asia-south1", ["a"]]])]);
  installMongo(fake);

  const out = await getWorkerRegions();
  assert.deepEqual(out.map(([r]) => r).sort(), ["europe-west4", "us-east4"]);
});

test("invalid region filter throws BAD_REGION_FILTER (surfaced to UI, never swallowed)", async () => {
  const fake = fakeCollection([{ _id: "config", regionFilter: "us-(" }, fresh([["us-east4", ["a"]]])]);
  installMongo(fake);

  await assert.rejects(getWorkerRegions(), (e) => e.code === "BAD_REGION_FILTER");
});

test("missing config doc → seeds default us- filter and applies it", async () => {
  const fake = fakeCollection([fresh([["us-east4", ["a"]], ["europe-west4", ["a"]]])]); // no config doc
  installMongo(fake);

  const out = await getWorkerRegions();
  assert.deepEqual(out.map(([r]) => r), ["us-east4"]);
  const seed = fake.writes.find((w) => w.q._id === "config");
  assert.ok(seed, "seeded the default config");
  assert.equal(seed.update.$setOnInsert.regionFilter, "us-");
});

test("missing topology → discovery caches the full [region,[zones]] shape (us-only after filter)", async () => {
  const fake = fakeCollection([CONFIG_US]); // config present, topology absent
  installMongo(fake);
  installFetch({ zones: { "us-east4-a": true, "us-east4-b": false, "us-east4-c": true, "us-west2-a": false } });

  const out = await getWorkerRegions();
  assert.deepEqual(out, [["us-east4", ["a", "c"]]]);
  const topoWrite = fake.writes.find((w) => w.q._id === "l4_regions");
  assert.ok(topoWrite, "discovery cached the topology");
  assert.equal(typeof topoWrite.update.$set.fetchedAt, "number");
});

test("in-process cache: ~95% of reads serve the cache and touch Mongo zero times", async () => {
  const fake = fakeCollection([CONFIG_US, fresh([["us-east4", ["a"]]])]);
  installMongo(fake);

  await getWorkerRegions();                 // cold load
  const readsAfterLoad = fake.reads;
  Math.random = () => 0.9;                   // > 0.05 → serve cache
  await getWorkerRegions();
  await getWorkerRegions();
  assert.equal(fake.reads, readsAfterLoad, "cached reads must not hit Mongo");

  Math.random = () => 0.01;                  // < 0.05 → refresh
  await getWorkerRegions();
  assert.ok(fake.reads > readsAfterLoad, "a 5% refresh re-reads Mongo");
});

test("falls back to SEED_REGIONS when BOTH GCP and Mongo are unavailable", async () => {
  installMongo(null);
  installFetch({ failCompute: true });
  assert.deepEqual(await getWorkerRegions(), SEED_REGIONS);
});

test("getWorkerRegionNames maps the resolver output to names", async () => {
  installMongo(fakeCollection([CONFIG_US, fresh([["us-east4", ["a", "c"]], ["us-west1", ["a"]]])]));
  assert.deepEqual(await getWorkerRegionNames(), ["us-east4", "us-west1"]);
});
