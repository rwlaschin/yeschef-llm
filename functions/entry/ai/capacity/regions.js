// Dynamic L4 region/zone discovery — the SINGLE source of the worker-MIG topology, for both the
// capacity-steering controller (docs/plans/capacity-steering/plan.md) and the deploy/rollback
// scripts. The `[region, [zoneLetters]]` set is the regions/zones that actually offer `nvidia-l4`,
// queried live from the Compute API and cached daily in Mongo — NOT a hardcoded list.
// config/regions.js (SEED_REGIONS) is the seed/override fallback only: used when the live query
// can't run (off-GCE: no metadata token) or errors (any GCP failure) AND the Mongo cache is also
// unavailable. So this is no-op-safe in dev — it just returns the seed and touches no GCP.
import { execSync } from "node:child_process";
import { getCollection } from "../../../lib/mongo.js";
import { SEED_REGIONS, ACCELERATOR } from "../../../config/regions.js";

const META = "http://metadata.google.internal/computeMetadata/v1";
const META_HDR = { headers: { "Metadata-Flavor": "Google" } };
const META_TOKEN = "instance/service-accounts/default/token";

const META_COLL = "region_capacity_meta";
const CACHE_DOC = "l4_regions";     // discovered topology
const CONFIG_DOC = "config";        // region filter + other rarely-changing config
const DEFAULT_FILTER = "us-";       // we only run US right now; there is NO "all regions" mode
const REFRESH_MS = 24 * 60 * 60 * 1000;  // GCP topology re-query cadence (Mongo doc staleness)
const REFRESH_RATE = 0.05;          // in-process cache: ~5% of reads re-read config from Mongo

// Metadata read with a fast timeout so an off-GCE box (local deploy) fails to the gcloud path in
// ~1s instead of hanging on the unresolvable metadata host.
async function meta(path) {
  const r = await fetch(`${META}/${path}`, { ...META_HDR, signal: AbortSignal.timeout(1000) });
  if (!r.ok) throw new Error(`metadata ${path} → ${r.status}`);
  return (await r.text()).trim();
}

// ADC access token: the GCE metadata server on Cloud Run (the controller), else the gcloud CLI's
// ADC on a local box (deploy.js / rollback.js run off-GCE). Neither available → throws → the caller
// falls back to SEED_REGIONS. This is what makes the DEPLOY path read the live API too, not the seed.
async function adcToken() {
  try {
    return JSON.parse(await meta(META_TOKEN)).access_token;
  } catch {
    return execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
  }
}

// GCP project id: prefer the explicit env (set on Cloud Run AND by the deploy scripts' dotenv), then
// the metadata server, then gcloud config. `gcloud config get-value project` is often empty on a box
// that sets the project via env/--project, so it can't be the primary source. aggregatedList is
// project-scoped and accepts the project-id string.
async function projectId() {
  const env =
    process.env.GCP_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.CLOUDSDK_CORE_PROJECT;
  if (env) return env;
  try {
    return await meta("project/project-id");
  } catch {
    return execSync("gcloud config get-value project", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  }
}

// Live query: acceleratorTypes.aggregatedList, keyed by `zones/<zone>`; keep scopes whose list
// contains nvidia-l4, and derive the FULL `[region, [zoneLetters]]` shape (e.g. zone us-east4-c →
// region us-east4, letter c), grouping the letters under their region.
async function queryL4Regions() {
  const [token, project] = await Promise.all([adcToken(), projectId()]);
  const url = `https://compute.googleapis.com/compute/v1/projects/${project}/aggregated/acceleratorTypes?filter=${encodeURIComponent(`name=${ACCELERATOR}`)}`;
  const byRegion = new Map(); // region → Set(zoneLetters)
  let pageToken;
  do {
    const u = pageToken ? `${url}&pageToken=${encodeURIComponent(pageToken)}` : url;
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`acceleratorTypes.aggregatedList → ${r.status} ${(await r.text()).slice(0, 200)}`);
    const body = await r.json();
    for (const [scope, entry] of Object.entries(body.items || {})) {
      const hasL4 = (entry.acceleratorTypes || []).some((a) => a.name === ACCELERATOR);
      if (!hasL4) continue;
      const zone = scope.startsWith("zones/") ? scope.slice("zones/".length) : null;
      const m = zone && zone.match(/^(.*)-([a-z])$/); // us-east4-c → ["…","us-east4","c"]
      if (!m) continue;
      const [, region, letter] = m;
      if (!byRegion.has(region)) byRegion.set(region, new Set());
      byRegion.get(region).add(letter);
    }
    pageToken = body.nextPageToken;
  } while (pageToken);
  return [...byRegion.entries()]
    .map(([region, letters]) => [region, [...letters].sort()])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

// Region filter (config, stored in Mongo region_capacity_meta/config as a regex BODY; default "us-").
// Code anchors it as ^(<body>) — the caller stores the alternation, we add the anchor. There is NO
// "all regions" mode: an invalid regex is NOT swallowed — it throws BAD_REGION_FILTER so the
// dashboard surfaces the error instead of silently steering everywhere or nowhere. Seeds the default
// on first read.
async function loadRegionFilter(meta) {
  const doc = await meta.findOne({ _id: CONFIG_DOC });
  if (doc?.regionFilter == null) {
    await meta.updateOne({ _id: CONFIG_DOC }, { $setOnInsert: { regionFilter: DEFAULT_FILTER } }, { upsert: true });
  }
  const body = doc?.regionFilter ?? DEFAULT_FILTER;
  try {
    return new RegExp(`^(${body})`);
  } catch (e) {
    const err = new Error(`Invalid region filter /^(${body})/: ${e.message}`);
    err.code = "BAD_REGION_FILTER";
    throw err;
  }
}

// GCP-facing topology layer: serve the Mongo doc when < 24h old, else re-query Compute and refresh
// it. The in-process 5% cache in getWorkerRegions() sits ABOVE this, so most reads touch neither.
async function loadTopology(meta) {
  const cached = await meta.findOne({ _id: CACHE_DOC });
  if (cached && Date.now() - (cached.fetchedAt || 0) < REFRESH_MS && Array.isArray(cached.regions) && cached.regions.length) {
    return cached.regions;
  }
  const regions = await queryL4Regions();
  if (regions.length) {
    await meta.updateOne({ _id: CACHE_DOC }, { $set: { regions, fetchedAt: Date.now() } }, { upsert: true });
    return regions;
  }
  return cached?.regions || SEED_REGIONS;
}

// Resolve the filtered topology from Mongo/GCP: discovered `[region,[zones]]` kept only where the
// region matches the DB region filter.
async function loadWorkerRegions() {
  const meta = await getCollection(META_COLL);
  const filter = await loadRegionFilter(meta);
  const topology = await loadTopology(meta);
  return topology.filter(([region]) => filter.test(region));
}

// The single resolver (deploy, rollback, controller all go through it), with an in-process cache
// refreshed on ~5% of reads — SAME no-TTL strategy as worker/index.js getPrompts and lib/auth.js.
// Config here changes rarely, so we don't hit Mongo/GCP on every enqueue. A BAD_REGION_FILTER
// propagates so the dashboard can show it; any OTHER failure (Mongo/GCP down, off-GCE) degrades to
// the last good cache or SEED_REGIONS instead of throwing.
let regionCache = null;
export function _resetRegionCache() { regionCache = null; } // test hook
export async function getWorkerRegions() {
  if (!regionCache || Math.random() < REFRESH_RATE) {
    try {
      regionCache = await loadWorkerRegions();
    } catch (e) {
      if (e.code === "BAD_REGION_FILTER") throw e;
      regionCache = regionCache || SEED_REGIONS;
    }
  }
  return regionCache;
}

// Region NAMES only (no zones), for the controller's decide() which steers per region. Maps the
// resolver's `[region, [zones]]` → `[region]`.
export async function getWorkerRegionNames() {
  return (await getWorkerRegions()).map(([region]) => region);
}

// Back-compat alias: the controller (and its unit test) import discoverL4Regions expecting region
// NAMES. Same resolver underneath, so the topology has exactly one source.
export const discoverL4Regions = getWorkerRegionNames;
