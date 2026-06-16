// ============================================================
// One-step deploy — every target WE own, each via its own SCOPED command.
//
//   workers       GPU/MIG          → scripts/deploy.js (Docker build + GCE MIG)
//   orchestrator  /ai function     → firebase deploy --only functions:orchestrator
//
// The dashboard is intentionally NOT a target and must NEVER be deployed (insecure).
// We never run a bare `firebase deploy` — only scoped `--only` — so nothing else in
// the project is ever touched.
//
// Usage:
//   npm run deploy                 # deploy everything, for real
//   npm run deploy:workers         # just the GPU/MIG   (add -- --dry-run to preview)
//   npm run deploy:orchestrator    # just the /ai function
// ============================================================
import { execSync } from "child_process";

const steps = [
  { name: "workers (GPU/MIG)", cmd: "npm run deploy:workers" },
  { name: "orchestrator (/ai)", cmd: "npm run deploy:orchestrator" },
];

for (const { name, cmd } of steps) {
  console.log(`\n=== ${name} ===\n> ${cmd}\n`);
  try {
    execSync(cmd, { stdio: "inherit" });
  } catch {
    console.error(`\nDeploy halted: "${name}" failed.`);
    process.exit(1);
  }
}
console.log("\n✓ All targets deployed.\n");
