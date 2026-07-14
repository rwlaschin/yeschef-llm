// Single source of truth for which regions the GPU worker MIGs live in — imported by both
// scripts/deploy.js (provisions them) and scripts/rollback.js (reverts them) so the two can
// never drift on the region/zone list.
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
export const WORKER_REGIONS = process.env.WORKER_REGIONS
  ? process.env.WORKER_REGIONS.split(";").filter(Boolean).map((r) => {
      const [region, zones] = r.split(":");
      return [region.trim(), zones.split(",").map((z) => z.trim())];
    })
  : [
      ["us-central1", ["a", "b", "c"]],
      ["us-west1",    ["a", "b", "c"]],
      ["us-east1",    ["b", "c", "d"]],
    ];
