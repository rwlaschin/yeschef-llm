// Capacity-steering controller — PHASE 2, the DIRECT-INVENTORY control loop
// (docs/plans/capacity-steering/phase2-control-loop.md).
//
// It reacts to detect / enqueue / stockout / success events, keeps the durable Mongo stats + state,
// RECORDS the decision (wouldOpen / wouldPark), and now ACTUATES it by setting the model's regional MIG
// size itself (start +1 / shrink −1 / release a finished box) via ./actuate.js.
//
// RECORDING + DECIDING run EVERYWHERE — dev (emulator/waker) AND prod — so the dashboard always
// reflects reality. The ONLY prod-gated thing is the GCE call itself, and that gate lives INSIDE
// actuate.js (off-prod → structured would-log, zero GCP). Every hook is wrapped so a capacity failure
// can NEVER break the job path: Mongo/GCP unavailable → swallow + log, never throw into publish/
// completion.
import { discoverL4Regions } from "./regions.js";
import { scoreRegionDaypart, select } from "./score.js";
import { daypartOf, windowRows, getState, setState, incOk, incFail, bumpStockoutStreak, claimWalk, recordMessageDetected } from "./store.js";
import { startBox, shrinkBox, releaseBox, liveBoxes, topicOfInstance } from "./actuate.js";

// A region is PARKED once it stocks out this many times IN A ROW (see select() in score.js). A fixed
// timer was wrong — a region that keeps failing is exhausted, and one that recovers is re-probed by
// exploration and reset by its next success. Tunable via CAPACITY_MAX_STOCKOUTS (default 3).
const MAX_STOCKOUTS = parseInt(process.env.CAPACITY_MAX_STOCKOUTS, 10) || 3;

// The real modules, injectable so the controller unit-tests with no Mongo/GCP (see controller.test.js).
// Phase 2 adds the actuators (start/shrink/release) — they self-gate on prod INSIDE actuate.js, so the
// RECORDING here runs everywhere (dev + prod) and only the GCE call is prod-gated.
const defaultDeps = { discoverL4Regions, windowRows, getState, setState, incOk, incFail, bumpStockoutStreak, claimWalk, recordMessageDetected, startBox, shrinkBox, releaseBox, needsBox };

// Does (model, region) need ANOTHER box right now? Answered from the same live reads the reconciler
// uses — GCE for what exists, Pub/Sub for what waits — so detect-driven starts and timer-driven starts
// can never disagree about the state of the world. Fails OPEN (start) when the queue can't be read: a
// missing metric must not stall real work, and an extra box idles itself out within the grace window.
export async function needsBox(topic, region, io = {}) {
  if (!region) return { start: false, why: "no region chosen", seen: {} };
  try {
    const { queueState, decideForModel } = await import("./reconcile.js");
    const q = await (io.queueState ?? queueState)(topic);
    const inv = await (io.liveBoxes ?? liveBoxes)(topic, region);
    // A detect event IS a message: this hook only runs because a publish just pushed to
    // /capacity-detect. The Monitoring metric lags 60–180s, so it reports a stale 0 (not null,
    // which would trigger the pull probe) and decideForModel answered "queue empty, no boxes" —
    // stranding the very message that triggered detection (prod 2026-08-19, job 9cea980b).
    // Floor undelivered at 1: with live boxes the decision is still "none — busy" as before.
    const d = decideForModel({ ...q, undelivered: Math.max(q.undelivered ?? 0, 1), live: inv.live ?? 0, region });
    return { start: d.action === "start", why: d.why, seen: d.seen };
  } catch (e) {
    return { start: true, why: `queue/inventory read failed (${e?.message}) — starting anyway`, seen: {} };
  }
}

// The observe-only decision. Discover the L4 candidate regions, score each for the CURRENT daypart
// over its in-window rows, pair each with its consecutive-stockout streak from state, then select() the
// winner. Records { wouldOpen, wouldPark } on the winner's state doc and returns it. Issues NO Compute
// calls. `rand` injectable (like `deps`) so the shadow decision is deterministic under test.
export async function decide(nowMs, deps = defaultDeps, rand = Math.random) {
  const daypart = daypartOf(nowMs);
  const regions = await deps.discoverL4Regions();
  if (!regions || regions.length === 0) return { wouldOpen: null, wouldPark: [] };

  const states = await deps.getState();
  const streakByRegion = new Map((states || []).map((s) => [s.region, s.consecutiveStockouts]));

  const scored = [];
  for (const region of regions) {
    const rows = await deps.windowRows(region, daypart, nowMs);
    scored.push({ region, score: scoreRegionDaypart(rows), consecutiveStockouts: streakByRegion.get(region) ?? 0 });
  }

  const winner = select(scored, nowMs, { maxStockouts: MAX_STOCKOUTS }, rand);
  const wouldOpen = winner ? winner.region : null;
  const wouldPark = regions.filter((r) => r !== wouldOpen);

  if (wouldOpen) {
    await deps.setState(wouldOpen, { wouldOpen, wouldPark, decidedAt: nowMs, decidedDaypart: daypart });
  }
  // Structured "I know what to do" signal — the decision the controller WOULD actuate this cycle
  // (Phase 2 turns this into real --mode toggles). Emitted on EVERY decide() so a log-based metric can
  // track it; onStockout/onOutcome re-decide through here, so their would-decision is logged too.
  console.log(JSON.stringify({ message: `[capacity] WOULD open ${wouldOpen} · park ${wouldPark.join(",")}`, capacityEvent: "decide", wouldOpen, wouldPark }));
  return { wouldOpen, wouldPark };
}

// Message-detected hook — fired event-driven by the detect subscriptions (one per model topic →
// /ai/capacity-detect → handleDetectMessage), so EVERY enqueue is caught regardless of publisher.
// Records the detection + runs decide(), then ACTUATES: startBox(topic, winner) boots a box in the
// chosen region (resize +1) — but ONLY if the live box count is short of the waiting work. This exists
// for latency (a box starts the moment work arrives, not on the next reconcile tick); the reconciler's
// model-aware ceil(backlog / parallel) test keeps a burst from provisioning one box per message.
// Recording + deciding run EVERYWHERE (dev + prod); startBox self-gates on prod inside actuate.js
// (dev → would-log, no GCE call). Never throws into the detect path.
export async function onMessageDetected(topic, nowMs = Date.now(), deps = defaultDeps, rand = Math.random) {
  try {
    await deps.recordMessageDetected(topic, nowMs);
    const decision = await decide(nowMs, deps, rand);
    const need = await deps.needsBox(topic, decision.wouldOpen);
    if (!need.start) {
      console.log(JSON.stringify({
        message: `[capacity] detect ${topic} → no start — ${need.why}`,
        capacityEvent: "detect_no_start", actor: "engine", model: topic, region: decision.wouldOpen ?? null, why: need.why, ...need.seen,
      }));
      return { detected: topic, ...decision, started: false };
    }
    await deps.startBox(topic, decision.wouldOpen, undefined, `detect: ${need.why}`);
    return { detected: topic, ...decision, started: true };
  } catch (e) {
    console.error(`[capacity] onMessageDetected(${topic}) swallowed: ${e?.message}`);
    return { error: e?.message };
  }
}

// Enqueue hook — called fire-and-forget from the dispatch publish path. Runs decide() everywhere (dev
// + prod) so the stored wouldOpen stays fresh; it does not actuate (onMessageDetected owns the +1).
// Any failure is swallowed + logged so it can never propagate into the publish path.
export async function onEnqueue(nowMs, deps = defaultDeps, rand = Math.random) {
  try {
    return await decide(nowMs, deps, rand);
  } catch (e) {
    console.error(`[capacity] onEnqueue swallowed: ${e?.message}`);
    return { error: e?.message };
  }
}

// Stockout hook — invoked (via recorder / the log-sink handler below) on a ZONE_RESOURCE_POOL_EXHAUSTED
// for `region` while trying to boot `model`'s MIG there. Recording runs everywhere: $inc fail on the
// region's current daypart, bump the consecutive-stockout streak (also stamps lastStockoutTs), then
// re-decide. The streak — NOT a timer — parks the region once it hits MAX_STOCKOUTS in select(), so the
// post-bump decide() already excludes a just-parked region and names the NEXT best as wouldOpen.
// ACTUATION fires ONCE, on the crossing (streak === MAX_STOCKOUTS): shrinkBox(model, region)
// abandons the exhausted region (resize −1), then startBox(model, next) boots a box in the cascaded-to
// region. Under 3 in a row we touch NO inventory — the MIG retries its own boot. `model` may be null
// (unresolved topic) → recording still happens, actuation is skipped. Wrapped so it never throws.
export async function onStockout(region, nowMs, model = null, deps = defaultDeps, rand = Math.random) {
  try {
    await deps.incFail(region, nowMs);
    // The post-increment streak, straight from the atomic write — NOT a re-read. The MIG retries a
    // failed create every ~10s and each retry lands here, so a separate read raced and several
    // stockouts saw the same value.
    const streak = await deps.bumpStockoutStreak(region, nowMs);
    const decision = await decide(nowMs, deps, rand);
    if (model) {
      // Fire ONCE per stockout episode, on `>=` guarded by an atomic claim — NOT on the exact
      // crossing. Bare `>=` re-ran the whole abandon+cascade on every retry after the third
      // (observed streak 27: duplicate resize −1 / +1 ten seconds apart, one job with two boxes).
      // But `=== MAX` was wrong the other way (prod 2026-08-19): a streak that entered the day
      // already past MAX — crossing spent in an earlier episode, no success possible to reset it —
      // meant 16 stockouts all skipped actuation and the region never walked. claimWalk() flips a
      // `walked` flag atomically in the state doc (concurrent stockouts race safely: one winner);
      // a success resets streak to 0 AND clears the flag, re-arming the walk for the next episode.
      if (streak >= MAX_STOCKOUTS && (await deps.claimWalk(region))) {
        await deps.shrinkBox(model, region, undefined, `stockout streak ${streak} — abandoning ${region}`);
        // decision.wouldOpen is the fresh post-bump winner, which now EXCLUDES the just-parked region
        // (select() vetoes streak>=MAX). Cascade the +1 there; skip if there's nowhere else to go.
        if (decision.wouldOpen && decision.wouldOpen !== region) {
          await deps.startBox(model, decision.wouldOpen, undefined, `stockout cascade from ${region}`);
        }
      }
    }
    return decision;
  } catch (e) {
    console.error(`[capacity] onStockout(${region}) swallowed: ${e?.message}`);
    return { error: e?.message };
  }
}

// Outcome hook — the wired job-DONE signal. The worker publishes an `outcome` event (action:"outcome")
// to the orchestrate topic on EVERY job's completion (queries included), carrying the region it ran in
// (from instance metadata) and the terminal run status. This is the ONE place `ok` is now recorded (the
// worker no longer writes it directly). Recording model:
//   success → $inc ok on the region's current daypart, stamp lastSuccessTs AND reset the
//             consecutive-stockout streak to 0 (any success un-parks the region), then re-decide (a fresh
//             success can flip the winner, so the stored wouldOpen stays current for the dashboard).
//   fail    → a ran-but-failed job is NOT a capacity signal (the box existed; the model failed) → LOG
//             only, no store.
// Recording + the success log + decide() run EVERYWHERE (dev + prod). After the re-decide it ACTUATES:
// releaseBox(model, region, instance) targeted-deletes the specific finished box (resize-safe). Only the
// GCE call inside releaseBox is prod-gated (dev → would-log). `model`/`instance` ride the worker's
// outcome event; if instance is absent releaseBox falls back to a logged size−1 (see actuate.js).
// Wrapped so a capacity failure can never propagate into the job path — fired fire-and-forget off the
// orchestrate push.
export async function onOutcome(region, status, nowMs = Date.now(), model = null, instance = null, deps = defaultDeps, rand = Math.random) {
  try {
    if (!region) { console.warn("[capacity] onOutcome: no region on the outcome event — skipping"); return { skipped: "no-region" }; }
    if (status !== "success") {
      console.log(JSON.stringify({ message: `[capacity] job FAIL ${region} — not stored`, capacityEvent: "job_fail", region, status }));
      return { skipped: "job-fail" };
    }
    await deps.incOk(region, nowMs);
    await deps.setState(region, { lastSuccessTs: nowMs, consecutiveStockouts: 0, walked: false });
    // Every success registers a structured log, matching detect / stockout / job_fail.
    console.log(JSON.stringify({ message: `[capacity] job DONE → ok ${region}`, capacityEvent: "ok", actor: "engine", region, model: model ?? null, instance: instance ?? null }));
    // NO teardown here. A per-job outcome cannot tell whether the box is free: the worker leases up to
    // the model's configured parallel message count, so releasing on the FIRST completion killed boxes mid-generation and
    // left the messages they still held to redelivery with nothing to request capacity for them. Box
    // lifecycle belongs to reconcile.js, which stops a box only after the whole queue has been idle
    // for IDLE_GRACE_MS — the 1-minute delay that also lets a free box take the next message.
    const decision = await decide(nowMs, deps, rand);
    console.log(JSON.stringify({
      message: `[capacity] job DONE → teardown deferred to reconciler ${region}`,
      capacityEvent: "release_deferred", actor: "engine", region, model: model ?? null, instance: instance ?? null,
    }));
    return decision;
  } catch (e) {
    console.error(`[capacity] onOutcome(${region}) swallowed: ${e?.message}`);
    return { error: e?.message };
  }
}

// events.js adapter — routed from the `orchestrate` topic push by action:"outcome". events.js has
// already decoded the Pub/Sub envelope into `payload`; pull region + status + the model (topic) and the
// finished instance (self-link) the worker now carries, and hand them to onOutcome so releaseBox can
// target THAT box. Never throws (onOutcome swallows).
export async function handleOutcomeEvent(payload) {
  return onOutcome(payload?.region, payload?.status, Date.now(), payload?.model ?? null, payload?.instance ?? null);
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
    // The failed instance name (…/instances/<name>) carries the model — recover its topic so shrink/
    // start actuate the right MIG. Null (unrecognized name) → recording still runs, actuation skipped.
    const name = (entry?.protoPayload?.resourceName || "").split("/instances/")[1] || "";
    return await onStockout(region, nowMs, topicOfInstance(name));
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
