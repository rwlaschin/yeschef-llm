import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEVBOX_PATH = join(ROOT, "..", "dashboard", "server", "utils", "devbox.js");
const DASHBOARD_ROOT = join(ROOT, "..", "dashboard");
process.env.DEVBOX_STARTUP_DIR = mkdtempSync(join(tmpdir(), "devbox-startup-test-"));

test("Equivalence Partitioning: dashboard devbox utility resolves in the dashboard package context without losing its Nuxt-compatible imports", () => {
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    "const mod = await import('./server/utils/devbox.js'); process.stdout.write(typeof mod.runCli)",
  ], {
    cwd: DASHBOARD_ROOT,
    encoding: "utf8",
    env: { ...process.env, DEVBOX_STARTUP_DIR: mkdtempSync(join(tmpdir(), "devbox-dashboard-import-test-")) },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "function");
  assert.doesNotMatch(result.stderr, /ERR_PACKAGE_IMPORT_NOT_DEFINED|Package import specifier/);
});

test("Rule 1: File Loading & Dynamic Import — devbox.js can be imported safely as a module without process.exit", async () => {
  const mod = await import(DEVBOX_PATH);
  assert.ok(mod, "module loaded");
  assert.equal(typeof mod.getFleetStatus, "function", "exports getFleetStatus");
  assert.equal(typeof mod.startDevbox, "function", "exports startDevbox");
  assert.equal(typeof mod.stopDevbox, "function", "exports stopDevbox");
  assert.equal(typeof mod.allowCurrentIp, "function", "exports allowCurrentIp");
  assert.equal(typeof mod.warmDevboxModel, "function", "exports warmDevboxModel");
  assert.equal(typeof mod.getLiveRate, "function", "exports getLiveRate");
  assert.equal(typeof mod.buildStartupScript, "function", "exports buildStartupScript");
});

test("Rule 2: Function Execution — getLiveRate calculates spec-based price or reference rate correctly", async () => {
  const { getLiveRate } = await import(DEVBOX_PATH);
  
  // Running standard machine
  const r1 = getLiveRate("g2-standard-8", "us-west1-b", "RUNNING");
  assert.equal(typeof r1.rate, "number");
  assert.equal(r1.rate, 0.85);
  assert.equal(r1.formatted, "$0.85/hr");

  // Stopped machine
  const r2 = getLiveRate("g2-standard-8", "us-west1-b", "STOPPED");
  assert.equal(r2.rate, 0);
  assert.equal(r2.formatted, "$0.00/hr");

  // Starting / Pending machine
  const r3 = getLiveRate("g2-standard-8", "us-west1-b", "CREATING");
  assert.equal(r3.rate, null);
  assert.equal(r3.formatted, "--");
});

test("Rule 2: Function Execution — buildStartupScript injects auto-shutdown watchdog with configured timeout", async () => {
  const { buildStartupScript } = await import(DEVBOX_PATH);

  const script2m = buildStartupScript({ timeoutMinutes: 2, parallel: 4 });
  assert.match(script2m, /OLLAMA_NUM_PARALLEL=4/, "contains parallel setting");
  assert.match(script2m, /TIMEOUT_MINUTES=2/, "contains 2m watchdog timeout");
  assert.match(script2m, /poweroff|shutdown/, "contains self-shutdown command");

  const scriptDefault = buildStartupScript();
  assert.match(scriptDefault, /TIMEOUT_MINUTES=5/, "defaults to 5m watchdog timeout");
});

test("Rule 2: Function Execution — getFleetStatus parses GCE and Ollama responses without throwing ReferenceErrors", async () => {
  const { getFleetStatus } = await import(DEVBOX_PATH);

  // Mock executor that simulates gcloud & curl outputs
  const mockExec = (cmd) => {
    if (cmd.includes("auth list")) return "dev@yeschef.life";
    if (cmd.includes("instances list")) {
      return "yc-ollama-001,us-west1-b,RUNNING,g2-standard-8,34.168.12.94\n";
    }
    if (cmd.includes("firewall-rules describe")) {
      return "73.189.42.10/32";
    }
    if (cmd.includes("api/tags")) {
      return JSON.stringify({ models: [{ name: "llama3.1:8b", size: 4700000000 }] });
    }
    if (cmd.includes("api/ps")) {
      return JSON.stringify({ models: [{ name: "llama3.1:8b" }] });
    }
    if (cmd.includes("checkip.amazonaws.com")) {
      return "73.189.42.10";
    }
    return "";
  };

  const fleet = await getFleetStatus({ exec: mockExec });
  assert.ok(fleet.boxes, "fleet contains boxes array");
  assert.equal(fleet.boxes.length >= 1, true, "has at least one declared box");
  
  const b001 = fleet.boxes.find((b) => b.name === "001");
  assert.ok(b001, "box 001 exists");
  assert.equal(b001.status, "RUNNING");
  assert.equal(b001.ip, "34.168.12.94");
  assert.equal(b001.zone, "us-west1-b");
  assert.equal(b001.rate.formatted, "$0.85/hr");
  assert.equal(typeof b001.todayCost, "number", "todayCost is numeric");
  assert.equal(typeof b001.todayCostFormatted, "string", "todayCostFormatted is formatted string");
  assert.deepEqual(b001.loadedModels, ["llama3.1:8b"]);
  assert.equal(fleet.firewall.clientIp, "73.189.42.10");
  assert.equal(fleet.firewall.isAllowed, true);
});

test("Rule 2: Function Execution — startupTracker tracks live startup progress telemetry", async () => {
  const { startupTracker, getFleetStatus } = await import(DEVBOX_PATH);
  
  startupTracker.set("004", { phase: "hunting", stockouts: 2, msg: "Searching zones (2 stockouts)…" });

  const mockExec = () => "";
  const fleet = await getFleetStatus({ exec: mockExec });
  const b004 = fleet.boxes.find((b) => b.name === "004");
  assert.ok(b004, "box 004 exists");
  assert.ok(b004.startupProgress, "startupProgress telemetry present");
  assert.equal(b004.startupProgress.msg, "Searching zones (2 stockouts)…");

  startupTracker.delete("004");
});

test("Rule 2: Function Execution — allowCurrentIp updates firewall without throwing ReferenceErrors", async () => {
  const { allowCurrentIp } = await import(DEVBOX_PATH);

  const logs = [];
  const mockExec = (cmd) => {
    logs.push(cmd);
    if (cmd.includes("firewall-rules describe")) return "1.2.3.4/32";
    return "";
  };

  const res = await allowCurrentIp("73.189.42.10", { exec: mockExec });
  assert.equal(res.ok, true);
  assert.ok(logs.some((c) => c.includes("firewall-rules update") && c.includes("73.189.42.10/32")), "ran firewall update");
});

test("Rule 2: Function Execution — stopDevbox issues instance delete without throwing ReferenceErrors", async () => {
  const { stopDevbox } = await import(DEVBOX_PATH);

  const logs = [];
  const mockExec = (cmd) => {
    logs.push(cmd);
    if (cmd.includes("instances describe")) return "RUNNING";
    if (cmd.includes("instances list")) return "yc-ollama-001\n";
    if (cmd.includes("firewall-rules describe")) return "73.189.42.10/32";
    return "";
  };

  const res = await stopDevbox("001", { exec: mockExec });
  assert.equal(res.ok, true);
  assert.ok(logs.some((c) => c.includes("instances delete") && c.includes("yc-ollama-001")), "issued instances delete");
});

test("Rule 2: Function Execution — startDevbox accepts rounds: 0 for infinite capacity search and stopDevbox cancels it", async () => {
  const { startDevbox, stopDevbox, startupTracker } = await import(DEVBOX_PATH);

  const logs = [];
  let probeCount = 0;
  const compute = {
    async checkAuth() { return { ok: true, account: "service-account" }; },
    async listInstances() {
      return probeCount >= 3
        ? [{ vm: "yc-ollama-004", name: "004", zone: "us-west1-c", status: "RUNNING", machine: "g2-standard-8", ip: "34.168.12.94", createdAt: "2026-08-17T00:00:00Z" }]
        : [];
    },
    async getInstance({ zone }) {
      return probeCount >= 3
        ? { vm: "yc-ollama-004", name: "004", zone, status: "RUNNING", machine: "g2-standard-8", ip: "34.168.12.94", createdAt: "2026-08-17T00:00:00Z" }
        : null;
    },
    async ensureFirewall() {},
    async createInstance() {
      probeCount++;
      if (probeCount < 3) throw new Error("ZONE_RESOURCE_POOL_EXHAUSTED");
    },
  };
  const mockExec = (cmd) => {
    logs.push(cmd);
    if (cmd.includes("sleep")) return "";
    if (cmd.includes("checkip.amazonaws.com")) return "73.189.42.10";
    if (cmd.includes("firewall-rules describe")) return "73.189.42.10/32";
    if (cmd.includes("instances describe")) {
      if (cmd.includes("status")) return probeCount >= 3 ? "RUNNING" : "";
      if (cmd.includes("networkInterfaces")) return "34.168.12.94";
      return "";
    }
    if (cmd.includes("instances list")) {
      return probeCount >= 3 ? "yc-ollama-004,us-west1-c,RUNNING,g2-standard-8,34.168.12.94,2026-08-17T00:00:00Z" : "";
    }
    if (cmd.includes("ssh")) return "pulling manifest";
    if (cmd.includes("curl") && cmd.includes("tags")) return JSON.stringify({ models: [{ name: "llama3.1:8b" }] });
    if (cmd.includes("curl")) return JSON.stringify({ models: [] });
    return "";
  };

  const startRes = await startDevbox("004", { compute, exec: mockExec, rounds: 0, model: "llama3.1:8b" });
  assert.equal(startRes.ok, true);
  assert.equal(startRes.status, "RUNNING");
  assert.equal(probeCount >= 3, true, "probed capacity until created");

  const stopRes = await stopDevbox("004", { exec: mockExec });
  assert.equal(stopRes.ok, true);
  assert.equal(startupTracker.has("004"), false, "startupTracker entry cleaned up on stop");
});

test("Rule 2: Function Execution — stopDevbox cancels an ongoing mid-flight infinite capacity search", async () => {
  const { startDevbox, stopDevbox, startupTracker } = await import(DEVBOX_PATH);

  let probeCount = 0;
  const compute = {
    async checkAuth() { return { ok: true, account: "service-account" }; },
    async listInstances() { return []; },
    async getInstance() { return null; },
    async ensureFirewall() {},
    async createInstance() {
      probeCount++;
      if (probeCount === 5) void stopDevbox("003", { exec: mockExec });
      throw new Error("ZONE_RESOURCE_POOL_EXHAUSTED");
    },
  };
  const mockExec = (cmd) => {
    if (cmd.includes("sleep")) return "";
    if (cmd.includes("checkip.amazonaws.com")) return "73.189.42.10";
    if (cmd.includes("firewall-rules describe")) return "73.189.42.10/32";
    return "";
  };

  const startRes = await startDevbox("003", { compute, exec: mockExec, rounds: 0 });
  assert.equal(startRes.ok, true);
  assert.equal(startRes.zone, "", "returns empty zone because capacity search was cancelled");
  assert.equal(probeCount, 5, "cancelled infinite search loop after 5 probes");
  assert.equal(startupTracker.has("003"), false, "tracker cleaned up after cancellation");
});

test("Rule 2: Function Execution — getFleetStatus gives live GCP state absolute precedence over in-memory tracker", async () => {
  const { getFleetStatus, startupTracker } = await import(DEVBOX_PATH);

  // Set a lingering in-memory tracker
  startupTracker.set("001", { phase: "hunting", zone: "us-central1-a", msg: "stale tracking" });

  const mockExec = (cmd) => {
    if (cmd.includes("print-access-token")) return "ya29.fake-token";
    if (cmd.includes("auth list")) return "dev@yeschef.life";
    if (cmd.includes("firewall-rules describe")) return "73.189.42.10/32";
    if (cmd.includes("instances list")) {
      // GCP reports 001 is actually RUNNING in us-central1-a
      return "yc-ollama-001,us-central1-a,RUNNING,g2-standard-8,34.168.12.94";
    }
    if (cmd.includes("curl") && cmd.includes("tags")) return JSON.stringify({ models: [{ name: "llama3.1:8b" }] });
    if (cmd.includes("curl") && cmd.includes("ps")) return JSON.stringify({ models: [] });
    return "";
  };

  const statusRes = await getFleetStatus({ exec: mockExec });
  assert.equal(statusRes.ok, true);
  const box001 = statusRes.boxes.find((b) => b.name === "001");
  
  assert.equal(box001.status, "RUNNING", "Status must be RUNNING because GCP is authoritative, NOT STARTING");
  assert.equal(startupTracker.has("001"), false, "Lingering tracker entry was automatically purged when VM was confirmed live");
});
