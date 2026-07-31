// Capacity recorder — turns real GCE worker-create OUTCOMES into the region scoreboard. This is the
// ok/fail source (docs/plans/capacity-steering/plan.md), decoupled from the orchestrator request
// path. It consumes completed `compute.instances.insert` operations for ollama worker MIGs:
//   - no status.message           → box came up           → LOG only (ok is stored at job DONE)
//   - status.message set (e.g.      → the create failed     → incFail(region)
//     ZONE_RESOURCE_POOL_EXHAUSTED)
// Region comes from the operation's zone (…/zones/<zone>/… → drop the -<letter>). Deployed as an
// event-triggered function in the orchestrator codebase (log sink → Pub/Sub), NOT an HTTP endpoint.
import { markMessageSeen } from "./store.js";
import { onMessageDetected, onStockout } from "./controller.js";
import { topicOfInstance } from "./actuate.js";

const WORKER_RE = /instances\/.*-mig-/;

// Region from the insert operation (resourceName zone, else resource.labels.zone).
export function regionFromInsertOp(entry) {
  const rn = entry?.protoPayload?.resourceName || "";
  const m = rn.match(/\/zones\/([a-z0-9-]+)\//);
  const zone = m ? m[1] : (entry?.resource?.labels?.zone || null);
  return zone ? zone.replace(/-[a-z]$/, "") : null;
}

// Only the COMPLETION (operation.last) of a worker-MIG instance insert carries the final outcome.
export function isWorkerInsertCompletion(entry) {
  const pp = entry?.protoPayload || {};
  const last = entry?.operation?.last;
  return /compute\.instances\.insert/.test(pp.methodName || "")
    && WORKER_RE.test(pp.resourceName || "")
    && (last === true || last === "true");
}

// Adapter for the Cloud Logging sink → Pub/Sub → orchestrator function path. The Pub/Sub message's
// `data` is the LogEntry JSON (base64). Decode it and hand to recordCreateOutcome. Kept separate so
// recordCreateOutcome stays directly HAND-INVOCABLE (unit tests, backfills, ad-hoc replays). Never
// throws — a bad/undecodable message is logged and dropped.
export async function handleLogPubSub(message, nowMs = Date.now(), deps) {
  try {
    console.log(`[capacity/recorder] handleLogPubSub: message keys=${Object.keys(message || {})}`);
    const raw = message?.data ? Buffer.from(message.data, "base64").toString("utf8") : null;
    console.log(`[capacity/recorder] decoded raw string (first 150 chars): ${raw ? raw.slice(0, 150) : "null"}`);
    if (!raw) return null;
    return await recordCreateOutcome(JSON.parse(raw), nowMs, deps);
  } catch (e) {
    console.error(`[capacity/recorder] pubsub decode swallowed: ${e?.message}`);
    return null;
  }
}

// Detect-message handler — the shim's detection subscription pushes each fanned worker-job message
// here. Dedupes on Pub/Sub messageId (durable, so redeliveries + detector restart never double-count),
// then fires onMessageDetected for the message's model topic. Never throws. `deps` injectable for tests.
export async function handleDetectMessage(message, nowMs = Date.now(), deps = { markMessageSeen, onMessageDetected }) {
  try {
    const messageId = message?.messageId;
    if (!messageId) return null;
    const raw = message?.data ? Buffer.from(message.data, "base64").toString("utf8") : null;
    const topic = raw ? JSON.parse(raw)?.model : null; // the model topic the job was published to
    if (!topic) { console.warn(`[capacity] detect: unusable message (msgId=${messageId}, no topic)`); return null; }
    // Dedup store failure ≠ no traffic: emit a DISTINCT marker so a blank detect chart caused by
    // Mongo being unreachable is visible in logs (metric filters capacityEvent="detect", not this).
    let fresh;
    try { fresh = await deps.markMessageSeen(messageId, nowMs); }
    catch (e) {
      console.error(JSON.stringify({ message: `[capacity] detect DEDUP-UNAVAILABLE topic=${topic} msg=${messageId}: ${e?.message}`, capacityEvent: "detect_dedup_error", topic, messageId }));
      return { dedupError: true };
    }
    if (!fresh) {
      console.log(`[capacity] detect DUP topic=${topic} msg=${messageId} — skip`);
      return { dup: true }; // redelivery/replay
    }
    const decision = await deps.onMessageDetected(topic, nowMs);
    // Structured so the log-based metric extracts a clean `topic` label (jsonPayload.*), no regex.
    console.log(JSON.stringify({
      message: `[capacity] detect ${topic} → wouldOpen=${decision?.wouldOpen ?? "—"}`,
      capacityEvent: "detect", topic, messageId, wouldOpen: decision?.wouldOpen ?? null,
    }));
    return { detected: topic, ...decision };
  } catch (e) {
    console.error(`[capacity/recorder] detect swallowed: ${e?.message}`);
    return null;
  }
}

// Record one create-outcome → {region, outcome} or null if the entry isn't a worker-create
// completion. Never throws into its caller. Uses the event's own timestamp so the row lands in the
// daypart the create actually happened.
export async function recordCreateOutcome(entry, nowMs = Date.now(), deps = { onStockout }) {
  try {
    const isComp = isWorkerInsertCompletion(entry);
    console.log(`[capacity/recorder] recordCreateOutcome: isWorkerInsertCompletion=${isComp}, method=${entry?.protoPayload?.methodName}, resource=${entry?.protoPayload?.resourceName}`);
    if (!isComp) return null;
    const region = regionFromInsertOp(entry);
    if (!region) {
      console.log(`[capacity/recorder] region resolution failed`);
      return null;
    }
    const when = entry?.timestamp ? Date.parse(entry.timestamp) || nowMs : nowMs;
    const failed = !!entry?.protoPayload?.status?.message; // any error message = failed create
    console.log(`[capacity/recorder] matches worker create completion: region=${region}, failed=${failed}, timestamp=${when}`);
    // Two create outcomes, only ONE is stored:
    //   failed create (ZONE_RESOURCE_POOL_EXHAUSTED etc.) → STORE incFail (couldn't get a box here)
    //   box came up                                       → LOG only (a boot ≠ a completed job)
    // `ok` is stored at job DONE (worker/index.js recordCapacityOk), the one point every job type
    // hits — so a booted-but-idle box never inflates the score. Box-up is logged for observability.
    if (failed) {
      // Route through onStockout — NOT a bare incFail — so a stockout also bumps the consecutive-stockout
      // streak (parks the region after MAX_STOCKOUTS in a row) and RE-DECIDES. A bare incFail left the
      // stored decision stale and never re-steered off the exhausted region. The failed instance name
      // (…/instances/<image>-mig-<suffix>) carries the model → topic so onStockout can shrink/start the
      // right MIG at the 3rd straight stockout.
      const name = (entry?.protoPayload?.resourceName || "").split("/instances/")[1] || "";
      const model = topicOfInstance(name);
      console.log(`[capacity/recorder] stockout → onStockout for region ${region} model ${model ?? "?"}`);
      await deps.onStockout(region, when, model);
      return { region, outcome: "fail" };
    }
    console.log(JSON.stringify({ message: `[capacity] box up ${region}`, capacityEvent: "box_up", region }));
    return { region, outcome: "up" };
  } catch (e) {
    console.error(`[capacity/recorder] swallowed: ${e?.message}`);
    return null;
  }
}
