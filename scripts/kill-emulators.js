// ============================================================
// Kill Emulators - tear down any running Firebase emulators.
//
// Shutdown order:
//   1. SIGTERM all port holders
//   2. Wait up to 15s for graceful shutdown
//   3. SIGKILL only for processes still holding ports
//
// Usage:
//   npm run kill:emulators
//   node scripts/kill-emulators.js --dry-run
// ============================================================

import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..");
const FIREBASE_JSON = path.join(PROJECT_ROOT, "firebase.json");

// --- Alimenta (yeschef-llm): match `firebase emulators:start --only=pubsub,functions`
const ACTIVE_EMULATORS = ["functions", "pubsub", "hub", "logging", "ui"];
const LEGACY_PORTS = [];
const EXPORT_DIR = null;
const RESTART_HINT = "npm run dev";

const DEFAULT_PORTS = {
  hub: 4400,
  logging: 4500,
  ui: 4000,
  functions: 5001,
  firestore: 8080,
  database: 9000,
  hosting: 5000,
  pubsub: 8085,
  storage: 9199,
  auth: 9099,
  eventarc: 9299,
  dataconnect: 9399,
  tasks: 9499,
  extensions: 5001,
};

const FALLBACK_EMULATORS = ["functions", "pubsub", "hub", "logging"];
const GRACEFUL_WAIT_MS = 15000;
const POLL_MS = 500;

function resolvePorts() {
  let config = null;
  try {
    config = JSON.parse(fs.readFileSync(FIREBASE_JSON, "utf-8")).emulators || {};
  } catch (err) {
    console.warn(`Could not read ${FIREBASE_JSON} (${err.message}) — falling back to ${FALLBACK_EMULATORS.join(", ")}.`);
  }

  const ports = {};
  const emulatorNames = config ? ACTIVE_EMULATORS : FALLBACK_EMULATORS;

  for (const name of emulatorNames) {
    const entry = config?.[name];
    const configured = entry && typeof entry.port === "number" ? entry.port : null;
    if (configured === null && !(name in DEFAULT_PORTS)) continue;
    ports[name] = configured ?? DEFAULT_PORTS[name];
  }

  return ports;
}

function pidsOnPort(port) {
  try {
    return execSync(`lsof -ti tcp:${port}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function sleep(ms) {
  execSync(`sleep ${ms / 1000}`);
}

function removeFirebaseDebugLogs(dryRun) {
  const dirs = [PROJECT_ROOT, path.join(PROJECT_ROOT, "functions")];
  const removed = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.startsWith("firebase-debug") && entry.name.endsWith(".log")) {
          const logPath = path.join(dir, entry.name);
          if (!dryRun) fs.unlinkSync(logPath);
          removed.push(logPath);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}

function emulatorsRunning(ports) {
  return Object.values(ports).some((port) => pidsOnPort(port).length > 0);
}

function exportEmulatorData(ports, dryRun) {
  if (!EXPORT_DIR) return false;

  const hubPort = ports.hub;
  if (!hubPort || pidsOnPort(hubPort).length === 0) {
    console.log("Emulator hub not running — skip export.");
    return false;
  }

  if (dryRun) {
    console.log(`Would export emulator data → ${EXPORT_DIR}`);
    return true;
  }

  console.log(`Exporting emulator data → ${EXPORT_DIR} ...`);
  try {
    execSync(`firebase emulators:export "${EXPORT_DIR}" --force`, {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      timeout: 180000,
    });
    console.log("Export complete.");
    return true;
  } catch (err) {
    console.warn(`Export failed (${err.message}). Relying on SIGTERM export-on-exit.`);
    return false;
  }
}

function collectTargets(portEntries) {
  const targets = [];
  for (const [name, port] of portEntries) {
    for (const pid of pidsOnPort(port)) {
      targets.push({ name, port, pid });
    }
  }
  return targets;
}

function anyPortHeld(portEntries) {
  return portEntries.some(([, port]) => pidsOnPort(port).length > 0);
}

function shutdownPorts(portEntries, { dryRun, label = "" }) {
  const targets = collectTargets(portEntries);
  if (targets.length === 0) return false;

  const tag = label ? `${label} ` : "";
  const uniquePids = [...new Set(targets.map((t) => t.pid))];

  if (dryRun) {
    for (const { name, port, pid } of targets) {
      console.log(`Would SIGTERM ${tag}${name} on :${port} (pid ${pid}), then SIGKILL if still up after ${GRACEFUL_WAIT_MS / 1000}s`);
    }
    return true;
  }

  for (const pid of uniquePids) {
    try {
      process.kill(Number(pid), "SIGTERM");
      console.log(`Sent SIGTERM to pid ${pid}`);
    } catch (err) {
      console.warn(`SIGTERM failed for pid ${pid}: ${err.message}`);
    }
  }

  const deadline = Date.now() + GRACEFUL_WAIT_MS;
  while (Date.now() < deadline) {
    if (!anyPortHeld(portEntries)) {
      console.log("Emulators shut down gracefully.");
      return true;
    }
    sleep(POLL_MS);
  }

  const survivors = collectTargets(portEntries);
  if (survivors.length === 0) return true;

  console.warn(`Grace period expired — sending SIGKILL to ${survivors.length} stubborn process(es).`);
  const killedPids = new Set();
  for (const { name, port, pid } of survivors) {
    if (killedPids.has(pid)) continue;
    killedPids.add(pid);
    try {
      process.kill(Number(pid), "SIGKILL");
      console.log(`Sent SIGKILL to ${tag}${name} on :${port} (pid ${pid})`);
    } catch (err) {
      console.warn(`SIGKILL failed for ${tag}${name} on :${port} (pid ${pid}): ${err.message}`);
    }
  }

  return true;
}

export function killEmulators({ dryRun = false } = {}) {
  const ports = resolvePorts();
  const portEntries = Object.entries(ports);
  const legacyEntries = LEGACY_PORTS.map((port) => [`legacy:${port}`, port]);

  console.log("Emulators to clear:", Object.keys(ports).join(", "));

  if (emulatorsRunning(ports)) {
    exportEmulatorData(ports, dryRun);
  }

  const stopped =
    shutdownPorts(portEntries, { dryRun })
    || shutdownPorts(legacyEntries, { dryRun, label: "legacy" });

  const removedLogs = removeFirebaseDebugLogs(dryRun);
  if (removedLogs.length) {
    const prefix = dryRun ? "Would remove" : "Removed";
    console.log(`${prefix} firebase-debug log(s):`, removedLogs.join(", "));
  }

  if (!stopped) {
    console.log("No running emulators found on the configured/default ports.");
  } else if (!dryRun) {
    console.log(`Restart with: ${RESTART_HINT}`);
  }

  return stopped;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  killEmulators({ dryRun: process.argv.includes("--dry-run") });
}
