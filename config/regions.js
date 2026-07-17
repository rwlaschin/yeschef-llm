// BOOTSTRAP SEED ONLY for which regions the GPU worker MIGs live in. The LIVE region/zone
// topology is discovered from GCP and cached in Mongo — see functions/entry/ai/capacity/regions.js
// (getWorkerRegions()), the single resolver scripts/deploy.js and scripts/rollback.js call. This
// hardcoded list is the fallback used ONLY when both the live GCP query and the Mongo cache are
// unavailable (off-GCE dev, or a Compute + Mongo outage), plus the WORKER_REGIONS env override.
// This module stays PURE — no Mongo/GCP imports — so the resolver and the scripts can import the
// seed without pulling in a DB/HTTP dependency.
//
// Each entry is [region, [zoneLetters]] using that region's VERIFIED nvidia-l4 zones (checked
// against `gcloud compute accelerator-types list`; letters differ per region — e.g. us-east1
// has no -a). A regional MIG only fails over between ITS OWN zones, so a region-wide L4 stockout
// (every zone out at once, as happened 2026-07-14) leaves it spinning with no fallback. Running
// a sibling MIG + autoscaler in each region — all draining the SAME Pub/Sub subscription — lets
// whichever region has capacity pick up the backlog.
//
// Tradeoff: when capacity exists everywhere during an active backlog, each region's autoscaler
// independently scales to cover the full queue, so you can briefly over-provision by up to
// (region count)×. Scale-to-zero + the idle-kill watchdog reclaim the extras within minutes, so
// the cost is bounded burst duplication — the price of surviving a regional stockout.
//
// Override with WORKER_REGIONS="us-central1:a,b,c;us-west1:a,b,c".

// The GPU accelerator type the worker MIGs run on — the exact `gcloud compute accelerator-types`
// name (verified 2026-07-15; nvidia-l4-vws is the workstation variant, NOT this). Single source so
// capacity discovery and any deploy logic reference one definition, never a re-typed magic string.
export const ACCELERATOR = "nvidia-l4";

// The bootstrap seed / env-override fallback (see header). getWorkerRegions() in the capacity
// module resolves the LIVE list; this is only reached when GCP and Mongo are both unavailable.
export const SEED_REGIONS = process.env.WORKER_REGIONS
  ? process.env.WORKER_REGIONS.split(";").filter(Boolean).map((r) => {
      const [region, zones] = r.split(":");
      return [region.trim(), zones.split(",").map((z) => z.trim())];
    })
  : [
      // VERIFIED nvidia-l4 zones (gcloud compute accelerator-types list, 2026-07-15). Widened
      // beyond the original 3 regions to spread stockout risk — more regions = more chances some
      // L4 pool has capacity. NOTE: us-west2 is intentionally ABSENT — it has NO L4 at all, so a
      // MIG there could never place a worker (a region-wide permanent stockout). us-east4 and
      // us-west4 only have L4 in a subset of their zones (no -b), reflected below.
      ["us-central1", ["a", "b", "c"]],
      ["us-west1",    ["a", "b", "c"]],
      ["us-east1",    ["b", "c", "d"]],
      ["us-east4",    ["a", "c"]],
      ["us-west4",    ["a", "c"]],
    ];
