// Worker idle-shutdown — the (expensive) GPU VM turns ITSELF off within IDLE_SHUTDOWN_MS of going
// idle, instead of waiting on the MIG autoscaler's Pub/Sub-backlog metric, which lags 3–5 min. Every
// idle minute on an L4 box is wasted money, so we don't wait for the platform to notice.
//
// The idle timer is (re)armed only when NO job is in flight; each incoming message clears it, so a
// busy worker never shuts down mid-run. On fire the worker deletes ITSELF from its MIG (regional
// deleteInstances via the instance metadata token) — a plain OS shutdown would just be recreated by
// the group. selfDeleteFromMig is a no-op off-GCE / when not MIG-managed (it throws; caller logs),
// which is why makeIdleShutdown is only armed in prod (see worker/index.js).

const META = "http://metadata.google.internal/computeMetadata/v1";
const META_HDR = { headers: { "Metadata-Flavor": "Google" } };

async function meta(path) {
  const r = await fetch(`${META}/${path}`, META_HDR);
  if (!r.ok) throw new Error(`metadata ${path} → ${r.status}`);
  return (await r.text()).trim();
}

// The GCE region this worker runs in ("us-central1"), from the instance's zone
// (projects/<num>/zones/<region>-<z> → drop the trailing -<letter>). Cached — it never changes for
// the life of the instance. Returns null off-GCE (metadata unreachable → dev/local), so callers can
// skip region attribution rather than fabricate one. Never throws.
let _region;
export async function workerRegion() {
  if (_region !== undefined) return _region;
  try {
    const zone = (await meta("instance/zone")).split("/").pop(); // us-central1-b
    _region = zone.replace(/-[a-z]$/, "");
  } catch {
    _region = null;
  }
  return _region;
}

// Test hook: clear the memoized region + instance-url so a single test module can exercise both the
// on-GCE and off-GCE branches without the query-string re-import trick (which spins up a whole fresh,
// mostly-uncovered module instance per case and drags the aggregate coverage down).
export function _resetMetaCache() { _region = undefined; _instanceUrl = undefined; }

// The full self-link of THIS instance (…/zones/<zone>/instances/<name>) — the reference a regional MIG
// deleteInstances call targets. Published on the capacity outcome event so the orchestrator's
// releaseBox can delete THIS finished box precisely (never a blind resize that might evict a busy one).
// Carries the zone, which region alone (the outcome event's other field) does not. Cached — it never
// changes for the instance's life; null off-GCE (metadata unreachable → dev/local). Never throws.
let _instanceUrl;
export async function workerInstance() {
  if (_instanceUrl !== undefined) return _instanceUrl;
  try {
    const [name, zonePath] = await Promise.all([meta("instance/name"), meta("instance/zone")]);
    const zone = zonePath.split("/").pop();
    const projNum = zonePath.split("/")[1]; // projects/<num>/zones/<zone>
    _instanceUrl = `https://www.googleapis.com/compute/v1/projects/${projNum}/zones/${zone}/instances/${name}`;
  } catch {
    _instanceUrl = null;
  }
  return _instanceUrl;
}

// Delete THIS instance from its MIG so the group's target size drops by one. Reads instance identity
// from the metadata server. Throws off-GCE (metadata unreachable) or when the instance was not
// created by a MIG (no `created-by`) — the caller decides whether to retry or give up.
export async function selfDeleteFromMig(log = console) {
  const [name, zonePath, createdBy, tokenJson] = await Promise.all([
    meta("instance/name"),
    meta("instance/zone"),                    // projects/<num>/zones/<region>-<z>
    meta("instance/attributes/created-by"),   // projects/<num>/regions/<region>/instanceGroupManagers/<igm>
    meta("instance/service-accounts/default/token"),
  ]);
  if (!createdBy.includes("instanceGroupManagers")) throw new Error(`not MIG-managed (created-by=${createdBy})`);
  const token = JSON.parse(tokenJson).access_token;
  const zone = zonePath.split("/").pop();
  const projNum = zonePath.split("/")[1];
  const instanceUrl = `https://www.googleapis.com/compute/v1/projects/${projNum}/zones/${zone}/instances/${name}`;
  const r = await fetch(`https://compute.googleapis.com/compute/v1/${createdBy}/deleteInstances`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ instances: [instanceUrl] }),
  });
  if (!r.ok) throw new Error(`deleteInstances → ${r.status} ${(await r.text()).slice(0, 200)}`);
  log.log(`[worker] ⏻ self-delete requested → MIG ${createdBy.split("/").pop()} / ${name}`);
}

// Idle-shutdown controller. Transport-agnostic and GCE-agnostic (onIdle is injected), so it unit-
// tests with fake timers. Call onStart when a message arrives and onFinish when it settles (in a
// `finally`, so EVERY path — ack, nack, throw — resets the timer); armInitial() covers a worker that
// boots and never receives a job. The timer fires only while inFlight === 0.
export function makeIdleShutdown({ idleMs, onIdle, log = console }) {
  let inFlight = 0;
  let timer = null;
  let firing = false;

  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const arm = () => {
    clear();
    if (inFlight > 0 || firing) return;
    timer = setTimeout(async () => {
      timer = null;
      firing = true;
      log.log(`[worker] idle ${idleMs}ms with no jobs — shutting down`);
      try {
        await onIdle();
        // success: leave `firing` true — we're on our way out; don't re-arm.
      } catch (e) {
        // Transient shutdown failure (compute API blip): log and try again next idle window.
        log.error(`[worker] self-shutdown failed, will retry: ${e.message}`);
        firing = false;
        arm();
      }
    }, idleMs);
    if (timer.unref) timer.unref(); // never keep the process alive just for this timer
  };

  return {
    onStart(jobId) {
      inFlight++;
      clear();
      log.log(`[worker] ▶ start ${jobId} (inFlight=${inFlight})`);
      return Date.now();
    },
    onFinish(jobId, startedAt) {
      inFlight = Math.max(0, inFlight - 1);
      log.log(`[worker] ■ done ${jobId} in ${Date.now() - startedAt}ms (inFlight=${inFlight})`);
      arm();
    },
    armInitial() { arm(); },
    _state: () => ({ inFlight, armed: timer != null, firing }), // test hook
  };
}
