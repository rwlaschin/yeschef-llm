// Capacity ACTUATOR — Phase 2, the DIRECT-INVENTORY control loop's one GCE-facing module
// (docs/plans/capacity-steering/phase2-control-loop.md). The controller decides WHICH region; this
// module makes it real by setting the model's regional MIG size ITSELF (no autoscalers):
//   startBox   → resize +1  (need capacity → boot a box in the winning region)
//   shrinkBox  → resize −1  (3rd consecutive stockout → abandon the region)
//   releaseBox → deleteInstances the specific finished box (done → give the box back)
// `avail` for a (model, region) IS that MIG's target size — we read it live and adjust, never a
// separate counter.
//
// GATING: the GCE calls are the ONLY prod-gated thing in the whole capacity path. Off-prod (dev
// emulator / waker: NODE_ENV !== production) each function LOGS a structured would-line and
// returns WITHOUT touching GCP — recording + deciding still ran in the controller. On Cloud Run the
// real call runs (also logged, would:false). Never throws into the job path: every entry is wrapped,
// swallowed, and logged.
import { byTopic, imageOf, MODELS } from "../../../config/models.js";
import { adcToken, projectId } from "./regions.js";

const COMPUTE = "https://compute.googleapis.com/compute/v1";

// Prod = NODE_ENV=production, full stop — the SAME gate as the worker (IS_PROD). K_SERVICE is NOT a
// prod signal: the functions emulator sets it identically to Cloud Run, so it can't tell prod from
// dev at all. Deployed Cloud Run sets NODE_ENV=production; the emulator sets NODE_ENV=dev. Kept a
// function so tests can flip env per-case.
export function isProdLike() {
  return /prod(uction)?/i.test(process.env.NODE_ENV || "");
}

// Regional MIG name for a model topic, derived the SAME way deploy.js does — config/models.js
// imageOf(byTopic(topic)) then `${image}-mig` (deploy.js: `mig: `${img.name}-mig``, img.name=imageOf).
// Unknown topic (e.g. the fake tier, which isn't region-steered) → null, so the caller skips actuation
// rather than resize a MIG that doesn't exist.
export function migOf(model) {
  const m = byTopic(model);
  return m ? `${imageOf(m)}-mig` : null;
}

// Reverse map: a MIG instance name (`<image>-mig-<suffix>`) or bare MIG name (`<image>-mig`) → its
// model topic. The stockout path doesn't carry the model as data, but the failed instance's name is in
// the log entry — this recovers the topic so shrink/start actuate the right model's MIG.
export function topicOfInstance(name) {
  if (!name) return null;
  const image = String(name).replace(/-mig(-[^/]*)?$/, "");
  return MODELS.find((m) => imageOf(m) === image)?.topic ?? null;
}

// The default fetch-based GCE client — reuses regions.js's adcToken()/projectId() (metadata token on
// Cloud Run, gcloud fallback off-GCE). Resolution lives INSIDE the client so injecting a fake in tests
// never reaches GCP at all. Regional MIG endpoints only.
function defaultGce() {
  const ctx = async () => ({ token: await adcToken(), project: await projectId() });
  const auth = (token, json) => ({
    headers: { Authorization: `Bearer ${token}`, ...(json ? { "Content-Type": "application/json" } : {}) },
  });
  return {
    // GET the regional MIG → its targetSize (== avail). Missing field → 0.
    async getSize({ region, mig }) {
      const { token, project } = await ctx();
      const r = await fetch(`${COMPUTE}/projects/${project}/regions/${region}/instanceGroupManagers/${mig}`, auth(token));
      if (!r.ok) throw new Error(`get MIG ${mig} → ${r.status} ${(await r.text()).slice(0, 200)}`);
      return (await r.json()).targetSize ?? 0;
    },
    async resize({ region, mig, size }) {
      const { token, project } = await ctx();
      const r = await fetch(`${COMPUTE}/projects/${project}/regions/${region}/instanceGroupManagers/${mig}/resize?size=${size}`, { method: "POST", ...auth(token) });
      if (!r.ok) throw new Error(`resize MIG ${mig} → ${r.status} ${(await r.text()).slice(0, 200)}`);
      return r.json().catch(() => ({}));
    },
    async deleteInstances({ region, mig, instances }) {
      const { token, project } = await ctx();
      const r = await fetch(`${COMPUTE}/projects/${project}/regions/${region}/instanceGroupManagers/${mig}/deleteInstances`, { method: "POST", ...auth(token, true), body: JSON.stringify({ instances }) });
      if (!r.ok) throw new Error(`deleteInstances MIG ${mig} → ${r.status} ${(await r.text()).slice(0, 200)}`);
      return r.json().catch(() => ({}));
    },
  };
}

// One structured actuate line the dashboard/log-metric keys off. `would:true` = off-prod, NO GCE call
// was made; `would:false` = prod, the real call ran.
function logActuate(action, model, region, would, extra = {}) {
  console.log(JSON.stringify({
    message: `[capacity] ${would ? "WOULD " : ""}${action} ${model} · ${region}`,
    capacityEvent: "actuate", would, action, model, region, ...extra,
  }));
}

// need capacity → START a box in `region`: read the model's regional MIG size, resize +1. avail IS the
// MIG target size (no separate counter). Off-prod → would-log + ZERO GCE calls. Never throws.
export async function startBox(model, region, gce = defaultGce()) {
  try {
    if (!region) return { skipped: "no-region" };
    const mig = migOf(model);
    if (!mig) { console.warn(`[capacity] startBox: no MIG for model ${model} — skipping`); return { skipped: "no-mig" }; }
    if (!isProdLike()) { logActuate("resize +1", model, region, true, { mig }); return { would: true, action: "resize +1", mig, region }; }
    const size = await gce.getSize({ region, mig });
    await gce.resize({ region, mig, size: size + 1 });
    logActuate("resize +1", model, region, false, { mig, from: size, to: size + 1 });
    return { action: "resize +1", mig, region, from: size, to: size + 1 };
  } catch (e) {
    console.error(`[capacity] startBox(${model},${region}) swallowed: ${e?.message}`);
    return { error: e?.message };
  }
}

// 3rd consecutive stockout for (model, region) → SHRINK: resize the model's regional MIG to size−1
// (floor 0), giving up on the region. The ONLY resize-DOWN on the stockout path (stockouts 1–2 leave
// the MIG to retry its own boot). Off-prod → would-log + ZERO GCE calls. Never throws.
export async function shrinkBox(model, region, gce = defaultGce()) {
  try {
    if (!region) return { skipped: "no-region" };
    const mig = migOf(model);
    if (!mig) { console.warn(`[capacity] shrinkBox: no MIG for model ${model} — skipping`); return { skipped: "no-mig" }; }
    if (!isProdLike()) { logActuate("resize -1", model, region, true, { mig }); return { would: true, action: "resize -1", mig, region }; }
    const size = await gce.getSize({ region, mig });
    const next = Math.max(0, size - 1);
    await gce.resize({ region, mig, size: next });
    logActuate("resize -1", model, region, false, { mig, from: size, to: next });
    return { action: "resize -1", mig, region, from: size, to: next };
  } catch (e) {
    console.error(`[capacity] shrinkBox(${model},${region}) swallowed: ${e?.message}`);
    return { error: e?.message };
  }
}

// done → RELEASE the specific finished box: a TARGETED deleteInstances on the instance self-link
// (decrements size by 1 without ever touching a busy box). Falls back to a blind size−1 resize ONLY
// when the instance is unknown (off-GCE worker / old worker build with no instance on the event) —
// RISK: GCE picks the victim, so a still-busy box can be evicted; it is logged as untargeted so the
// gap is visible. Off-prod → would-log + ZERO GCE calls. Never throws.
export async function releaseBox(model, region, instance, gce = defaultGce()) {
  try {
    if (!region) return { skipped: "no-region" };
    const mig = migOf(model);
    if (!mig) { console.warn(`[capacity] releaseBox: no MIG for model ${model} — skipping`); return { skipped: "no-mig" }; }
    const action = instance ? "delete-instance" : "resize -1 (untargeted release — may evict a busy box)";
    if (!isProdLike()) { logActuate(action, model, region, true, { mig, instance: instance ?? null }); return { would: true, action: instance ? "delete-instance" : "resize -1", mig, region, instance: instance ?? null }; }
    if (instance) {
      await gce.deleteInstances({ region, mig, instances: [instance] });
      logActuate(action, model, region, false, { mig, instance });
      return { action: "delete-instance", mig, region, instance };
    }
    const size = await gce.getSize({ region, mig });
    const next = Math.max(0, size - 1);
    await gce.resize({ region, mig, size: next });
    logActuate(action, model, region, false, { mig, from: size, to: next });
    return { action: "resize -1", mig, region, from: size, to: next, untargeted: true };
  } catch (e) {
    console.error(`[capacity] releaseBox(${model},${region}) swallowed: ${e?.message}`);
    return { error: e?.message };
  }
}
