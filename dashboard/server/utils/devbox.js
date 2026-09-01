#!/usr/bin/env node
// HAND-OPERATED Ollama boxes on GCE — deliberately NOT part of the model-tier MIGs.
//
// Why separate: the MIGs (scripts/deploy.js) are autoscaled production capacity; an autoscaler
// decides when those VMs exist. These are yours: names you can see in the console, and a power
// switch you operate. Nothing in deploy.js or rollback.js touches them, and they touch nothing
// those own.
//
// EVERY COMMAND TAKES A BOX NAME, so you can run as many as you want at once — one per model, one
// per experiment, one to keep warm while another rebuilds. Each box is a separate VM with its own
// EPHEMERAL IP, its own disk and its own models. They share ONE firewall rule, so an allowlist
// change covers all of them at once.
//
//   npm run box list                 every box: state, URL, machine, cost
//   npm run box create  <box> [opts] build the VM wherever L4 capacity exists
//   npm run box status  <box>        one box in detail
//   npm run box start   <box>        build + wait for Ollama
//   npm run box stop    <box>        DELETE the VM
//   npm run box stop-all             DELETE every RUNNING VM
//   npm run box allow                add the network you're on to the allowlist
//   npm run box allowlist            who can reach the boxes right now
//   npm run box pull    <box> <model>
//   npm run box delete  <box>        remove the VM (its IP is ephemeral and goes with it)
//
// create options:  --machine=g2-standard-8  --gpus=1  --model=llama3.1:8b  --disk=200  --rounds=5
//
// Each box behaves like any hosted endpoint: `curl http://<IP>:11434/api/tags`, or paste that base
// URL into Msty / Open WebUI / anything speaking the Ollama API. No tunnel, no client to keep open.
import { execSync, spawn, exec } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);
import { readFileSync, writeFileSync, statSync, existsSync, unlinkSync, mkdirSync, rmdirSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenvFlow from "dotenv-flow";
import { createComputeAdapter, isStockoutError } from "./gcp-compute.js";
dotenvFlow.config({ node_env: process.env.NODE_ENV || "dev" });

// Names, machine defaults, zones and rates all come from the declared fleet.
// MUST use the nuxt.config.ts aliases: a relative "../../../config/…" resolves on disk but Nitro
// rewrites it when bundling into .nuxt/dev, failing at RUNTIME with
// "Cannot find module '/Users/<you>/config/devboxes.js'".
import { L4_ZONES, ALL_BOX_NAMES, boxDefaults, vmOf, hostOf, rateFor } from "#devboxes";
import { devModels, parallelOf } from "#models";

const BOX_PARALLEL = Math.max(...devModels().map(parallelOf));

const { GCP_PROJECT_ID = "yeschef-c572a", DEVBOX_ZONE = process.env.GCP_ZONE || "us-central1-a" } = process.env;

const PREFIX = "yc-ollama";
const TAG = "ollama-devbox";
const FW = `${PREFIX}-allow`;
const PORT = 11434;

const hourly = (machine, zone = "") => rateFor(machine, zone.replace(/-[a-z]$/, "")).rate;
const P = `--project=${GCP_PROJECT_ID}`;
const flag = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.split("=").slice(1).join("=") : d; };

const defaultSh = (cmd, quiet = false, timeoutMs = 8000) => {
  try {
    const env = { ...process.env, SSLKEYLOGFILE: "" };
    return execSync(cmd, { encoding: "utf8", env, timeout: timeoutMs, stdio: quiet ? "pipe" : ["inherit", "pipe", "pipe"] }).trim();
  }
  catch (e) { if (quiet) return `ERROR ${e.stderr || e.message}`; throw new Error(`${cmd}\n${e.stderr || e.message}`); }
};

const AUTH_FILE = process.env.DEVBOX_AUTH_FILE || `${process.env.HOME}/.yeschef-devbox-auth.json`;

export function clearAuthCache() {
  try {
    if (existsSync(AUTH_FILE)) unlinkSync(AUTH_FILE);
  } catch {}
}

export function readAuthCache() {
  try {
    const data = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
    if (data && data.expiresAt && Date.now() < data.expiresAt - 300000) {
      return data;
    }
  } catch {}
  return null;
}

export function writeAuthCache(data) {
  try {
    writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

let inFlightCheck = null;

export async function checkAuthAsync() {
  const cached = readAuthCache();
  if (cached && cached.ok) {
    return cached;
  }

  if (inFlightCheck) {
    return inFlightCheck;
  }

  inFlightCheck = (async () => {
    try {
      const env = { ...process.env, SSLKEYLOGFILE: "" };
      const tokenRes = await execAsync(`gcloud auth print-access-token`, { env, timeout: 8000 });
      const token = (tokenRes.stdout || "").trim();

      if (!token || /Reauthentication|ERROR|denied|problem refreshing|cannot prompt|not authenticated/i.test(token)) {
        const failed = { ok: false, account: null, error: `gcloud session expired or unauthenticated. Please run 'gcloud auth login' in your terminal.` };
        writeAuthCache({ ...failed, expiresAt: Date.now() + 10000 });
        return failed;
      }

      let name = "authenticated";
      try {
        const whoRes = await execAsync(`gcloud auth list --filter=status:ACTIVE --format="value(account)"`, { env, timeout: 8000 });
        const who = (whoRes.stdout || "").trim();
        if (who && !/^ERROR/.test(who)) name = who;
      } catch {}

      const success = { ok: true, account: name, error: null, expiresAt: Date.now() + 50 * 60 * 1000 };
      writeAuthCache(success);
      return success;
    } catch (e) {
      const errText = e.stderr || e.stdout || e.message || "";
      if (cached && cached.ok) {
        return cached;
      }
      const failed = { ok: false, account: null, error: `gcloud session unauthenticated: ${errText.slice(0, 100)}` };
      return failed;
    } finally {
      inFlightCheck = null;
    }
  })();

  return inFlightCheck;
}

export function checkAuth(sh = defaultSh) {
  const cached = readAuthCache();
  if (cached && cached.ok) return cached;
  let token = sh(`gcloud auth print-access-token ${P} 2>&1`, true);
  if (/ETIMEDOUT|ENOMEM|EAGAIN/i.test(token)) token = sh(`gcloud auth print-access-token ${P} 2>&1`, true, 30000);
  if (!token || /Reauthentication|ERROR|denied|problem refreshing|cannot prompt|not authenticated/i.test(token)) {
    return { ok: false, account: null, error: `gcloud session expired or unauthenticated. Please run 'gcloud auth login' in your terminal.` };
  }
  const who = sh(`gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>&1`, true);
  const name = /^ERROR/.test(who) ? "" : who.trim();
  const success = { ok: true, account: name || "authenticated", error: null, expiresAt: Date.now() + 50 * 60 * 1000 };
  writeAuthCache(success);
  return success;
}

function requireAuth(sh = defaultSh) {
  const auth = checkAuth(sh);
  if (!auth.ok) {
    console.error(`BLOCKED: ${auth.error}\nRun:  gcloud auth login`);
    process.exit(2);
  }
  return auth.account;
}

const zoneOfVm = (vm, sh = defaultSh) => {
  const out = sh(`gcloud compute instances list ${P} --filter="name=${vm}" --format="value(zone.basename())" 2>&1`, true);
  const z = out.split("\n").map((l) => l.trim()).find((l) => /^[a-z]+-[a-z]+\d+-[a-z]$/.test(l));
  return z || "";
};

export const box = (name, sh = defaultSh) => {
  const vm = vmOf(name);
  const zone = flag("zone", "") || zoneOfVm(vm, sh) || DEVBOX_ZONE;
  return { name, vm, zone, region: zone.replace(/-[a-z]$/, ""), G: `${P} --zone=${zone}` };
};

export const describe = (b, fmt, sh = defaultSh) => {
  const out = sh(`gcloud compute instances describe ${b.vm} ${b.G} --format="value(${fmt})" 2>&1`, true);
  if (/Reauthentication|credentials|not authenticated/i.test(out)) {
    throw new Error(`gcloud session expired or unauthenticated. Please run 'gcloud auth login' in your terminal.`);
  }
  return /ERROR|was not found/i.test(out) ? "" : out;
};

export const ipOf = (b, sh = defaultSh) => describe(b, "networkInterfaces[0].accessConfigs[0].natIP", sh);
export const urlOf = (b, sh = defaultSh) => { const ip = ipOf(b, sh); return ip ? `http://${ip}:${PORT}` : ""; };

const HOSTS = process.env.DEVBOX_HOSTS_FILE || "/etc/hosts";

const isIp = (s) => /^\d+\.\d+\.\d+\.\d+$/.test(s);
const rawIp = (sh = defaultSh) => sh(`curl -s -m 10 https://checkip.amazonaws.com`, true).trim();
export const myIp = (sh = defaultSh) => {
  const ip = rawIp(sh);
  if (!isIp(ip)) {
    console.error(`BLOCKED: could not determine your public IP (got ${JSON.stringify(ip)}).`);
    process.exit(2);
  }
  return ip;
};

export const sources = (sh = defaultSh) => {
  const out = sh(`gcloud compute firewall-rules describe ${FW} ${P} --format="value(sourceRanges.list())" 2>&1`, true);
  return /ERROR|not found/i.test(out) ? [] : out.split(",").map((s) => s.trim()).filter(Boolean);
};

export const allBoxes = (sh = defaultSh) => {
  const out = sh(`gcloud compute instances list ${P} --filter="labels.purpose=ollama-devbox" ` +
                 `--format="csv[no-heading](name,zone,status,machineType.basename(),networkInterfaces[0].accessConfigs[0].natIP,creationTimestamp)" 2>&1`, true);
  if (/ERROR/.test(out) || !out) return [];
  return out.split("\n")
    .filter((l) => l.startsWith(`${PREFIX}-`))
    .map((l) => {
      const [vm, zone, status, machine, ip, createdAt] = l.split(",");
      return { vm, zone, status, machine, ip, createdAt, name: vm.replace(`${PREFIX}-`, "") };
    });
};

export function buildStartupScript({ timeoutMinutes = 5, parallel = BOX_PARALLEL } = {}) {
  const lines = [
    "#!/bin/bash",
    "set -e",
    "if ! command -v ollama >/dev/null; then curl -fsSL https://ollama.com/install.sh | sh; fi",
    "mkdir -p /etc/systemd/system/ollama.service.d",
    // 5m: the model is pulled and loaded at startup, so it must STAY resident across gaps between
    // runs — reloading an 8B model on every pause is the cost this avoids. It also means the runner
    // child outlives real use by up to 5 minutes, which is why the idle check reads GPU utilisation
    // rather than the child's existence.
    `printf "[Service]\\nEnvironment=OLLAMA_HOST=0.0.0.0:11434\\nEnvironment=OLLAMA_KEEP_ALIVE=5m\\nEnvironment=OLLAMA_NUM_PARALLEL=${parallel}\\n" > /etc/systemd/system/ollama.service.d/override.conf`,
    "systemctl daemon-reload && systemctl enable --now ollama",
  ];

  if (timeoutMinutes > 0) {
    lines.push(
      `cat << 'EOF' > /usr/local/bin/idle-watchdog.sh`,
      `#!/bin/bash`,
      `TIMEOUT_MINUTES=${timeoutMinutes}`,
      // IN USE == Ollama has a model loaded, i.e. its per-model child process exists. `ollama serve`
      // itself runs permanently under systemd and proves nothing; the CHILD is forked when a model
      // starts loading and reaped KEEP_ALIVE (60s) after the last request.
      //
      // Utilisation was tried first and is not usable here: while weights load the GPU reads ~0%
      // (a PCIe copy, not compute), the work is single-threaded, and one saturated core on 8 vCPUs is
      // 12.5% aggregate — so it read "unused" and deleted a box mid-request. GPU util also dips to 0
      // between token batches.
      //
      // GPU utilisation, sampled as a MAX over the window rather than one reading: util drops to 0
      // between token batches, so a single sample 30s from the last can land in a gap and call an
      // active generation idle. The runner child's existence is NOT usable as the signal — with
      // KEEP_ALIVE=5m it persists five minutes past the last request.
      //
      // The old blind spot (weights loading shows GPU ~0%) no longer applies: the model is pulled and
      // resident from startup, so nothing arrives before the GPU can show work. A pull is still
      // checked directly, since that runs before any model exists.
      `GPU_BUSY_PCT=5`,
      `gpu_now() { nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null ` +
        `| sort -rn | head -1 | cut -d. -f1; }`,
      // The idle clock does not start until the box HAS a model. Boot + Ollama install + a multi-GB
      // pull is several minutes during which the GPU is legitimately 0% — and the pull is driven from
      // the operator's machine over ssh, so there is no `ollama pull` process here to see either. A
      // 2-minute timeout deleted a box 2m49s into provisioning, before it could ever be used.
      `until curl -s --max-time 5 http://127.0.0.1:11434/api/tags 2>/dev/null | grep -q '"name"'; do`,
      `  echo "$(date -Is) waiting for a model before arming the idle watchdog…"`,
      `  sleep 15`,
      `done`,
      `echo "$(date -Is) model present — idle watchdog armed (timeout \${TIMEOUT_MINUTES}m)"`,
      `LAST_ACTIVE=$(date +%s)`,
      `while true; do`,
      // 6 samples x 5s = the same 30s cadence, but nothing shorter than 5s of GPU work is missed.
      `  PEAK=0`,
      `  for i in 1 2 3 4 5 6; do`,
      `    sleep 5`,
      `    G=$(gpu_now)`,
      `    case "$G" in ''|*[!0-9]*) G=0;; esac`,
      `    [ "$G" -gt "$PEAK" ] && PEAK=$G`,
      `  done`,
      `  NOW=$(date +%s)`,
      `  if [ "$PEAK" -ge "$GPU_BUSY_PCT" ] || pgrep -f "ollama pull" >/dev/null 2>&1; then LAST_ACTIVE=$NOW; fi`,
      `  IDLE_SECS=$((NOW - LAST_ACTIVE))`,
      `  echo "$(date -Is) gpuPeak30s=\${PEAK}% idle=\${IDLE_SECS}s"`,
      `  if [ "$IDLE_SECS" -ge "$((TIMEOUT_MINUTES * 60))" ]; then`,
      `    echo "$(date -Is) no model loaded for $IDLE_SECS s — deleting self."`,
      // DELETE, not poweroff, so auto-stop means what the Stop button means. poweroff left the
      // instance TERMINATED with its 200GB boot disk still billing.
      `    MD="http://metadata.google.internal/computeMetadata/v1/instance"`,
      `    SELF=$(curl -s -H "Metadata-Flavor: Google" $MD/name)`,
      `    SELF_ZONE=$(curl -s -H "Metadata-Flavor: Google" $MD/zone | awk -F/ '{print $NF}')`,
      // Fallback matters: without it a delete that is refused (missing scope/IAM) would leave the
      // box running and billing indefinitely. poweroff at least stops the GPU charge.
      `    gcloud compute instances delete "$SELF" --zone="$SELF_ZONE" --quiet || poweroff`,
      `  fi`,
      `done`,
      `EOF`,
      `chmod +x /usr/local/bin/idle-watchdog.sh`,
      `nohup /usr/local/bin/idle-watchdog.sh > /var/log/idle-watchdog.log 2>&1 &`
    );
  }

  return lines.join("\n");
}

export function getLiveRate(machine, zone = "", status = "STOPPED") {
  if (status === "STOPPED" || !status) {
    return { rate: 0, formatted: "$0.00/hr", isPending: false };
  }
  if (status === "CREATING") {
    return { rate: null, formatted: "--", isPending: true };
  }
  const info = rateFor(machine, (zone || "").replace(/-[a-z]$/, ""));
  return {
    rate: info.rate,
    formatted: `$${info.rate.toFixed(2)}/hr`,
    isReference: info.isReference,
    isPending: false,
  };
}

export const startupTracker = new Map();

// The search runs in a DIFFERENT process from the dashboard's GET handler, so an in-memory Map
// cannot carry progress between them. The file is the channel.
const STARTUP_DIR = process.env.DEVBOX_STARTUP_DIR
  || (process.env.DEVBOX_STARTUP_FILE ? dirname(process.env.DEVBOX_STARTUP_FILE) : `${process.env.HOME}/.yeschef-devbox-startup`);
const statePath = (name) => join(STARTUP_DIR, `${name}.json`);
const cancelPath = (name) => join(STARTUP_DIR, `${name}.cancel.json`);
const validStateName = (name) => ALL_BOX_NAMES.includes(name);

function writeAtomicJson(target, value) {
  mkdirSync(STARTUP_DIR, { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  renameSync(temporary, target);
}

function writeStartupState(name, state) {
  writeAtomicJson(statePath(name), state);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function removeFile(path) {
  try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

export function readStartupState(name) {
  if (!validStateName(name)) return null;
  const s = readJson(statePath(name));
  if (!s) return null;
  const cancellation = readJson(cancelPath(name));
  if (cancellation?.operationId === s.operationId) s.cancelled = true;
  // Pulling is one blocking request that can legitimately be silent for 30 minutes.
  const ttl = s.phase === "pulling" ? 35 * 60000 : 180000;
  return Date.now() - (s.timestamp || 0) > ttl ? null : s;
}

export function readAllStartupStates() {
  let names = [];
  try { names = readdirSync(STARTUP_DIR); } catch { return {}; }
  return Object.fromEntries(names
    .filter((file) => /^00[1-4]\.json$/.test(file))
    .map((file) => file.slice(0, -5))
    .map((name) => [name, readStartupState(name)])
    .filter(([, state]) => state));
}

function startupOwnerIsDead(operationId) {
  const match = /^(\d+)-\d+$/.exec(operationId || "");
  if (!match) return false;
  try {
    process.kill(Number(match[1]), 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

export function beginStartupState(name, operationId, data) {
  if (!validStateName(name) || !operationId) return false;
  const current = readStartupState(name);
  if (current
    && !current.cancelled
    && !new Set(["ready", "failed"]).has(current.phase)
    && !startupOwnerIsDead(current.operationId)) return false;
  if (current?.operationId && readJson(cancelPath(name))?.operationId === current.operationId) {
    removeFile(cancelPath(name));
  }
  const next = { operationId, ...data, timestamp: Date.now() };
  writeStartupState(name, next);
  startupTracker.set(name, next);
  return true;
}

export function clearStartupState(name, operationId) {
  const current = readStartupState(name);
  if (operationId && current?.operationId !== operationId) return false;
  if (!operationId && current && !current.cancelled && !/^(ready|failed)$/.test(current.phase || "")) return false;
  const owner = operationId || current?.operationId;
  removeFile(statePath(name));
  if (owner && readJson(cancelPath(name))?.operationId === owner) removeFile(cancelPath(name));
  startupTracker.delete(name);
  return true;
}

// The cancel flag lives in the FILE: stop runs in a different process than the starter,
// so an in-memory check alone can never see it.
export function cancelStartupState(name, operationId) {
  const current = readStartupState(name);
  if (!current || (operationId && current.operationId !== operationId)) return false;
  const owner = operationId || current.operationId;
  writeAtomicJson(cancelPath(name), { operationId: owner, timestamp: Date.now() });
  startupTracker.set(name, { ...current, cancelled: true });
  return true;
}

// Terminal outcome ('ready' | 'failed') — written unconditionally so the UI learns HOW a
// start ended by event, not by staleness timeout.
export function endStartupState(name, operationId, phase, msg) {
  const current = readStartupState(name);
  if (!current || current.operationId !== operationId || current.cancelled) return false;
  writeStartupState(name, { operationId, phase, msg, timestamp: Date.now() });
  startupTracker.delete(name);
  return true;
}

export function updateStartupState(name, operationId, data) {
  const prev = readStartupState(name);
  if (!prev || prev.operationId !== operationId || prev.cancelled) return false;
  const next = { ...prev, ...data, timestamp: Date.now() };
  startupTracker.set(name, next);
  writeStartupState(name, next);
  return true;
}

const findCapacity = async (b, { operationId, compute, sh = defaultSh, timeoutMinutes = 5, machineOpt, gpusOpt, diskOpt, roundsOpt } = {}) => {
  const def = boxDefaults(b.name);
  const machine = machineOpt || flag("machine", def.machine);
  const gpus = gpusOpt || flag("gpus", String(def.gpus));
  const disk = diskOpt || flag("disk", String(def.disk));
  const roundsVal = roundsOpt !== undefined ? Number(roundsOpt) : Number(flag("rounds", "5"));
  const maxRounds = (roundsVal === 0 || roundsVal === Infinity) ? Infinity : roundsVal;
  if (maxRounds !== Infinity && (!Number.isInteger(maxRounds) || maxRounds < 1)) {
    fail(`--rounds must be a non-negative whole number (0 for infinite), got ${JSON.stringify(roundsOpt || flag("rounds", "5"))}.`);
  }

  const startup = buildStartupScript({ timeoutMinutes, parallel: BOX_PARALLEL });
  let stockouts = 0;
  let r = 1;

  // Stockouts are regional: consecutive probes must land in DIFFERENT regions, so the walk
  // interleaves one zone per region round-robin instead of exhausting a region back to back.
  const byRegion = new Map();
  for (const z of L4_ZONES) {
    const reg = z.replace(/-[a-z]$/, "");
    byRegion.set(reg, [...(byRegion.get(reg) || []), z]);
  }
  const zones = [];
  for (let i = 0; zones.length < L4_ZONES.length; i++) {
    for (const g of byRegion.values()) if (g[i]) zones.push(g[i]);
  }

  while (r <= maxRounds) {
    for (let idx = 0; idx < zones.length; idx++) {
      const zone = zones[idx];
      const attempt = idx + 1;
      if (startupTracker.get(b.name)?.cancelled || readStartupState(b.name)?.cancelled) {
        console.log(`Capacity search for ${b.name} cancelled by user.`);
        startupTracker.delete(b.name);
        return "";
      }
      updateStartupState(b.name, operationId, {
        phase: "hunting",
        zone,
        stockouts,
        round: r,
        attempt,
        totalZones: L4_ZONES.length,
        msg: `Round ${r} · Probing ${zone} (${attempt}/${L4_ZONES.length}) · ${stockouts} stockout${stockouts === 1 ? "" : "s"}`,
      });
      // Hard stop: this VM name must exist in AT MOST one zone, ever.
      const existing = (await compute.listInstances()).find((x) => x.vm === b.vm);
      if (existing) {
        console.log(`  ${existing.zone}: already exists (${existing.status}) — search over.`);
        updateStartupState(b.name, operationId, { phase: "created", zone: existing.zone, stockouts, msg: `Allocated in ${existing.zone} · Initializing OS & network…` });
        return existing.zone;
      }
      let error = null;
      try {
        await compute.createInstance({
          zone,
          instanceResource: {
            name: b.vm,
            machineType: `zones/${zone}/machineTypes/${machine}`,
            guestAccelerators: [{ acceleratorType: `zones/${zone}/acceleratorTypes/nvidia-l4`, acceleratorCount: Number(gpus) }],
            scheduling: { onHostMaintenance: "TERMINATE" },
            disks: [{ boot: true, autoDelete: true, initializeParams: {
              sourceImage: "projects/deeplearning-platform-release/global/images/family/common-cu129-ubuntu-2204-nvidia-580",
              diskSizeGb: String(disk), diskType: `zones/${zone}/diskTypes/pd-balanced`,
            } }],
            networkInterfaces: [{ network: "global/networks/default", accessConfigs: [{ name: "External NAT", type: "ONE_TO_ONE_NAT" }] }],
            tags: { items: [TAG] },
            labels: { owner: "dev", purpose: "ollama-devbox" },
            serviceAccounts: [{ email: "default", scopes: ["https://www.googleapis.com/auth/cloud-platform"] }],
            metadata: { items: [{ key: "startup-script", value: startup }] },
          },
        });
      } catch (caught) {
        error = caught;
      }
      if (startupTracker.get(b.name)?.cancelled || readStartupState(b.name)?.cancelled) {
        console.log(`Capacity search for ${b.name} cancelled by user.`);
        startupTracker.delete(b.name);
        return "";
      }
      if (!error) {
        console.log(`  ${zone}: CREATED`);
        updateStartupState(b.name, operationId, {
          phase: "created",
          zone,
          stockouts,
          msg: `Allocated in ${zone} · Initializing OS & network…`,
        });
        return zone;
      }
      // A create that fails LOCALLY (timeout, broken pipe) is often already ACCEPTED by GCP.
      // Never advance to the next zone without asking GCP — that is how one start became a VM
      // in every L4 zone. A stockout is the one error GCP definitively did not act on.
      if (!isStockoutError(error)) {
        const live = await compute.getInstance({ name: b.vm, zone });
        if (live) {
          console.log(`  ${zone}: CREATED (recovered — create reported "${error.message.slice(0, 60)}" but the VM exists)`);
          updateStartupState(b.name, operationId, { phase: "created", zone, stockouts, msg: `Allocated in ${zone} · Initializing OS & network…` });
          return zone;
        }
        throw error;
      }
      stockouts++;
      console.log(`  ${zone}: stockout`);
      // The result rides the state stream too: stdout reaches the viewer on a slower path,
      // which read as "retrying the same region" when the next probe's line landed first.
      updateStartupState(b.name, operationId, {
        phase: "hunting", zone, stockouts, round: r, attempt, totalZones: L4_ZONES.length,
        msg: `${zone}: stockout — switching region…`,
      });
      sh(`sleep 5`, true);
    }
    r++;
  }
  return "";
};

const probe = (url, sh = defaultSh) => {
  try {
    const out = sh(`curl -s -m 4 -o /dev/null ${url}/api/tags`, true);
    return /^ERROR/.test(out) ? 1 : 0;
  } catch (e) {
    return 1;
  }
};

const waitForOllama = (url, secs = 600, name = "", operationId = "", sh = defaultSh) => {
  process.stdout.write(`Waiting for ${url}`);
  let code = 1;
  for (let i = 0; i < secs / 5; i++) {
    code = probe(url, sh);
    if (code === 0) { console.log(` — up.`); return 0; }
    if (name) updateStartupState(name, operationId, { phase: "installing", msg: `Booting VM & installing Ollama…` });
    process.stdout.write("."); sh("sleep 1", true);
  }
  console.log(`\nNot answering yet. First boot installs Ollama and takes a few minutes; try 'status' again.`);
  return code;
};

const whyUnreachable = (code, sh = defaultSh) => {
  const lines = [code === 7 ? `  curl got CONNECTION REFUSED — the box is reachable; Ollama is not listening yet.`
               : code === 28 ? `  curl TIMED OUT — nothing came back at all, which is what dropped packets look like.`
               : `  curl exited ${code}.`];
  const cur = sources(sh);
  const me = rawIp(sh);
  if (!cur.length) lines.push(`  There is no ${FW} rule at all — nothing can reach tcp:${PORT}.\n  Fix:  npm run box allow`);
  else if (!isIp(me)) lines.push(`  Could not read your public IP, so the allowlist (${cur.join(", ")}) was not checked.`);
  else if (cur.includes(`${me}/32`) || cur.includes("0.0.0.0/0")) lines.push(`  Your IP ${me} IS on the allowlist (${cur.join(", ")}) — this is not the firewall.`);
  else lines.push(`  Your IP ${me} is NOT on the allowlist (${cur.join(", ")}) — the box is fine, your packets are dropped.\n  Fix:  npm run box allow`);
  return lines.join("\n");
};

// Called from 17 places and defined in NONE of them until now, so every one of those error paths
// threw `ReferenceError: fail is not defined` instead of reporting — including the two that say
// "The box is RUNNING and BILLING but unusable".
//
// It THROWS rather than exiting: startDevbox is also a library, called by the dashboard, and its
// callers turn a throw into `{ ok: false }` (devbox-compute.test.js:402 requires exactly that for a
// bad --rounds). A process.exit here would take the caller down with it. The tag is what lets runCli
// print one line and exit 1 instead of dumping a stack at an operator.
export class DevboxFailure extends Error {
  constructor(message) { super(message); this.name = "DevboxFailure"; this.devboxFailure = true; }
}
export const fail = (message) => { throw new DevboxFailure(message); };

const needName = (verb, sh = defaultSh) => {
  const name = process.argv[3];
  if (!name || name.startsWith("--")) {
    console.error(`usage: npm run box ${verb} <box>\nBoxes: ${allBoxes(sh).map((b) => b.name).join(", ") || "(none)"}`);
    process.exit(1);
  }
  return box(name, sh);
};

export const syncHosts = ({ sh = defaultSh, boxes: suppliedBoxes } = {}) => {
  const boxes = (suppliedBoxes || allBoxes(sh)).filter((b) => b.ip);
  if (!boxes.length) {
    console.log(`No running boxes with an IP yet.`);
    return { updated: 0, lines: [] };
  }
  const entries = boxes.map((b) => ({ line: `${b.ip}\t${hostOf(b.name)}`, name: hostOf(b.name) }));
  // Stale lines are dropped for EVERY name in the fleet, not just the boxes currently up. Removing
  // only the live ones left a deleted box's hostname in place forever — and because GCP recycles
  // ephemeral IPs, that stale line silently resolved to a DIFFERENT box (ollama-001 pointing at 002).
  const managed = new Set(ALL_BOX_NAMES.map(hostOf));
  try {
    const kept = readFileSync(HOSTS, "utf8").split("\n").filter((l) => {
      if (/^\s*#/.test(l)) return true;
      const names = l.split("#")[0].trim().split(/\s+/).slice(1);
      return !names.some((n) => managed.has(n));
    });
    const next = `${kept.join("\n").replace(/\n+$/, "")}\n${entries.map((e) => e.line).join("\n")}\n`;
    writeFileSync(HOSTS, next);
    for (const e of entries) console.log(`${HOSTS}: ${e.line}`);
    return { updated: entries.length, lines: entries.map((e) => e.line) };
  } catch (e) {
    console.log(`${HOSTS} is not writable by this user — NOT escalating. Run:\n`);
    console.log(`  sudo sh -c "sed -i '' -E '/^[[:space:]]*#/!{/[[:space:]](${entries.map((e) => e.name).join("|").replace(/\./g, "\\.")})([[:space:]]|\\$)/d;}' ${HOSTS} && printf '%s\\n' ${entries.map((e) => `'${e.line}'`).join(" ")} >> ${HOSTS}"\n`);
    return { updated: 0, lines: entries.map((e) => e.line), error: e.message };
  }
};

export const ensureFirewall = ({ sh = defaultSh } = {}) => {
  if (sources(sh).length) return;
  const me = myIp(sh);
  console.log(`Creating shared firewall ${FW}: tcp:${PORT} from ${me}/32 only…`);
  sh(`gcloud compute firewall-rules create ${FW} ${P} --allow=tcp:${PORT} --target-tags=${TAG} --source-ranges=${me}/32 ` +
     `--description="Ollama devboxes — allowlist only; Ollama has no auth"`, false, 120000);
};

let cachedPublicIp = null;
let lastIpCheck = 0;

// A box is DELETED, not stopped, so uptime dies with it. Today's spend has to outlive the VM:
// each poll stamps lastSeen on the current run, and today's cost is the sum of every run's
// overlap with local midnight..now — including runs already gone.
const USAGE_FILE = process.env.DEVBOX_USAGE_FILE || `${process.env.HOME}/.yeschef-devbox-usage.json`;
const DAY_MS = 86400000;

function readUsage() {
  try { return JSON.parse(readFileSync(USAGE_FILE, "utf8")); } catch { return { runs: {} }; }
}

function recordRun(usage, live, rate) {
  if (!live?.createdAt) return;
  const key = `${live.vm}|${live.createdAt}`;
  // The rate comes from the MACHINE TYPE, never from the caller's status-derived rate: getLiveRate
  // returns 0 for anything not yet RUNNING, and a box first seen while PROVISIONING froze that 0 for
  // its whole life — 55 minutes of real billing showed as $0.00. A VM that exists is charged from
  // creation, whatever GCP calls its status.
  const machineRate = hourly(live.machine, live.zone) || rate || 0;
  const prev = usage.runs[key] || {};
  usage.runs[key] = {
    ...prev,
    vm: live.vm, name: live.name, zone: live.zone, machine: live.machine,
    start: live.createdAt, lastSeen: new Date().toISOString(),
    rate: Math.max(machineRate, prev.rate || 0),
  };
}

function costSince(usage, vm, sinceMs) {
  const now = Date.now();
  let total = 0;
  for (const r of Object.values(usage.runs || {})) {
    if (r.vm !== vm) continue;
    const a = Math.max(Date.parse(r.start), sinceMs);
    const b = Math.min(Date.parse(r.lastSeen), now);
    if (b > a) total += ((b - a) / 3600000) * (r.rate || 0);
  }
  return total;
}

function flushUsage(usage) {
  const cut = Date.now() - 7 * DAY_MS;
  for (const [k, r] of Object.entries(usage.runs)) {
    if (Date.parse(r.lastSeen) < cut) delete usage.runs[k];
  }
  try { writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2)); } catch {}
}

// nvidia-smi over IAP SSH costs ~5s — far longer than the dashboard's 5s poll. Sample it in a
// detached child and serve the last cached reading, so a poll never waits on SSH.
// Cached in a FILE, not a Map: getFleetStatus runs inside the short-lived detached `snapshot`
// process, which exits the moment it has written the snapshot. An in-memory cache died with it, so
// every snapshot started empty, fired an SSH it did not live to read, and reported gpuPercent null
// forever — a RUNNING box permanently showed "GPU ··".
const GPU_FILE = process.env.DEVBOX_GPU_FILE || `${process.env.HOME}/.yeschef-devbox-gpu.json`;
const GPU_SAMPLE_TTL_MS = 15000;
const GPU_PENDING_TTL_MS = 40000;   // longer than the 25s SIGKILL, so a killed child can't wedge it

// The SAMPLE is written by the detached child itself, via shell redirection — not by a close handler
// here. The spawning process (a `snapshot` run) is gone milliseconds later, so any callback it
// registered never fires; only the child outlives it.
const gpuSampleFile = (name) => `${GPU_FILE}.${name}.csv`;
const gpuLockFile = (name) => `${GPU_FILE}.${name}.lock`;

const mtimeOf = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };

function sampleGpu(name, zone) {
  const csv = gpuSampleFile(name);
  const at = mtimeOf(csv);
  const text = at ? (() => { try { return readFileSync(csv, "utf8"); } catch { return ""; } })() : "";
  const m = text.trim().split("\n").pop()?.match(/(\d+)\s*,\s*(\d+)/);
  const prev = at
    ? (m ? { at, util: Number(m[1]), memUsedMb: Number(m[2]), error: null }
         : { at, error: "nvidia-smi unreachable" })
    : null;

  if (!zone) return prev;
  if (prev && Date.now() - at < GPU_SAMPLE_TTL_MS) return prev;
  // The lock is what stops the 5s poll stacking up SSH sessions faster than they finish.
  if (Date.now() - mtimeOf(gpuLockFile(name)) < GPU_PENDING_TTL_MS) return prev;

  try { writeFileSync(gpuLockFile(name), "1"); } catch { /* best-effort */ }
  // The lock is REMOVED as the child's last act. Leaving it in place made GPU_PENDING_TTL_MS the real
  // cadence — an SSH sample takes ~4s, but the next one could not start for 40s, so the UI asserted a
  // 40-second-old utilisation as current: 0% held while VRAM showed a model mid-generation.
  const lock = gpuLockFile(name);
  const cmd = `gcloud compute ssh ${vmOf(name)} ${P} --zone=${zone} --tunnel-through-iap ` +
    `--command='nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits' ` +
    `> ${csv}.tmp 2>/dev/null && mv ${csv}.tmp ${csv}; rm -f ${csv}.tmp ${lock}`;
  const child = spawn("/bin/sh", ["-c", cmd], {
    stdio: "ignore", detached: true, env: { ...process.env, SSLKEYLOGFILE: "" },
  });
  child.unref(); // must not hold (or take down) the Nitro worker that spawned it
  return prev;
}

export async function getFleetStatus({ exec = defaultSh, clientIp = "" } = {}) {
  const auth = checkAuth(exec);
  const liveBoxes = allBoxes(exec);
  const fwSources = sources(exec);
  let detectedIp = clientIp;
  if (!detectedIp || detectedIp === "::1" || detectedIp === "127.0.0.1" || detectedIp.startsWith("::ffff:127.")) {
    const now = Date.now();
    if (!cachedPublicIp || now - lastIpCheck > 60000) {
      cachedPublicIp = rawIp(exec) || "";
      lastIpCheck = now;
    }
    detectedIp = cachedPublicIp;
  }

  const usage = readUsage();
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);

  const declaredNames = ["001", "002", "003", "004"];
  const boxes = declaredNames.map((name) => {
    const live = liveBoxes.find((b) => b.name === name);
    const def = boxDefaults(name);
    const activeProgress = startupTracker.get(name) || readStartupState(name);
    const vmLive = !!live && ["RUNNING", "PROVISIONING", "STAGING"].includes(live.status);

    const zone = live ? live.zone : (activeProgress?.zone || def.zones?.[0] || "");
    const machine = live ? live.machine : def.machine;
    const ip = live ? live.ip : "";
    const endpoint = ip ? `http://${ip}:${PORT}` : "";

    let models = [];
    let loadedModels = [];
    let vramUsedBytes = 0;
    const vramTotalBytes = 24 * 1e9; // 24GB NVIDIA L4
    let expiresAt = null;
    let serving = false;

    // GCP reports RUNNING minutes before Ollama listens — answering /api/tags is what "started" means.
    if (live?.status === "RUNNING" && endpoint) {
      try {
        const tags = exec(`curl -s -m 4 ${endpoint}/api/tags`, true);
        if (tags && !/ERROR/.test(tags)) {
          models = (JSON.parse(tags).models || []).map((m) => m.name);
          serving = true;
        }
        const ps = exec(`curl -s -m 4 ${endpoint}/api/ps`, true);
        if (ps && !/ERROR/.test(ps)) {
          const psData = JSON.parse(ps);
          const psModels = psData.models || [];
          loadedModels = psModels.map((m) => m.name);
          vramUsedBytes = psModels.reduce((sum, m) => sum + (m.size_vram || m.size || 0), 0);
          if (psModels[0]?.expires_at) {
            expiresAt = psModels[0].expires_at;
          }
        }
      } catch {}
    }

    // RUNNING requires a MODEL, not just an answering port. Ollama serves /api/tags for the whole
    // multi-GB pull, so "serving" alone showed RUNNING on a box where every generation 404s — twice
    // that was relayed to a teammate as "ready" and she hit model-not-found.
    const usable = serving && models.length > 0;
    const activeStart = !!activeProgress && !activeProgress.cancelled && !/^(ready|failed)$/.test(activeProgress.phase || "");
    let status = "STOPPED";
    if (usable) status = "RUNNING";
    else if (serving || vmLive || activeStart) status = "STARTING";
    // A delete in flight is worth showing — the VM still exists and still bills — but it must NOT
    // outrank a start the user just asked for. One row serves one box NAME, so while the previous
    // instance was deleting, a fresh start on that row reported the OLD instance's STOPPING.
    if (!activeStart && /^(STOPPING|SUSPENDING|TERMINATED)$/.test(live?.status || "")) status = "STOPPING";

    if (usable && /^(ready|failed)$/.test(activeProgress?.phase || "")) {
      clearStartupState(name, activeProgress.operationId);
    } else if (usable && startupTracker.get(name) && !activeProgress?.operationId) {
      startupTracker.delete(name);
    }

    const bootPhase = !live ? null
      : live.status !== "RUNNING" ? { phase: "booting", msg: `VM ${live.status.toLowerCase()} in ${zone}…` }
      : !serving ? { phase: "installing", msg: `VM up in ${zone} · waiting for Ollama on :${PORT}…` }
      // Ollama answers throughout the pull, so this phase is where the multi-GB download actually is.
      : !models.length ? { phase: "pulling", msg: `Ollama up · pulling model — not usable yet…` }
      : null;

    const rate = getLiveRate(machine, zone, status);
    const gpu = status === "STOPPED" ? null : sampleGpu(name, zone);
    // Utilisation is a POINT-IN-TIME reading fetched over SSH, so its age is part of the value. Past
    // this window the honest answer is "don't know", not the last number seen — reporting a stale 0%
    // beside a model that was clearly working is what made the panel untrustworthy.
    const gpuAgeMs = gpu?.at ? Date.now() - gpu.at : null;
    const gpuFresh = gpuAgeMs != null && gpuAgeMs <= 30000;
    const gpuLoadPercent = gpu && gpu.util != null && gpuFresh ? gpu.util : null;

    // nvidia-smi sees all VRAM in use; /api/ps only sees Ollama's own resident models.
    const vramBytes = gpu?.memUsedMb != null ? gpu.memUsedMb * 1e6 : vramUsedBytes;
    const vramGb = (vramBytes / 1e9).toFixed(1);
    const vramPercent = Math.min(100, Math.round((vramBytes / vramTotalBytes) * 100));

    const upSeconds = live?.createdAt ? Math.max(0, (Date.now() - Date.parse(live.createdAt)) / 1000) : 0;
    const runCost = (upSeconds / 3600) * (rate.rate || 0);
    if (live) recordRun(usage, live, rate.rate || 0);
    const dayCost = costSince(usage, vmOf(name), midnight.getTime());

    return {
      name,
      vm: vmOf(name),
      status,
      machine,
      cpuSpec: "8 vCPU · 32GB",
      gpuSpec: "1x L4 (24GB)",
      gpuLoad: {
        percent: gpuLoadPercent,
        formatted: status === "STOPPED" ? "-"
          : gpuLoadPercent == null ? (gpu?.error || "sampling…")
          : `${gpuLoadPercent}%`,
        sampledAt: gpu?.at ? new Date(gpu.at).toISOString() : null,
        error: gpu?.error || null,
      },
      gpuPercent: gpuLoadPercent,
      vram: {
        usedGb: vramGb,
        totalGb: 24,
        percent: vramPercent,
        formatted: `${vramGb} / 24 GB (${vramPercent}%)`,
      },
      todayCost: +dayCost.toFixed(2),
      todayCostFormatted: `$${dayCost.toFixed(2)}`,
      runCost: +runCost.toFixed(2),
      runCostFormatted: `$${runCost.toFixed(2)}`,
      upSeconds: Math.round(upSeconds),
      serving,
      startupProgress: status !== "STARTING" ? null
        : (startupTracker.get(name) || readStartupState(name) || bootPhase || { phase: "hunting", msg: "Searching L4 capacity…" }),
      expiresAt,
      isIdle: gpuLoadPercent != null ? gpuLoadPercent < 10 : loadedModels.length === 0,
      zone,
      ip,
      endpoint,
      rate,
      models,
      loadedModels,
      defaultModel: def.model,
    };
  });

  flushUsage(usage);

  return {
    ok: true,
    auth,
    firewall: {
      clientIp: detectedIp,
      allowedRanges: fwSources,
      isAllowed: fwSources.includes(`${detectedIp}/32`) || fwSources.includes("0.0.0.0/0"),
    },
    boxes,
  };
}

// The dashboard runs `start` as a detached CLI process, so every option it cares about — above all
// --timeout, which installs the idle watchdog — must come off argv or the box bills forever.
export const modelArg = (argv = process.argv) => {
  const named = argv.find((arg) => arg.startsWith("--model="));
  if (named) return named.split("=").slice(1).join("=");
  return argv[4] && !argv[4].startsWith("--") ? argv[4] : undefined;
};

const cliStartOpts = () => ({
  timeoutMinutes: Number(flag("timeout", "5")) || 5,
  model: modelArg(),
  machine: flag("machine", undefined),
  gpus: flag("gpus", undefined),
  disk: flag("disk", undefined),
  rounds: flag("rounds", undefined),
});

// getFleetStatus makes ~6 blocking execSync gcloud calls (~3.5s). Served straight from a request
// handler it saturates the single Nitro worker and the whole dashboard wedges. So the handler reads
// this snapshot instead, and a detached process refreshes it.
const FLEET_FILE = process.env.DEVBOX_FLEET_FILE || `${process.env.HOME}/.yeschef-devbox-fleet.json`;
const FLEET_LOCK = `${FLEET_FILE}.lock`;

export function acquireFleetSnapshotLock(lockPath = FLEET_LOCK, now = Date.now()) {
  const acquire = () => {
    mkdirSync(lockPath);
    return () => { try { rmdirSync(lockPath); } catch (error) { if (error.code !== "ENOENT") throw error; } };
  };
  try { return acquire(); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      if (now - statSync(lockPath).mtimeMs <= 60000) return null;
      rmdirSync(lockPath);
      return acquire();
    } catch (retryError) {
      if (["EEXIST", "ENOENT", "ENOTEMPTY"].includes(retryError.code)) return null;
      throw retryError;
    }
  }
}

export function readFleetSnapshot() {
  try {
    const snap = JSON.parse(readFileSync(FLEET_FILE, "utf8"));
    return { ...snap, ageMs: Date.now() - (snap.at || 0) };
  } catch {
    return null;
  }
}

export async function writeFleetSnapshot() {
  const release = acquireFleetSnapshotLock();
  if (!release) return readFleetSnapshot();
  try {
    // Every gcloud call fails once the session expires, so probing the fleet would overwrite the last
    // known boxes with errors. Keep them and stamp auth:false — that flag is the only way the
    // dashboard ever learns the session died.
    const auth = checkAuth();
    if (!auth.ok) {
      const prev = readFleetSnapshot() || { boxes: [], firewall: null };
      const fleet = { ...prev, ok: true, auth };
      delete fleet.ageMs;
      writeFileSync(FLEET_FILE, JSON.stringify({ ...fleet, at: Date.now() }, null, 2));
      return fleet;
    }
    const fleet = await getFleetStatus({});
    writeFileSync(FLEET_FILE, JSON.stringify({ ...fleet, at: Date.now() }, null, 2));
    return fleet;
  } finally {
    release();
  }
}

export async function startDevbox(name, { compute = createComputeAdapter({ projectId: GCP_PROJECT_ID }), exec = defaultSh, timeoutMinutes = 5, model, machine, gpus, disk, rounds } = {}) {
  const operationId = `${process.pid}-${Date.now()}`;
  try {
    if (!beginStartupState(name, operationId, { phase: "preflight", msg: "Checking authentication and existing infrastructure…" })) {
      return { ok: false, error: `${name} already has a startup operation in progress.`, message: `${name} already has a startup operation in progress.` };
    }
    const auth = await compute.checkAuth();
    if (!auth.ok) {
      endStartupState(name, operationId, "failed", `Authentication blocked: ${auth.error}. Run gcloud auth application-default login and retry.`);
      return { ok: false, authRequired: true, error: auth.error, message: `BLOCKED: ${auth.error}` };
    }

    const sourceIp = myIp(exec);
    updateStartupState(name, operationId, { phase: "preflight", msg: "Checking network access for Ollama…" });
    await compute.ensureFirewall({ name: FW, port: PORT, tag: TAG, sourceRanges: [`${sourceIp}/32`] });

    const vm = vmOf(name);
    updateStartupState(name, operationId, { phase: "preflight", msg: "Checking for an existing VM…" });
    const liveBoxes = await compute.listInstances();
    const existing = liveBoxes.find((item) => item.vm === vm)
      || await compute.getInstance({ name: vm, zone: DEVBOX_ZONE });
    const b = { name, vm, zone: existing?.zone || DEVBOX_ZONE };
    const s = existing?.status || "";
    if (s === "RUNNING") {
      const targetModel = model || flag("model", boxDefaults(name).model);
      const url = `http://${existing.ip}:${PORT}`;
      console.log(`${b.vm} already RUNNING in ${b.zone}.`);
      syncHosts({ sh: exec, boxes: liveBoxes });
      const code = waitForOllama(url, 600, name, operationId, exec);
      if (code) fail(whyUnreachable(code, exec));
      updateStartupState(name, operationId, { phase: "pulling", zone: b.zone, msg: `Pulling ${targetModel} model…` });
      const body = JSON.stringify({ model: targetModel, stream: false });
      const pull = exec(`curl -sS -m 1800 -X POST ${url}/api/pull -H 'Content-Type: application/json' -d '${body}'`, true, 1800000);
      if (/^ERROR/.test(pull)) fail(`${targetModel} was NOT pulled onto ${b.vm}: ${pull.slice(0, 500)}`);
      endStartupState(name, operationId, "ready", `${targetModel} ready in ${b.zone} — box is RUNNING.`);
      return { ok: true, status: "RUNNING", zone: b.zone, ip: existing.ip, model: targetModel };
    }
    if (s && s !== "TERMINATED") {
      fail(`${b.vm} exists in ${b.zone} with status ${s} — not adopting a half-state. Delete it, then start again.`);
    }
    if (s === "TERMINATED") {
      await compute.deleteInstance({ name: b.vm, zone: b.zone });
    }

    updateStartupState(name, operationId, {
      phase: "hunting",
      zone: L4_ZONES[0],
      round: 1,
      stockouts: 0,
      attempt: 1,
      totalZones: L4_ZONES.length,
      msg: `Round 1 · Probing ${L4_ZONES[0]} (1/${L4_ZONES.length}) · 0 stockouts`
    });
    const zone = await findCapacity(b, { operationId, compute, sh: exec, timeoutMinutes, machineOpt: machine, gpusOpt: gpus, diskOpt: disk, roundsOpt: rounds });
    if (!zone) {
      const wasCancelled = readStartupState(name)?.cancelled
      if (!wasCancelled) endStartupState(name, operationId, "failed", `No L4 capacity available — search exhausted every US zone.`);
      else startupTracker.delete(name);
      return { ok: true, status: "STOPPED", zone: "", message: "Capacity search cancelled or no capacity available." };
    }

    const boxInst = { ...b, zone, region: zone.replace(/-[a-z]$/, ""), G: `${P} --zone=${zone}` };
    const created = await compute.getInstance({ name: b.vm, zone });
    const ip = created?.ip || "";
    console.log(`Created and RUNNING in ${zone} at ${ip}. First boot installs Ollama — a few minutes.`);
    syncHosts({ sh: exec, boxes: await compute.listInstances() });

    const targetModel = model || flag("model", boxDefaults(name).model);
    // The VM this process created, identified by creation time — the NAME alone is not identity. A
    // start whose box was deleted underneath it (by the idle watchdog, or a Stop) kept running on this
    // machine and then pulled into the NEXT box of the same name, racing that box's own pull. Two
    // concurrent pulls of one model left the blob on disk with no manifest registered, so /api/tags
    // read empty on a box that already had the weights.
    const ownCreatedAt = created?.createdAt || "";
    const stillOurs = async () => {
      const cur = await compute.getInstance({ name: boxInst.vm, zone });
      return !!cur && (!ownCreatedAt || cur.createdAt === ownCreatedAt);
    };

    updateStartupState(name, operationId, { phase: "installing", zone, msg: `Booting VM in ${zone} · Installing Ollama daemon…` });
    const code = waitForOllama(`http://${ip}:${PORT}`, 600, name, operationId, exec);
    if (code) console.log(whyUnreachable(code, exec));

    if (!await stillOurs()) {
      startupTracker.delete(name);
      console.log(`${boxInst.vm} created at ${ownCreatedAt} is gone — abandoning this start instead of pulling into its replacement.`);
      return { ok: false, status: "STOPPED", zone, message: `${boxInst.vm} was deleted while starting.` };
    }

    updateStartupState(name, operationId, { phase: "pulling", zone, msg: `Pulling ${targetModel} weights into GPU VRAM…` });
    // Pull through Ollama itself. Compute SSH has separate interactive credentials and can fail
    // after the ADC-backed create succeeded, leaving a healthy but empty VM behind.
    const body = JSON.stringify({ model: targetModel, stream: false });
    const pull = exec(`curl -sS -m 1800 -X POST http://${ip}:${PORT}/api/pull -H 'Content-Type: application/json' -d '${body}'`, true, 1800000);
    if (/^ERROR/.test(pull)) {
      startupTracker.delete(name);
      fail(`\n${targetModel} was NOT pulled onto ${b.vm}. The box is RUNNING and BILLING, and unusable until it has a model.\n` +
           `${pull.slice(0, 500)}\nRetry:  npm run box pull ${b.name} ${targetModel}`);
    }

    // A pull can exit 0 having written the blob without registering a manifest, leaving /api/tags
    // empty on a box that holds the weights — every generation then 404s while the box looks ready.
    // /api/pull re-registers an on-disk blob in well under a second, so this costs nothing when the
    // pull was clean and repairs it when it was not.
    const listed = () => {
      const t = exec(`curl -s -m 8 http://${ip}:${PORT}/api/tags`, true);
      return !/ERROR/.test(t || "") && new RegExp(`"name"\\s*:\\s*"${targetModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(t || "");
    };
    if (!listed()) {
      console.log(`${targetModel} is on disk but not listed by /api/tags — re-registering…`);
      exec(`curl -s -m 600 -X POST http://${ip}:${PORT}/api/pull -d '{"model":${JSON.stringify(targetModel)},"stream":false}'`, true, 600000);
      if (!listed()) {
        startupTracker.delete(name);
        fail(`\n${targetModel} still not listed on ${b.vm} after re-registering. The box is RUNNING and BILLING but unusable.\n` +
             `Retry:  npm run box pull ${b.name} ${targetModel}`);
      }
      console.log(`${targetModel} registered.`);
    }

    endStartupState(name, operationId, "ready", `${targetModel} ready in ${zone} — box is RUNNING.`);
    return { ok: true, status: "RUNNING", zone, ip, model: targetModel };
  } catch (err) {
    const msg = err.message || String(err);
    endStartupState(name, operationId, "failed", msg.slice(0, 200));
    if (err.code === 401 || /authentication credentials|unauthenticated/i.test(msg)) {
      return { ok: false, authRequired: true, error: msg, message: `BLOCKED: ${msg}` };
    }
    return { ok: false, error: msg, message: msg };
  }
}

export async function stopDevbox(name, { exec = defaultSh } = {}) {
  cancelStartupState(name);

  let b = box(name, exec);
  let s = describe(b, "status", exec);
  if (!s) {
    // Never report STOPPED on the strength of a zone guess. If a VM with this name exists in ANY
    // zone, it is billing, and "search cancelled" would be a false success.
    const live = allBoxes(exec).find((x) => x.vm === vmOf(name));
    if (!live) return { ok: true, status: "STOPPED", message: `${vmOf(name)} search cancelled.` };
    b = { ...b, zone: live.zone, G: `${P} --zone=${live.zone}` };
    s = live.status;
  }

  exec(`gcloud compute instances delete ${b.vm} ${b.G} --quiet`, false, 300000);
  console.log(`${b.vm} DELETED. All billing ends — no compute, no disk, no address. Its model will be re-pulled on the next start.`);
  startupTracker.delete(name);
  return { ok: true, status: "STOPPED", message: `${b.vm} deleted.` };
}

export async function allowCurrentIp(ip, { exec = defaultSh } = {}) {
  ensureFirewall({ sh: exec });
  const targetIp = ip || myIp(exec);
  const cur = sources(exec);
  if (cur.includes(`${targetIp}/32`)) {
    console.log(`${targetIp}/32 already allowed. Current: ${cur.join(", ")}`);
    return { ok: true, allowed: cur, message: `${targetIp}/32 already allowed.` };
  }
  const next = [...cur, `${targetIp}/32`].join(",");
  exec(`gcloud compute firewall-rules update ${FW} ${P} --source-ranges=${next}`, false, 120000);
  console.log(`Added ${targetIp}/32 — applies to every box. Now allowed: ${next}`);
  return { ok: true, allowed: next.split(","), message: `Added ${targetIp}/32 to allowlist.` };
}

export async function warmDevboxModel(name, model, { exec = defaultSh } = {}) {
  const b = box(name, exec);
  const url = urlOf(b, exec);
  if (describe(b, "status", exec) !== "RUNNING") fail(`${b.vm} is not running.`);

  const tags = exec(`curl -s -m 8 ${url}/api/tags`, true);
  if (/ERROR/.test(tags)) fail(`${b.vm} is not answering at ${url}.`);

  let have = [];
  try { have = (JSON.parse(tags).models || []).map((m) => m.name); } catch {}
  if (!have.includes(model) && !have.includes(`${model}:latest`)) {
    console.log(`${model} is not on ${name} yet — pulling (this can take a while)…`);
    const r = exec(`curl -s -m 3600 -X POST ${url}/api/pull -d '{"model":${JSON.stringify(model)},"stream":false}'`, true);
    if (/ERROR|"error"/.test(r)) fail(`pull failed: ${r.slice(0, 300)}`);
  }

  console.log(`Loading ${model} into VRAM…`);
  const r = exec(`curl -s -m 600 -X POST ${url}/api/generate -d '{"model":${JSON.stringify(model)},"prompt":"","stream":false}'`, true);
  if (/ERROR|"error"/.test(r)) fail(`load failed: ${r.slice(0, 300)}`);

  console.log(`${name} is now warm on ${model}.  ${url}`);
  return { ok: true, model, url };
}

export const cmds = {
  async list() {
    const boxes = allBoxes();
    if (!boxes.length) return console.log(`No devboxes. Create one: node scripts/devbox.js create <name>`);
    let running = 0;
    console.log(`${"BOX".padEnd(12)} ${"STATE".padEnd(10)} ${"MACHINE".padEnd(16)} ${"URL".padEnd(30)} ZONE`);
    for (const b of boxes) {
      if (b.status === "RUNNING") running++;
      console.log(`${b.name.padEnd(12)} ${b.status.padEnd(10)} ${(b.machine || "?").padEnd(16)} ${(b.ip ? `http://${b.ip}:${PORT}` : "-").padEnd(30)} ${b.zone}`);
    }
    const burn = boxes.filter((b) => b.status === "RUNNING").reduce((n, b) => n + hourly(b.machine, b.zone), 0);
    console.log(`\n${running} running of ${boxes.length} — ~$${burn.toFixed(2)}/hr.`);
    console.log(`ACCESS: tcp:${PORT} from ${sources().join(", ") || "(no firewall rule!)"}`);
  },
  async create() {
    const b = needName("create");
    return startDevbox(b.name, cliStartOpts());
  },
  async start() {
    const b = needName("start");
    return startDevbox(b.name, cliStartOpts());
  },
  async snapshot() {
    await writeFleetSnapshot();
    console.log(`snapshot written`);
  },
  async stop() {
    const b = needName("stop");
    await stopDevbox(b.name);
  },
  async "stop-all"() {
    const running = allBoxes().filter((b) => b.status === "RUNNING");
    if (!running.length) return console.log(`Nothing running.`);
    for (const b of running) {
      console.log(`Deleting ${b.vm}…`);
      defaultSh(`gcloud compute instances delete ${b.vm} ${P} --zone=${b.zone} --quiet`, false, 300000);
    }
    console.log(`Deleted ${running.length} box(es). All billing ends — no compute, no disk, no address.`);
  },
  async status() {
    const b = needName("status");
    const s = describe(b, "status");
    if (!s) return console.log(`${b.vm}: does not exist in ${b.zone}.`);
    const machine = describe(b, "machineType.basename()");
    const url = urlOf(b);
    console.log(`${b.vm}: ${s}   ${machine}   zone=${b.zone}`);
    console.log(`URL:     ${url}`);
    console.log(`BILLING: ${s === "RUNNING" ? `~$${hourly(machine, b.zone).toFixed(2)}/hr while RUNNING` : `${s} — no compute, but its boot disk bills until the box is deleted`}`);
    console.log(`ACCESS:  tcp:${PORT} from ${sources().join(", ") || "(no firewall rule!)"}`);
    const tags = defaultSh(`curl -s -m 5 ${url}/api/tags`, true);
    if (/ERROR/.test(tags) || !tags) {
      console.log(`OLLAMA:  not answering.${s === "RUNNING" ? ` If you changed networks: node scripts/devbox.js allow` : ` (VM is ${s})`}`);
    } else {
      let models = [];
      try { models = (JSON.parse(tags).models || []).map((m) => m.name); } catch {}
      console.log(`OLLAMA:  answering — models: ${models.join(", ") || "(none pulled)"}`);
      if (!models.length) console.log(`BROKEN:  no models — every generation 404s. Fix: node scripts/devbox.js pull ${b.name} <model>`);
      console.log(`\n  curl ${url}/api/tags`);
      console.log(`  Msty / Open WebUI → Ollama provider, base URL: ${url}`);
    }
  },
  async allow() {
    await allowCurrentIp();
  },
  async allowlist() {
    const cur = sources();
    console.log(cur.length ? `tcp:${PORT} allowed from:\n  ${cur.join("\n  ")}` : `No firewall rule ${FW} — nothing can reach the boxes.`);
    if (cur.includes("0.0.0.0/0")) console.log(`\nWARNING: open to the whole internet, and Ollama has NO auth. Narrow this.`);
  },
  async pull() {
    const b = needName("pull");
    const model = process.argv[4];
    if (!model) return fail(`usage: npm run box pull <box> <model>`);
    if (describe(b, "status") !== "RUNNING") return fail(`${b.vm} is not running.`);
    spawn("gcloud", ["compute", "ssh", b.vm, P, `--zone=${b.zone}`, "--tunnel-through-iap", "--command", `ollama pull ${model}`], { stdio: "inherit" });
  },
  async models() {
    const b = needName("models");
    const url = urlOf(b);
    const tags = defaultSh(`curl -s -m 8 ${url}/api/tags`, true);
    if (/ERROR/.test(tags) || !tags) return fail(`${b.vm} is not answering at ${url}. Start it, or run: npm run box allow`);
    const ps = defaultSh(`curl -s -m 8 ${url}/api/ps`, true);
    let loaded = [];
    try { loaded = (/ERROR/.test(ps) ? [] : (JSON.parse(ps).models || []).map((m) => m.name)); } catch {}
    let modelsList = [];
    try { modelsList = JSON.parse(tags).models || []; } catch {}
    for (const m of modelsList) {
      const gb = (m.size / 1e9).toFixed(1);
      console.log(`  ${loaded.includes(m.name) ? "●" : "○"} ${m.name.padEnd(28)} ${gb}GB`);
    }
    console.log(`\n● = loaded in VRAM now.  Switch with: npm run box use ${b.name} <model>`);
  },
  async use() {
    const b = needName("use");
    const model = process.argv[4];
    if (!model) return fail(`usage: npm run box use <box> <model>`);
    await warmDevboxModel(b.name, model);
  },
  async chat() {
    const b = needName("chat");
    const prompt = process.argv.slice(4).filter((a) => !a.startsWith("--")).join(" ") || "Say hello in one short sentence.";
    const url = urlOf(b);
    const tags = defaultSh(`curl -s -m 8 ${url}/api/tags`, true);
    if (/ERROR/.test(tags) || !tags) return fail(`${b.vm} is not answering at ${url}. Start it, or run: npm run box allow`);
    const ps = defaultSh(`curl -s -m 8 ${url}/api/ps`, true);
    let warm = "";
    try { warm = (/ERROR/.test(ps) ? [] : (JSON.parse(ps).models || []).map((m) => m.name))[0] || ""; } catch {}
    let firstModel = "";
    try { firstModel = (JSON.parse(tags).models || [])[0]?.name || ""; } catch {}
    const model = flag("model", warm || firstModel);
    if (!model) return fail(`${b.name} holds no models. npm run box use ${b.name} <model>`);
    console.log(`[${b.name} · ${model}] ${prompt}\n`);
    const t0 = Date.now();
    const body = JSON.stringify({ model, prompt, stream: false });
    const out = defaultSh(`curl -s -m 600 -X POST ${url}/api/generate -d ${JSON.stringify(body)}`, true);
    if (/ERROR/.test(out)) return fail(out.slice(0, 300));
    let j = {};
    try { j = JSON.parse(out); } catch {}
    console.log(j.response?.trim() || JSON.stringify(j).slice(0, 400));
    if (j.eval_count && j.eval_duration) {
      console.log(`\n${j.eval_count} tokens in ${(j.eval_duration / 1e9).toFixed(1)}s = ${(j.eval_count / (j.eval_duration / 1e9)).toFixed(1)} tok/s` +
                  `   (round trip ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
  },
  async hosts() {
    syncHosts();
  },
  async delete() {
    const b = needName("delete");
    if (describe(b, "status")) { defaultSh(`gcloud compute instances delete ${b.vm} ${b.G} --quiet`, false, 300000); console.log(`${b.vm} deleted.`); }
  },
};

export function finishCliResult(result, { out = console.log, error = console.error } = {}) {
  if (!result || result.ok !== true) {
    error(result?.message || result?.error || "Devbox operation failed.");
    process.exitCode = 1;
    return false;
  }
  if (result.message) out(result.message);
  return true;
}

/** The CLI, invoked by scripts/devbox.js — the script lives in scripts/, the fleet API lives here. */
export async function runCli() {
  const cmd = process.argv[2];
  if (!cmds[cmd]) {
    console.log(`usage: npm run box <list|create|start|stop|stop-all|status|allow|allowlist|models|use|chat|pull|hosts|delete> [box]\n`);
    console.log(`  create opts: --machine=g2-standard-8 --gpus=1 --model=llama3.1:8b --disk=200 --rounds=5`);
    process.exit(1);
  }
  // snapshot reports auth state rather than consuming it, so gating it here is what froze the
  // dashboard's snapshot at its last authenticated value.
  if (!new Set(["snapshot", "start", "create"]).has(cmd)) requireAuth();
  // An expired session can also surface mid-command (describe throws), long after requireAuth
  // passed on a cached token. Same operator remedy, so same exit code — not a stack trace.
  let result;
  try {
    result = await cmds[cmd]();
  } catch (e) {
    // A fail() is a diagnosed operator problem — one line and exit 1, never a stack trace.
    if (e?.devboxFailure) {
      console.error(e.message);
      process.exit(1);
    }
    if (!/expired or unauthenticated/i.test(e?.message || "")) throw e;
    console.error(`BLOCKED: ${e.message}\nRun:  gcloud auth login`);
    process.exit(2);
  }
  if (new Set(["start", "create"]).has(cmd)) finishCliResult(result);
}
