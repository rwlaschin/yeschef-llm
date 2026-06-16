// ============================================================
// Kill Emulators - tear down any running Firebase emulators.
//
// Reads the emulator ports from firebase.json when present, and falls back to
// Firebase's documented default port for any emulator not pinned in config.
// Then finds and kills whatever process is listening on each of those ports.
//
// Why by-port (not `firebase emulators:stop`): a hard-killed `npm run dev`, an
// orphaned java child, or a crashed run can leave emulators bound to their ports
// with no clean handle to stop them. Killing the port holder always works.
//
// Usage:
//   npm run kill:emulators            # kill all configured/default emulators
//   node scripts/kill-emulators.js --dry-run   # show what would be killed
// ============================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIREBASE_JSON = path.join(__dirname, "..", "firebase.json");

const dryRun = process.argv.includes("--dry-run");

// Firebase's documented default emulator ports — used for an emulator that's
// declared in firebase.json but omits its port. (https://firebase.google.com/docs/emulator-suite)
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

// If firebase.json can't be read, scope to this conservative set rather than
// scanning every default port — several Firebase defaults (e.g. hosting :5000)
// collide with unrelated services (macOS AirPlay), and we must never kill those.
const FALLBACK_EMULATORS = ["firestore", "hub", "logging"];

// Resolve { emulatorName: port } to target. The SET of emulators comes from
// firebase.json (only what this project actually runs); each port is the
// configured value, or the documented Firebase default if the entry omits one.
function resolvePorts() {
  let config = null;
  try {
    config = JSON.parse(fs.readFileSync(FIREBASE_JSON, "utf-8")).emulators || {};
  } catch (err) {
    console.warn(`Could not read ${FIREBASE_JSON} (${err.message}) — falling back to ${FALLBACK_EMULATORS.join(", ")}.`);
  }

  const ports = {};

  if (!config) {
    for (const name of FALLBACK_EMULATORS) ports[name] = DEFAULT_PORTS[name];
    return ports;
  }

  for (const [name, entry] of Object.entries(config)) {
    // Skip non-emulator settings (e.g. singleProjectMode: true) and anything we
    // have no default for and that doesn't pin its own port.
    const configured = entry && typeof entry.port === "number" ? entry.port : null;
    if (configured === null && !(name in DEFAULT_PORTS)) continue;
    ports[name] = configured ?? DEFAULT_PORTS[name];
  }
  return ports;
}

// PIDs listening on a TCP port (empty if none). lsof exits non-zero when there's
// no match, which execSync throws on — that's the "nothing here" case.
function pidsOnPort(port) {
  try {
    return execSync(`lsof -ti tcp:${port}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function main() {
  const ports = resolvePorts();
  let killedAny = false;

  for (const [name, port] of Object.entries(ports)) {
    const pids = pidsOnPort(port);
    if (pids.length === 0) continue;

    killedAny = true;
    if (dryRun) {
      console.log(`Would kill ${name} emulator on :${port} (pid ${pids.join(", ")})`);
      continue;
    }
    try {
      execSync(`kill -9 ${pids.join(" ")}`, { stdio: "ignore" });
      console.log(`Killed ${name} emulator on :${port} (pid ${pids.join(", ")})`);
    } catch (err) {
      console.warn(`Failed to kill ${name} emulator on :${port}: ${err.message}`);
    }
  }

  if (!killedAny) console.log("No running emulators found on the configured/default ports.");
}

main();
