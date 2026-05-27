// ============================================================
// Dev - starts local development environment
//
// Requires:
//   - Firebase CLI (npm install -g firebase-tools)
//   - Ollama installed locally (https://ollama.com)
//
// Usage:
//   npm run dev
// ============================================================

import dotenvFlow from "dotenv-flow";
import { spawn } from "child_process";
import { setTimeout as sleep } from "timers/promises";
import { setup as setupPubSub } from "../pubsub/setup.js";

dotenvFlow.config();

const {
  OLLAMA_MODEL = "llama3.2:2b",
  MONGO_URI,
  MONGO_DB,
  MONGO_COLLECTION,
} = process.env;

const GCP_PROJECT_ID = "demo-ollama";
const PUBSUB_EMULATOR_HOST = "localhost:8085";

for (const [k, v] of Object.entries({ MONGO_URI, MONGO_DB, MONGO_COLLECTION })) {
  if (!v) throw new Error(`${k} env var is required — check .env or .env.dev`);
}

const processes = [];

function start(name, cmd, args, env = {}) {
  console.log(`Starting ${name}...`);
  const proc = spawn(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: true,
  });

  proc.on("exit", (code) => {
    if (code !== 0) {
      console.error(`${name} exited with code ${code}`);
      shutdown();
    }
  });

  processes.push({ name, proc });
  return proc;
}

function shutdown() {
  console.log("\nShutting down...");
  for (const { name, proc } of processes) {
    console.log(`  Stopping ${name}`);
    proc.kill();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main() {
  console.log("\n=== Starting Dev Environment ===\n");

  // 1. Firebase emulator (Pub/Sub)
  start("Firebase Emulator", "firebase", [
    "emulators:start",
    "--only=pubsub",
    `--project=${GCP_PROJECT_ID}`,
  ]);

  console.log("Waiting for Firebase emulator...");
  await sleep(5000);

  // 2. Create topics + subscriptions in emulator
  process.env.PUBSUB_EMULATOR_HOST = PUBSUB_EMULATOR_HOST;
  await setupPubSub(GCP_PROJECT_ID);

  // 3. Ollama
  start("Ollama", "ollama", ["serve"], {
    OLLAMA_NUM_PARALLEL: "2",
    OLLAMA_MAX_QUEUE: "5",
  });

  console.log("Waiting for Ollama...");
  await sleep(3000);

  // 4. Pull model if needed
  console.log(`Pulling model: ${OLLAMA_MODEL}`);
  const pull = spawn("ollama", ["pull", OLLAMA_MODEL], { stdio: "inherit", shell: true });
  await new Promise((res) => pull.on("exit", res));

  // 5. Worker pointing at emulator
  start("Worker (slim)", "node", ["worker/index.js"], {
    PUBSUB_EMULATOR_HOST,
    GCP_PROJECT_ID,
    SUBSCRIPTION_NAME: "sub_llama3_2b_v1",
    OLLAMA_MODEL,
    OLLAMA_HOST: "http://localhost:11434",
    MONGO_URI,
    MONGO_DB,
    MONGO_COLLECTION,
  });

  console.log("\n=== Dev environment ready ===");
  console.log("  Firebase Emulator UI : http://localhost:4000");
  console.log("  Ollama               : http://localhost:11434");
  console.log("  Subscription         : sub_llama3_2b_v1");
  console.log("\nTest with:");
  console.log(`  gcloud pubsub topics publish query_llama3_2b_v1 \\`);
  console.log(`    --message='{"jobId":"test-1","query":"List foods safe for a diabetic diet"}' \\`);
  console.log(`    --project=${GCP_PROJECT_ID}\n`);
}

main().catch((err) => {
  console.error("Dev startup failed:", err.message);
  shutdown();
});
