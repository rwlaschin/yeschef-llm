#!/usr/bin/env node
// The pm2-facing half of a devbox: a long-lived process whose LIFETIME IS THE VM'S POWER STATE.
//
//   pm2 start ecosystem.devbox.cjs --only ollama-a   → boots the VM, waits for Ollama, then supervises
//   pm2 stop ollama-a                                → STOPS THE VM, then exits
//   pm2 list / pm2 logs ollama-a                     → the box shows up beside web/dash/ai like anything else
//
// pm2 supervises processes, not cloud VMs, so this process IS the handle: it holds the box up while
// it runs and powers it down on the way out. That is why it polls instead of exiting immediately —
// an agent that returned would leave pm2 with nothing to stop and the VM running (and billing).
//
// autorestart MUST be false for these (see ecosystem.devbox.cjs). A crash-loop here would be a
// restart loop on a GPU VM.
import { execSync, spawnSync } from "node:child_process";

const NAME = process.argv[2];
if (!NAME) { console.error("usage: devbox-agent.mjs <box>"); process.exit(1); }

// This process's stdout is a pipe into logship (see ecosystem.devbox.config.cjs). If that collector
// dies first, an unhandled EPIPE here would kill the agent BEFORE its SIGINT handler powers the VM
// down — losing the logs must never cost a running GPU.
for (const s of [process.stdout, process.stderr]) s.on("error", () => {});

// A GPU VM MUST NEVER BOOT AS A SIDE EFFECT — but that guard lives in ecosystem.devbox.config.cjs,
// which withholds these apps from a bare `pm2 start <file>`. It is NOT an env-var gate here: naming
// a box (`pm2 start ollama-a`) is already deliberate, and gating on DEVBOX_START made plain pm2
// commands silently no-op, which is the opposite of managing these boxes through pm2.
const POLL_MS = Number(process.env.DEVBOX_POLL_MS || 30_000);
const HERE = new URL("./devbox.js", import.meta.url).pathname;

const devbox = (...args) => {
  const r = spawnSync("node", [HERE, ...args], { encoding: "utf8" });
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
  if (out) console.log(out);
  return { code: r.status, out };
};
const urlOf = () => (devbox("status", NAME).out.match(/^URL:\s+(\S+)$/m) || [])[1] || "";
const answering = (url) => {
  try { execSync(`curl -sf -m 5 ${url}/api/tags > /dev/null`, { stdio: "pipe" }); return true; }
  catch { return false; }
};

let stopping = false;
// SIGINT is what `pm2 stop` sends. Powering the VM down here is the whole point: stopping the
// process without stopping the box would leave a GPU running with nothing watching it.
const shutdown = (sig) => {
  if (stopping) return;
  stopping = true;
  console.log(`[devbox:${NAME}] ${sig} — powering the box down.`);
  devbox("stop", NAME);
  process.exit(0);
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => shutdown(sig));

console.log(`[devbox:${NAME}] starting…`);
const { code } = devbox("start", NAME);
if (code !== 0) { console.error(`[devbox:${NAME}] start failed — not supervising a box that isn't up.`); process.exit(1); }

const url = urlOf();
console.log(`[devbox:${NAME}] up at ${url} — polling every ${POLL_MS / 1000}s. 'pm2 stop ${NAME}' powers it off.`);
let wasUp = true;
setInterval(() => {
  if (stopping) return;
  const up = answering(url);
  // Log only on CHANGE. A line every 30s would bury the transitions that actually matter in the
  // shared logd ring.
  if (up !== wasUp) console.log(`[devbox:${NAME}] ${up ? "answering again" : "NOT answering"} at ${url}`);
  wasUp = up;
}, POLL_MS);
