// Capacity-steering controller — PHASE 1, OBSERVE-ONLY (docs/plans/capacity-steering/plan.md).
//
// It reacts to enqueue / stockout / success events, keeps the durable Mongo stats + state, and
// RECORDS the decision it *would* make (wouldOpen / wouldPark). It issues NO Compute `--mode` calls
// this phase — actuation lands in Phase 2 with the same selection output, no model change.
//
// Every hook is wrapped so a capacity failure can NEVER break the job path: Mongo/GCP unavailable →
// swallow + log, never throw into publish/completion. GCE-gated exactly like worker/idle-shutdown.js
// (IS_PROD / K_SERVICE): dev (waker + emulator) records nothing and touches no GCP.
import { discoverL4Regions } from "./regions.js";
import { scoreRegionDaypart, select } from "./score.js";
import { daypartOf, windowRows, getState, setState, incOk, incFail, setCooldown, recordMessageDetected } from "./store.js";

// After a region stockout, veto it from selection for this long (see select() in score.js — the
// cooldown is a soft veto: if EVERY region is cooling down it's dropped and the highest wins).
const COOLDOWN_MS = 15 * 60 * 1000;

// The real modules, injectable so the controller unit-tests with no Mongo/GCP (see controller.test.js).
const defaultDeps = { discoverL4Regions, windowRows, getState, setState, incOk, incFail, setCooldown, recordMessageDetected };

// Prod-like = the orchestrator running on Cloud Run (K_SERVICE) or with NODE_ENV=production. Dev
// (emulator / waker) is neither, so onEnqueue no-ops there and records nothing. Mirrors worker's
// IS_PROD gate; kept a function (not a const) so tests can flip the env per-case.
function isProdLike() {
  return /prod(uction)?/i.test(process.env.NODE_ENV || "") || !!process.env.K_SERVICE;
}

// The observe-only decision. Discover the L4 candidate regions, score each for the CURRENT daypart
// over its in-window rows, pair each with its cooldown from state, then select() the winner. Records
// { wouldOpen, wouldPark } on the winner's state doc and returns it. Issues NO Compute calls.
export async function decide(nowMs, deps = defaultDeps) {
  const daypart = daypartOf(nowMs);
  const regions = await deps.discoverL4Regions();
  if (!regions || regions.length === 0) return { wouldOpen: null, wouldPark: [] };

  const states = await deps.getState();
  const cooldownByRegion = new Map((states || []).map((s) => [s.region, s.cooldownUntil]));

  const scored = [];
  for (const region of regions) {
    const rows = await deps.windowRows(region, daypart, nowMs);
    scored.push({ region, score: scoreRegionDaypart(rows), cooldownUntil: cooldownByRegion.get(region) ?? null });
  }

  const winner = select(scored, nowMs);
  const wouldOpen = winner ? winner.region : null;
  const wouldPark = regions.filter((r) => r !== wouldOpen);

  if (wouldOpen) {
    await deps.setState(wouldOpen, { wouldOpen, wouldPark, decidedAt: nowMs, decidedDaypart: daypart });
  }
  return { wouldOpen, wouldPark };
}

// Message-detected hook — fired event-driven by the detect subscriptions (one per model topic →
// /ai/capacity-detect → handleDetectMessage), so EVERY enqueue is caught regardless of publisher.
// Observe phase: records the detection + runs decide() to record what it WOULD open. Phase 2 will
// actuate (enable the chosen region) here. Prod-gated; never throws.
export async function onMessageDetected(topic, nowMs = Date.now(), deps = defaultDeps) {
  if (!isProdLike()) return { skipped: "not-prod" };
  try {
    await deps.recordMessageDetected(topic, nowMs);
    return { detected: topic, ...(await decide(nowMs, deps)) };
  } catch (e) {
    console.error(`[capacity] onMessageDetected(${topic}) swallowed: ${e?.message}`);
    return { error: e?.message };
  }
}

// Enqueue hook — called fire-and-forget from the dispatch publish path. Prod-gated: no-op in dev
// (records nothing, touches no GCP). Any failure is swallowed + logged so it can never propagate
// into the publish path.
export async function onEnqueue(nowMs, deps = defaultDeps) {
  if (!isProdLike()) return { skipped: "not-prod" };
  try {
    return await decide(nowMs, deps);
  } catch (e) {
    console.error(`[capacity] onEnqueue swallowed: ${e?.message}`);
    return { error: e?.message };
  }
}

// Stockout hook — invoked by the deploy-time Cloud Logging sink handler (below) on a
// ZONE_RESOURCE_POOL_EXHAUSTED for `region`. $inc fail on the region's current daypart, veto it via
// cooldown, stamp lastStockoutTs, then re-decide. Wrapped so it never throws into its caller.
export async function onStockout(region, nowMs, deps = defaultDeps) {
  try {
    await deps.incFail(region, nowMs);
    await deps.setCooldown(region, nowMs + COOLDOWN_MS);
    await deps.setState(region, { lastStockoutTs: nowMs });
    return await decide(nowMs, deps);
  } catch (e) {
    console.error(`[capacity] onStockout(${region}) swallowed: ${e?.message}`);
    return { error: e?.message };
  }
}

// Success hook — $inc ok on the region's current daypart + stamp lastSuccessTs. Wrapped so it never
// throws into its caller.
//
// NOT WIRED YET: the completion point (dispatch/step.js `advance` on a successful step) does not know
// which REGION the worker ran in — the orchestrator publishes to a model topic, not a region, and a
// step's run docs carry no region. Wiring this needs the worker to stamp its region (from the
// instance metadata server) onto the run doc / step report first. Exported + left for that follow-up.
export async function onSuccess(region, nowMs, deps = defaultDeps) {
  try {
    await deps.incOk(region, nowMs);
    await deps.setState(region, { lastSuccessTs: nowMs });
  } catch (e) {
    console.error(`[capacity] onSuccess(${region}) swallowed: ${e?.message}`);
  }
}

// Cloud Logging sink → this handler. The Eventarc trigger / log sink that matches
// ZONE_RESOURCE_POOL_EXHAUSTED and routes here is DEPLOY-TIME infra (not wired in code). Parses the
// region out of the log entry and forwards to onStockout. Never throws.
export async function handleStockoutLog(entry, nowMs = Date.now()) {
  try {
    const region = regionFromLogEntry(entry);
    if (!region) {
      console.warn("[capacity] stockout log had no resolvable region — ignoring");
      return { skipped: "no-region" };
    }
    return await onStockout(region, nowMs);
  } catch (e) {
    console.error(`[capacity] handleStockoutLog swallowed: ${e?.message}`);
    return { error: e?.message };
  }
}

// Region from a real ZONE_RESOURCE_POOL_EXHAUSTED entry (verified against prod logs 2026-07-15):
// resource.type=gce_instance carries the location ONLY as resource.labels.zone ("us-central1-b") —
// there is no region label. Fall back to the zone embedded in protoPayload.resourceName
// (".../zones/<zone>/instances/..."). A zone is reduced to its region by dropping the -<letter>.
export function regionFromLogEntry(entry) {
  const zone =
    entry?.resource?.labels?.zone ||
    entry?.protoPayload?.resourceName?.match(/\/zones\/([^/]+)\//)?.[1] ||
    null;
  return zone ? zone.replace(/-[a-z]$/, "") : null;
}
