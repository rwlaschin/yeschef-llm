import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "devbox-compute-test-"));
process.env.DEVBOX_STARTUP_DIR = join(testDir, "startup");
mkdirSync(process.env.DEVBOX_STARTUP_DIR, { recursive: true });
process.env.DEVBOX_HOSTS_FILE = join(testDir, "hosts");
process.env.DEVBOX_DNS_SUFFIX = "dev.example.test";
writeFileSync(process.env.DEVBOX_HOSTS_FILE, "127.0.0.1\tlocalhost\n");

const { startDevbox, readStartupState, clearStartupState, acquireFleetSnapshotLock } = await import("../dashboard/server/utils/devbox.js");

test("Regression: fleet snapshot collectors serialize across processes", () => {
  const lock = join(testDir, "fleet.lock");
  const release = acquireFleetSnapshotLock(lock);
  assert.equal(typeof release, "function");
  assert.equal(acquireFleetSnapshotLock(lock), null);
  release();
  const releaseAgain = acquireFleetSnapshotLock(lock);
  assert.equal(typeof releaseAgain, "function");
  releaseAgain();
});

const noComputeCli = (command) => {
  assert.doesNotMatch(command, /gcloud\s+(?:auth|compute\s+(?:instances|firewall-rules))/);
  if (command.includes("checkip.amazonaws.com")) return "203.0.113.9";
  if (command.includes("api/tags")) return '{"models":[{"name":"llama3.1:8b"}]}';
  if (command.includes("api/ps")) return '{"models":[]}';
  if (command.includes("compute ssh")) return "pulling manifest";
  return "";
};

test("Domain analysis: a stockout rotates to the next region and preserves exact progress messages", async () => {
  clearStartupState("001");
  const createZones = [];
  const compute = {
    async checkAuth() { return { ok: true, account: "service-account" }; },
    async listInstances() { return []; },
    async getInstance({ zone }) {
      return zone === "us-west4-a"
        ? { name: "yc-ollama-001", zone, status: "RUNNING", ip: "34.10.0.1", createdAt: "2026-08-20T18:00:00Z" }
        : null;
    },
    async ensureFirewall() {},
    async createInstance({ zone }) {
      createZones.push(zone);
      if (zone === "us-west1-a") {
        throw Object.assign(new Error("state: STOCKOUT, sub-state: STOCKOUT, resource type: compute"), { code: 409 });
      }
    },
  };

  const result = await startDevbox("001", { compute, exec: noComputeCli, rounds: 1, model: "llama3.1:8b" });

  assert.equal(result.ok, true);
  assert.deepEqual(createZones, ["us-west1-a", "us-west4-a"]);
  assert.equal(readStartupState("001").msg, "llama3.1:8b ready in us-west4-a — box is RUNNING.");
  clearStartupState("001");
});

test("Error guessing: permission denial is terminal and never rotates regions", async () => {
  clearStartupState("002");
  const createZones = [];
  const compute = {
    async checkAuth() { return { ok: true, account: "service-account" }; },
    async listInstances() { return []; },
    async getInstance() { return null; },
    async ensureFirewall() {},
    async createInstance({ zone }) {
      createZones.push(zone);
      throw Object.assign(new Error("Permission denied"), { code: 403 });
    },
  };

  const result = await startDevbox("002", { compute, exec: noComputeCli, rounds: 5 });

  assert.equal(result.ok, false);
  assert.deepEqual(createZones, ["us-west1-a"]);
  assert.equal(readStartupState("002").phase, "failed");
  clearStartupState("002");
});

test("Error guessing: authentication failure is terminal and returns authRequired", async () => {
  clearStartupState("003");
  const createZones = [];
  const compute = {
    async checkAuth() { return { ok: true, account: "service-account" }; },
    async listInstances() { return []; },
    async getInstance() { return null; },
    async ensureFirewall() {},
    async createInstance({ zone }) {
      createZones.push(zone);
      throw Object.assign(new Error("Invalid authentication credentials"), { code: 401 });
    },
  };

  const result = await startDevbox("003", { compute, exec: noComputeCli, rounds: 5 });

  assert.equal(result.authRequired, true);
  assert.deepEqual(createZones, ["us-west1-a"]);
  clearStartupState("003");
});

test("State-machine domain analysis: a fresh preflight phase replaces stale state before auth and firewall awaits", async () => {
  writeFileSync(join(process.env.DEVBOX_STARTUP_DIR, "001.json"), JSON.stringify(
    { operationId: "stale", phase: "pulling", msg: "stale prior run", cancelled: true, timestamp: 1 }
  ));
  const observedPhases = [];
  const compute = {
    async checkAuth() {
      observedPhases.push(readStartupState("001")?.phase);
      return { ok: true, account: "service-account" };
    },
    async listInstances() {
      observedPhases.push(readStartupState("001")?.phase);
      return [];
    },
    async getInstance() { return null; },
    async ensureFirewall() {
      observedPhases.push(readStartupState("001")?.phase);
      throw new Error("preflight firewall unavailable");
    },
  };

  await startDevbox("001", { compute, exec: noComputeCli, rounds: 1 });

  assert.deepEqual(observedPhases, ["preflight", "preflight"]);
  clearStartupState("001");
});

test("Regression: a slow firewall operation finishes before any VM create starts", async () => {
  clearStartupState("001");
  let releaseFirewall;
  let created = false;
  const firewall = new Promise((resolve) => { releaseFirewall = resolve; });
  const compute = {
    async checkAuth() { return { ok: true, account: "service-account" }; },
    async listInstances() { return []; },
    async getInstance({ zone }) {
      return created ? { vm: "yc-ollama-001", name: "001", zone, status: "RUNNING", ip: "34.10.0.1", createdAt: "2026-08-20T18:00:00Z" } : null;
    },
    async ensureFirewall() { await firewall; },
    async createInstance() { created = true; },
  };

  const start = startDevbox("001", { compute, exec: noComputeCli, rounds: 1, model: "llama3.1:8b" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created, false);
  releaseFirewall();
  const result = await start;

  assert.equal(result.ok, true);
  assert.equal(created, true);
  clearStartupState("001");
});

test("Error guessing: an explicit authentication preflight rejection emits a terminal failed startup event", async () => {
  clearStartupState("002");
  const compute = {
    async checkAuth() { return { ok: false, error: "session expired" }; },
  };

  const result = await startDevbox("002", { compute, exec: noComputeCli, rounds: 1 });

  assert.equal(result.authRequired, true);
  const failedState = readStartupState("002");
  assert.equal(failedState?.phase, "failed");
  assert.doesNotMatch(failedState?.msg || "", /gcloud auth login/i);
  assert.match(failedState?.msg || "", /application[- ]default|ADC|gcloud auth application-default login/i);
  clearStartupState("002");
});

test("Error guessing: ambiguous create failure recovers the accepted VM before probing another region", async () => {
  clearStartupState("004");
  const createZones = [];
  let lookupCount = 0;
  const compute = {
    async checkAuth() { return { ok: true, account: "service-account" }; },
    async listInstances() { return []; },
    async getInstance({ zone }) {
      lookupCount += 1;
      if (lookupCount >= 2) return { name: "yc-ollama-004", zone, status: "RUNNING", ip: "34.10.0.4", createdAt: "2026-08-20T18:00:00Z" };
      return null;
    },
    async ensureFirewall() {},
    async createInstance({ zone }) {
      createZones.push(zone);
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    },
  };

  const result = await startDevbox("004", { compute, exec: noComputeCli, rounds: 5, model: "llama3.1:8b" });

  assert.equal(result.zone, "us-west1-a");
  assert.deepEqual(createZones, ["us-west1-a"]);
  clearStartupState("004");
});

test("Contract: startup state retains the existing snapshot schema", async () => {
  clearStartupState("001");
  const compute = {
    async checkAuth() { return { ok: true, account: "service-account" }; },
    async listInstances() { return []; },
    async getInstance() { return null; },
    async ensureFirewall() {},
    async createInstance() { throw Object.assign(new Error("Permission denied"), { code: 403 }); },
  };

  await startDevbox("001", { compute, exec: noComputeCli, rounds: 1 });
  const written = readStartupState("001");

  assert.deepEqual(Object.keys(written).sort(), ["msg", "operationId", "phase", "timestamp"]);
  clearStartupState("001");
});

test("Contract: model pull uses Ollama HTTP and never invokes gcloud compute ssh or authentication", async () => {
  clearStartupState("001");
  const commands = [];
  const compute = {
    async checkAuth() { return { ok: true, account: "service-account" }; },
    async listInstances() { return []; },
    async getInstance({ zone }) { return { vm: "yc-ollama-001", name: "001", zone, status: "RUNNING", ip: "34.10.0.1", createdAt: "2026-08-20T18:00:00Z" }; },
    async ensureFirewall() {},
    async createInstance() {},
  };
  const exec = (command) => {
    commands.push(command);
    if (command.includes("checkip.amazonaws.com")) return "203.0.113.9";
    if (command.includes("/api/tags")) return '{"models":[{"name":"llama3.1:8b"}]}';
    if (command.includes("/api/pull")) return '{}';
    return "";
  };

  const result = await startDevbox("001", { compute, exec, rounds: 1, model: "llama3.1:8b" });

  assert.equal(result.ok, true);
  assert.equal(commands.some((command) => command.includes("/api/pull")), true);
  assert.equal(commands.some((command) => /gcloud\s+(?:auth|compute\s+ssh)/.test(command)), false);
  clearStartupState("001");
});

test("Regression: starting an existing VM adds the current operator IP", async () => {
  clearStartupState("002");
  const firewallCalls = [];
  const compute = {
    async checkAuth() { return { ok: true, account: "service-account" }; },
    async ensureFirewall(options) { firewallCalls.push(options.sourceRanges); },
    async listInstances() {
      return [{ vm: "yc-ollama-002", name: "002", zone: "us-west1-a", status: "RUNNING", ip: "34.10.0.2" }];
    },
  };

  const result = await startDevbox("002", { compute, exec: noComputeCli, model: "llama3.1:8b" });

  assert.equal(result.status, "RUNNING");
  assert.deepEqual(firewallCalls, [["203.0.113.9/32"]]);
  clearStartupState("002");
});

test("Domain analysis: host synchronization refreshes the full fleet after create and preserves another box", async () => {
  clearStartupState("001");
  writeFileSync(process.env.DEVBOX_HOSTS_FILE, "127.0.0.1\tlocalhost\n");
  let created = false;
  const other = { vm: "yc-ollama-002", name: "002", zone: "us-east4-a", status: "RUNNING", ip: "34.10.0.2", createdAt: "2026-08-20T17:00:00Z" };
  const target = { vm: "yc-ollama-001", name: "001", zone: "us-west1-a", status: "RUNNING", ip: "34.10.0.1", createdAt: "2026-08-20T18:00:00Z" };
  const compute = {
    async checkAuth() { return { ok: true, account: "service-account" }; },
    async listInstances() { return created ? [other, target] : [other]; },
    async getInstance() { return created ? target : null; },
    async ensureFirewall() {},
    async createInstance() { created = true; },
  };
  const exec = (command) => {
    if (command.includes("checkip.amazonaws.com")) return "203.0.113.9";
    if (command.includes("/api/tags")) return '{"models":[{"name":"llama3.1:8b"}]}';
    if (command.includes("/api/pull")) return '{}';
    return "";
  };

  const result = await startDevbox("001", { compute, exec, rounds: 1, model: "llama3.1:8b" });
  const hosts = readFileSync(process.env.DEVBOX_HOSTS_FILE, "utf8");

  assert.equal(result.ok, true);
  assert.match(hosts, /^34\.10\.0\.1\s+ollama-001\.dev\.example\.test$/m);
  assert.match(hosts, /^34\.10\.0\.2\s+ollama-002\.dev\.example\.test$/m);
  clearStartupState("001");
});
