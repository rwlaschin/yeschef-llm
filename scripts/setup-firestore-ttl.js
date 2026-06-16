// ============================================================
// Firestore TTL Setup — auto-delete ephemeral orchestration state.
// Idempotent — safe to run on every deploy. Re-enabling TTL is a no-op.
//
// Auto-delete in Firestore is a FIELD TTL POLICY (not a security rule): each doc
// carries an `expireAt` timestamp, and Firestore deletes it (best-effort, within
// ~24h of expiry) once that time passes. TTL is configured per collection-group and
// does NOT cascade into subcollections — so we enable it on `jobs`, `steps`, AND
// `units` independently. Writers set `expireAt = completedAt + 48h`.
// ============================================================

import { execSync } from "child_process";
// web_search provider subcollections (tools_limits/web_search/<provider>/<day>) — their day-docs
// also carry `expireAt`, so they need a TTL policy per provider collection-group too.
import { SEARCH_PROVIDER_GROUPS } from "../worker/tools/search-pool.js";

const PROJECT = process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT_ID || "yeschef-c572a";
const DATABASE = process.env.FIRESTORE_DATABASE || "(default)";
const FIELD = "expireAt";
// TTL doesn't cascade to subcollections — enable on each collection-group used by the
// orchestration saga (see PLAN_ORCHESTRATION_SPEC.md §2/§11), plus each web_search provider's
// day-doc subcollection (search-pool.js).
const COLLECTION_GROUPS = ["jobs", "steps", "units", ...SEARCH_PROVIDER_GROUPS];

function enableTtl(cg) {
  const dbFlag = DATABASE === "(default)" ? "" : ` --database="${DATABASE}"`;
  const cmd =
    `gcloud firestore fields ttls update ${FIELD}` +
    ` --collection-group=${cg} --enable-ttl --project=${PROJECT}${dbFlag} --quiet`;
  try {
    execSync(cmd, { stdio: "pipe", shell: true });
    console.log(`  ✓ TTL enabled on '${cg}.${FIELD}'`);
    return true;
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || "").toString();
    // Re-running when already enabled is fine; surface anything else.
    if (/already|no change|NOT_FOUND: no field/i.test(msg)) {
      console.log(`  ✓ TTL already configured on '${cg}.${FIELD}'`);
      return true;
    }
    console.error(`  ✗ Failed to enable TTL on '${cg}.${FIELD}':\n${msg.trim()}`);
    return false;
  }
}

function main() {
  console.log("\n=== Firestore TTL Setup ===");
  console.log(`Project: ${PROJECT}   Database: ${DATABASE}   Field: ${FIELD}\n`);

  if (!(() => { try { execSync("gcloud --version", { stdio: "pipe", shell: true }); return true; } catch { return false; } })()) {
    console.error("❌ gcloud CLI not found. Install the Google Cloud SDK, then re-run.\n");
    process.exit(1);
  }

  const ok = COLLECTION_GROUPS.map(enableTtl).every(Boolean);
  if (ok) {
    console.log("\n✓ TTL policies in place. Docs with a past `expireAt` auto-delete (best-effort, ~24h).\n");
  } else {
    console.error("\n⚠️  One or more TTL policies failed — see errors above.\n");
    process.exit(1);
  }
}

main();
