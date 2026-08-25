// Capacity RECONCILER — the capacity engine's box lifecycle owner. Runs on a timer (Cloud Scheduler →
// POST /ai/capacity-reconcile) and answers two questions per model from LIVE reads only:
//   messages waiting and not enough boxes  → startBox   (the engine starts boxes, nothing else does)
//   nothing to do for IDLE_GRACE_MS        → releaseBox (the engine stops idle boxes, after the delay)
//
// NO PERSISTED INVENTORY. Both inputs are read at decision time, so neither can go stale:
//   • boxes    → GCE listManagedInstances (actuate.liveBoxes) — includes CREATING/DELETING
//   • messages → Pub/Sub metrics: undelivered (waiting), outstanding (leased to a box right now),
//                acked-in-window (did ANY box finish work recently)
// Idleness is derived, never reported by a box: undelivered 0 + outstanding 0 + zero acks across the
// grace window means every live box has done nothing for that whole window. A heartbeat table would
// have to be written, read, and trusted; these three numbers cannot lie about the past minute.
//
// Cloud Monitoring lags ~60s. Every decision here is idempotent and re-derived each tick, so lag can
// only DELAY a start, never cause a wrong one — and a start is bounded by MAX_BOXES_PER_MODEL.
//
// TWO REAPERS, SAME 1-MINUTE RULE, ON PURPOSE. Pub/Sub omits the outstanding/ack series entirely for a
// subscription with no recent traffic, so those reads come back null — and null must mean "unknown",
// never "empty", or a quiet tick would delete a box that is mid-generation. That makes this reaper
// deliberately incomplete: when the series are missing it declines to stop anything, and the worker's
// own idle self-delete (worker/idle-shutdown.js, same 60s, and it KNOWS its inFlight count) is what
// clears the box. This reaper covers the case the worker cannot: a wedged or unreachable worker whose
// queue is provably empty.
import { MODELS, subscriptionOf, byTopic, parallelOf } from "../../../config/models.js";
import { startBox, releaseBox, liveBoxes, isProdLike } from "./actuate.js";
import { adcToken, projectId } from "./regions.js";

const MONITORING = "https://monitoring.googleapis.com/v3";

export const IDLE_GRACE_MS = 60_000;          // his spec: shut an idle box down after a 1 min delay
export const MAX_BOXES_PER_MODEL = 4;         // ceiling per reconcile tick — a burst can't fan out unbounded

// One structured line per reconcile decision, per model. This is the "who decided what, and on what
// numbers" record: actor=engine, the live inputs, and the chosen action. A quiet tick still logs, so
// "nothing happened" is distinguishable from "the reconciler never ran".
function logDecide(model, region, action, why, seen) {
  console.log(JSON.stringify({
    message: `[capacity/reconcile] ${model} · ${region ?? "-"} → ${action} — ${why}`,
    capacityEvent: "reconcile", actor: "engine", model, region: region ?? null, action, why, ...seen,
  }));
}

// Sum a Pub/Sub subscription metric over `windowMs`. ALIGN_MAX for gauges (undelivered/outstanding —
// we want the peak in the window, so a mid-window dip can't read as empty), ALIGN_SUM for the ack
// counter (we want "were there ANY acks"). Returns null when the series is absent, which callers must
// treat as "unknown" — NOT as zero, or an unknown would read as idle and delete a working box.
async function metric(sub, type, windowMs, aligner) {
  const project = await projectId();
  const token = await adcToken();
  const end = new Date();
  const start = new Date(end.getTime() - windowMs);
  const filter = `metric.type="pubsub.googleapis.com/subscription/${type}" AND resource.label.subscription_id="${sub}"`;
  const url = `${MONITORING}/projects/${project}/timeSeries?filter=${encodeURIComponent(filter)}`
    + `&interval.startTime=${start.toISOString()}&interval.endTime=${end.toISOString()}`
    + `&aggregation.alignmentPeriod=60s&aggregation.perSeriesAligner=${aligner}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`monitoring ${type} → ${r.status} ${(await r.text()).slice(0, 160)}`);
  const pts = ((await r.json()).timeSeries?.[0]?.points ?? [])
    .map((p) => Number(p.value.int64Value ?? p.value.doubleValue ?? 0));
  if (!pts.length) return null;
  return aligner === "ALIGN_SUM" ? pts.reduce((a, b) => a + b, 0) : Math.max(...pts);
}

// Is anything waiting on this subscription RIGHT NOW? Asked of Pub/Sub directly, because Cloud
// Monitoring lags 60–180s: a message published 30s ago has no data point yet, so `undelivered` reads
// null and the reconciler used to decline to start a box — in exactly the orphaned-message case it
// exists to cover. A 1-message pull answers with no lag; the message is immediately nacked
// (ackDeadlineSeconds 0) so the worker that starts still gets it. Only called when the metric is blind,
// so a stuck message cannot have its delivery-attempt count inflated on every tick.
async function probeWaiting(sub) {
  const project = await projectId();
  const token = await adcToken();
  const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const base = `https://pubsub.googleapis.com/v1/projects/${project}/subscriptions/${sub}`;
  const r = await fetch(`${base}:pull`, { method: "POST", headers: h, body: JSON.stringify({ maxMessages: 1 }) });
  if (!r.ok) throw new Error(`pull ${sub} → ${r.status} ${(await r.text()).slice(0, 120)}`);
  const ackIds = ((await r.json()).receivedMessages ?? []).map((m) => m.ackId);
  if (!ackIds.length) return false;
  // Hand it straight back — this is a peek, not a consume.
  await fetch(`${base}:modifyAckDeadline`, {
    method: "POST", headers: h, body: JSON.stringify({ ackIds, ackDeadlineSeconds: 0 }),
  }).catch(() => {});
  return true;
}

// The live queue picture for one model: what waits, what is being worked, what finished this window.
// `waiting` is the lag-free truth used when the metric is blind.
// `mayProbe` gates the pull: a nack increments the message's delivery count, and at
// maxDeliveryAttempts 50 a message this reconciler probes every tick would be dead-lettered by the
// probing itself in under an hour. So only probe on a tick that could actually start a box (no boxes
// live) — the case where the answer changes what we do.
export async function queueState(topic, windowMs = IDLE_GRACE_MS, read = metric, probe = probeWaiting, mayProbe = true) {
  const sub = subscriptionOf(byTopic(topic));
  const [undelivered, outstanding, acked] = await Promise.all([
    read(sub, "num_undelivered_messages", windowMs, "ALIGN_MAX"),
    read(sub, "num_outstanding_messages", windowMs, "ALIGN_MAX"),
    read(sub, "ack_message_count", windowMs, "ALIGN_SUM"),
  ]);
  // Probe only when the metric can't answer — one extra Pub/Sub call on an idle tick, never on a busy one.
  let waiting = null;
  if (undelivered == null && mayProbe) {
    try { waiting = await probe(sub); } catch (e) {
      console.warn(`[capacity/reconcile] pull probe ${sub} failed: ${e?.message}`);
    }
  }
  return { sub, undelivered, outstanding, acked, waiting };
}

// Decide for ONE model. Pure given its inputs (injectable) so the policy is unit-testable without GCE
// or Monitoring. Returns the action plus the numbers it saw, which the caller logs verbatim.
export function decideForModel({ undelivered, outstanding, acked, waiting, live, parallel = 1, region }) {
  const requiredBoxes = undelivered == null ? null : Math.ceil(undelivered / parallel);
  const seen = { undelivered, outstanding, acked, waiting, live, parallel, requiredBoxes };
  // Metric blind → fall back to the lag-free pull probe. Monitoring is 60–180s behind, so a just-published
  // message reads as `undelivered: null`, and declining to act there stranded exactly the message this
  // reconciler is meant to rescue.
  if (undelivered == null) {
    if (waiting === true && live === 0) {
      return { action: "start", why: "metric blind, pull probe found a waiting message, 0 live", seen, region };
    }
    // Unknown ≠ empty: with no evidence either way we never DELETE, because that is the direction that
    // can kill a working box.
    return {
      action: "none",
      why: waiting === false
        ? "metric blind, pull probe found nothing waiting"
        : `metric blind, probe ${waiting === null ? "unavailable" : "inconclusive"}`,
      seen,
    };
  }
  if (undelivered > 0 && live < Math.min(requiredBoxes, MAX_BOXES_PER_MODEL)) {
    return { action: "start", why: `${undelivered} waiting, ${live} live (${parallel}/box)`, seen, region };
  }
  if (undelivered > 0) return { action: "none", why: `${undelivered} waiting, ${live} live — enough boxes`, seen };
  if (live === 0) return { action: "none", why: "queue empty, no boxes", seen };
  if (outstanding == null || outstanding > 0) return { action: "none", why: `${live} live, ${outstanding ?? "?"} in flight — busy`, seen };
  if (acked == null || acked > 0) return { action: "none", why: `${live} live, finished work within the grace window`, seen };
  return { action: "stop", why: `queue empty and no acks for ${IDLE_GRACE_MS / 1000}s — ${live} idle box(es)`, seen };
}

// Reconcile every model. `deps` is injectable for tests; defaults hit GCE + Monitoring for real.
// Never throws: a failure on one model is logged and the rest still reconcile.
export async function reconcile(deps = {}) {
  const {
    models = MODELS, queue = queueState, boxes = liveBoxes,
    start = startBox, stop = releaseBox, pickRegion = defaultRegion,
  } = deps;
  const results = [];
  for (const m of models) {
    let region = null;   // hoisted so the catch can name the region it was working on
    try {
      region = await pickRegion(m.topic);
      // Inventory first: the probe is only worth its side effect when there is no box to take the work.
      const inv = await boxes(m.topic, region);
      const q = await queue(m.topic, undefined, undefined, undefined, (inv.live ?? 0) === 0);
      // Tests and one-off callers may inject a topic-only model stub; production MODELS always carry
      // the explicit value. Resolve a canonical model by topic without creating another config source.
      const capacityModel = m.parallel == null ? byTopic(m.topic) : m;
      const d = decideForModel({ ...q, live: inv.live ?? 0, parallel: parallelOf(capacityModel), region });
      logDecide(m.topic, region, d.action, d.why, { ...d.seen, prod: isProdLike() });
      if (d.action === "start") await start(m.topic, region, undefined, `reconcile: ${d.why}`);
      if (d.action === "stop") {
        // Targeted deletes only — a blind resize picks the victim, and GCE may pick a box that took a
        // message in the seconds since we measured. One box per tick: re-derive before taking another.
        const victim = (inv.boxes ?? []).find((b) => b.action !== "DELETING");
        if (victim) await stop(m.topic, region, victim.instance, undefined, `reconcile: ${d.why}`);
      }
      results.push({ model: m.topic, region, ...d });
    } catch (e) {
      // 404 = this model has no MIG in this region. That is a provisioning fact, not a failure, and
      // it recurs on EVERY cycle — openclaw_llama3_3_70b_v1's MIG is zonal, so it 404s forever and
      // was drowning the reconcile_failed metric in noise that hid real errors.
      if (e?.status === 404) {
        console.log(JSON.stringify({
          message: `[capacity/reconcile] ${m.topic} · ${region ?? "?"} → skipped — no MIG provisioned here`,
          capacityEvent: "reconcile_skip", actor: "engine", model: m.topic, region, why: "mig_not_found",
        }));
        results.push({ model: m.topic, region, action: "skip", why: "mig_not_found" });
        continue;
      }
      console.error(JSON.stringify({
        message: `[capacity/reconcile] ${m.topic} FAILED — ${e?.message}`,
        capacityEvent: "reconcile_failed", actor: "engine", model: m.topic, error: e?.message,
      }));
      results.push({ model: m.topic, action: "error", error: e?.message });
    }
  }
  return results;
}

// Which region to act in: the winner the controller already stored (its scoring owns region choice —
// the reconciler does not re-litigate it), falling back to the first discovered L4 region.
async function defaultRegion(topic) {
  const { getState } = await import("./store.js");
  const { discoverL4Regions } = await import("./regions.js");
  const states = await getState();
  const stored = states.find((s) => s.wouldOpen)?.wouldOpen;
  if (stored) return stored;
  const regions = await discoverL4Regions();
  return regions?.[0] ?? null;
}
