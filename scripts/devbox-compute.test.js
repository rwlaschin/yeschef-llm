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

// The walk order is not L4_ZONES' declared order: stockouts are regional, so consecutive probes
// must land in DIFFERENT regions. This is the interleaved order findCapacity builds from L4_ZONES.
const WALK = [
  "us-west1-a", "us-west4-a", "us-central1-a", "us-east4-a", "us-east1-b",
  "us-west1-b", "us-west4-c", "us-central1-b", "us-east4-c", "us-east1-c",
  "us-west1-c", "us-central1-c", "us-east1-d",
];

// A fake compute that stockouts every zone except those in `accept`, recording each zone probed in
// `probed` — the argument list the suite asserts on, in place of the retired gcloud argv log.
const walkAdapter = ({ accept = [], hint = "", ip = "34.10.0.1", existing = null } = {}) => {
  const probed = [];
  let live = existing;
  return {
    probed,
    deleted: [],
    created: [],
    async checkAuth() { return { ok: true, account: "service-account" }; },
    async listInstances() { return live ? [live] : []; },
    async getInstance({ zone }) { return live && live.zone === zone ? live : null; },
    async ensureFirewall() {},
    async deleteInstance({ zone }) { this.deleted.push(zone); live = null; },
    async createInstance({ zone, instanceResource }) {
      probed.push(zone);
      this.created.push(instanceResource);
      if (accept.includes(zone)) {
        live = { vm: "yc-ollama-001", name: "001", zone, status: "RUNNING", ip, createdAt: "2026-08-20T18:00:00Z" };
        return;
      }
      throw Object.assign(
        new Error(`state: STOCKOUT, sub-state: STOCKOUT, resource type: compute${hint ? `, zonesAvailable: ${hint}` : ""}`),
        { code: 409 },
      );
    },
  };
};

const captureStdout = async (run) => {
  const lines = [];
  const original = console.log;
  console.log = (...parts) => { lines.push(parts.join(" ")); };
  try { return { result: await run(), out: `${lines.join("\n")}\n` }; }
  finally { console.log = original; }
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

// ── the capacity walk itself ──────────────────────────────────────────────────────────────────
// Ported from scripts/devbox.test.js, which asserted on a fake gcloud's argv log and could no
// longer reach a zone at all after the SDK migration.
test("Boundary: one round probes all 13 L4 zones, one zone per region, in the interleaved order", async () => {
  clearStartupState("001");
  const compute = walkAdapter();
  await startDevbox("001", { compute, exec: noComputeCli, rounds: 1 });
  assert.deepEqual(compute.probed, WALK);
  clearStartupState("001");
});

test("Regression: the walk never probes us-central1-f, which carries no L4 hardware at all", async () => {
  clearStartupState("001");
  const compute = walkAdapter();
  await startDevbox("001", { compute, exec: noComputeCli, rounds: 1 });
  // A create must actually have been ATTEMPTED: an empty probe list would satisfy the exclusion
  // trivially, which is exactly how the retired gcloud version of this test passed by accident.
  assert.equal(compute.probed.length, 13);
  assert.equal(compute.probed.includes("us-central1-f"), false);
  clearStartupState("001");
});

test("Boundary: the first zone that accepts ends the walk and no later zone is probed", async () => {
  clearStartupState("001");
  const compute = walkAdapter({ accept: ["us-east1-b"] });
  const result = await startDevbox("001", { compute, exec: noComputeCli, rounds: 1, model: "llama3.1:8b" });
  assert.equal(result.ok, true);
  assert.equal(result.zone, "us-east1-b");
  assert.deepEqual(compute.probed, WALK.slice(0, 5));
  clearStartupState("001");
});

test("Boundary: capacity in the very first zone probes exactly that one zone", async () => {
  clearStartupState("001");
  const compute = walkAdapter({ accept: ["us-west1-a"] });
  await startDevbox("001", { compute, exec: noComputeCli, rounds: 1, model: "llama3.1:8b" });
  assert.deepEqual(compute.probed, ["us-west1-a"]);
  clearStartupState("001");
});

test("Boundary: capacity only in the last zone still walks the 12 ahead of it first", async () => {
  clearStartupState("001");
  const compute = walkAdapter({ accept: ["us-east1-d"] });
  await startDevbox("001", { compute, exec: noComputeCli, rounds: 1, model: "llama3.1:8b" });
  assert.deepEqual(compute.probed, WALK);
  clearStartupState("001");
});

test("Boundary: --rounds=2 cycles the whole zone list a second time — 26 probes", async () => {
  clearStartupState("001");
  const compute = walkAdapter();
  await startDevbox("001", { compute, exec: noComputeCli, rounds: 2 });
  assert.equal(compute.probed.length, 26);
  assert.deepEqual(compute.probed.slice(13), WALK);
  clearStartupState("001");
});

test("Boundary: with no rounds given the default is 5 rounds — 65 probes before giving up", async () => {
  clearStartupState("001");
  const compute = walkAdapter();
  await startDevbox("001", { compute, exec: noComputeCli });
  assert.equal(compute.probed.length, 65);
  clearStartupState("001");
});

test("Boundary: a non-numeric rounds value creates nothing rather than looping on a NaN bound", async () => {
  clearStartupState("001");
  const compute = walkAdapter({ accept: WALK });
  const result = await startDevbox("001", { compute, exec: noComputeCli, rounds: "abc" });
  assert.equal(result.ok, false);
  assert.equal(compute.probed.length, 0);
  clearStartupState("001");
});

test("Domain analysis: exhausting every zone leaves the box stopped and says no capacity was found", async () => {
  clearStartupState("001");
  const compute = walkAdapter();
  const result = await startDevbox("001", { compute, exec: noComputeCli, rounds: 1 });
  assert.equal(result.status, "STOPPED");
  assert.equal(result.zone, "");
  const state = readStartupState("001");
  assert.equal(state.phase, "failed");
  assert.match(state.msg, /No L4 capacity available — search exhausted every US zone\./);
  clearStartupState("001");
});

test("Contract: every probe is logged by zone as either stockout or CREATED", async () => {
  clearStartupState("001");
  const compute = walkAdapter({ accept: ["us-west4-a"] });
  const { out } = await captureStdout(() =>
    startDevbox("001", { compute, exec: noComputeCli, rounds: 1, model: "llama3.1:8b" }));
  assert.match(out, /^ {2}us-west1-a: stockout$/m);
  assert.match(out, /^ {2}us-west4-a: CREATED$/m);
  assert.equal(/us-west4-a: stockout/.test(out), false);
  clearStartupState("001");
});

test("Regression: a zonesAvailable hint in the stockout body does not reorder the next probe", async () => {
  clearStartupState("001");
  const compute = walkAdapter({ accept: ["us-central1-a"], hint: "us-east1-d" });
  await startDevbox("001", { compute, exec: noComputeCli, rounds: 1, model: "llama3.1:8b" });
  assert.deepEqual(compute.probed, ["us-west1-a", "us-west4-a", "us-central1-a"]);
  clearStartupState("001");
});

test("Contract: create reports the ephemeral IP read off the live instance", async () => {
  clearStartupState("001");
  const compute = walkAdapter({ accept: ["us-west1-a"], ip: "34.10.0.7" });
  const { out } = await captureStdout(() =>
    startDevbox("001", { compute, exec: noComputeCli, rounds: 1, model: "llama3.1:8b" }));
  assert.match(out, /^Created and RUNNING in us-west1-a at 34\.10\.0\.7\./m);
  clearStartupState("001");
});

// ── the VM state matrix ───────────────────────────────────────────────────────────────────────
test("Domain analysis: a TERMINATED box is deleted and rebuilt, never adopted in a half-state", async () => {
  clearStartupState("001");
  const compute = walkAdapter({
    accept: ["us-west1-a"],
    existing: { vm: "yc-ollama-001", name: "001", zone: "us-east4-c", status: "TERMINATED", ip: "" },
  });
  const result = await startDevbox("001", { compute, exec: noComputeCli, rounds: 1, model: "llama3.1:8b" });
  assert.deepEqual(compute.deleted, ["us-east4-c"]);
  assert.deepEqual(compute.probed, ["us-west1-a"]);
  assert.equal(result.ok, true);
  clearStartupState("001");
});

test("Error guessing: a box stuck in STOPPING is refused instead of raced, and no VM is created", async () => {
  clearStartupState("001");
  const compute = walkAdapter({
    accept: WALK,
    existing: { vm: "yc-ollama-001", name: "001", zone: "us-east4-c", status: "STOPPING", ip: "" },
  });
  const result = await startDevbox("001", { compute, exec: noComputeCli, rounds: 1 });
  assert.equal(result.ok, false);
  assert.equal(compute.probed.length, 0);
  assert.deepEqual(compute.deleted, []);
  clearStartupState("001");
});

test("Regression: create replaces this box's own stale hosts line rather than appending a duplicate", async () => {
  clearStartupState("001");
  writeFileSync(process.env.DEVBOX_HOSTS_FILE, "127.0.0.1\tlocalhost\n34.10.0.5\tollama-001.dev.example.test\n");
  const compute = walkAdapter({ accept: ["us-west1-a"], ip: "35.99.0.4" });
  await startDevbox("001", { compute, exec: noComputeCli, rounds: 1, model: "llama3.1:8b" });
  const hosts = readFileSync(process.env.DEVBOX_HOSTS_FILE, "utf8");
  assert.equal(hosts, "127.0.0.1\tlocalhost\n35.99.0.4\tollama-001.dev.example.test\n");
  clearStartupState("001");
});

// ── the wait-for-boot path: a box that never answers must still be given its model ────────────
// `probe` is the only curl carrying `-o /dev/null`, so failing exactly that command fails the wait
// while leaving the pull and the /api/tags verification working — which is the real 2026-08-14 shape.
const deadProbe = (sources = "203.0.113.9/32") => (command) => {
  if (command.includes("checkip.amazonaws.com")) return "203.0.113.9";
  if (command.includes("firewall-rules describe")) return sources || "ERROR: rule not found";
  if (command.includes("-o /dev/null")) return "ERROR probe refused";
  if (command.includes("/api/tags")) return '{"models":[{"name":"llama3.1:8b"}]}';
  if (command.includes("/api/pull")) return "{}";
  return "";
};

test("Regression: a created box that never answers still prints the first-boot explanation", async () => {
  clearStartupState("001");
  const compute = walkAdapter({ accept: ["us-west1-a"] });
  const { out } = await captureStdout(() =>
    startDevbox("001", { compute, exec: deadProbe(), rounds: 1, model: "llama3.1:8b" }));
  assert.match(out, /^Not answering yet\. First boot installs Ollama and takes a few minutes; try 'status' again\.$/m);
  clearStartupState("001");
});

test("Regression: a created box that never answers is STILL sent its model pull, and the start exits ok", async () => {
  clearStartupState("001");
  const commands = [];
  const exec = deadProbe();
  const compute = walkAdapter({ accept: ["us-west1-a"] });
  const result = await startDevbox("001", {
    compute,
    exec: (command, ...rest) => { commands.push(command); return exec(command, ...rest); },
    rounds: 1,
    model: "llama3.1:8b",
  });
  assert.equal(result.ok, true);
  assert.equal(commands.some((command) => command.includes("/api/pull") && command.includes("llama3.1:8b")), true);
  clearStartupState("001");
});

test("Error guessing: a failed wait names the allow verb when your IP is NOT on the allowlist", async () => {
  clearStartupState("001");
  const compute = walkAdapter({ accept: ["us-west1-a"] });
  const { out } = await captureStdout(() =>
    startDevbox("001", { compute, exec: deadProbe("198.51.100.7/32"), rounds: 1, model: "llama3.1:8b" }));
  assert.match(out, /^ {2}Your IP 203\.0\.113\.9 is NOT on the allowlist \(198\.51\.100\.7\/32\) — the box is fine, your packets are dropped\.$/m);
  assert.match(out, /^ {2}Fix: {2}npm run box allow$/m);
  clearStartupState("001");
});

test("Error guessing: a failed wait does NOT blame the firewall when your IP is already allowed", async () => {
  clearStartupState("001");
  const compute = walkAdapter({ accept: ["us-west1-a"] });
  const { out } = await captureStdout(() =>
    startDevbox("001", { compute, exec: deadProbe("203.0.113.9/32"), rounds: 1, model: "llama3.1:8b" }));
  assert.match(out, /^ {2}Your IP 203\.0\.113\.9 IS on the allowlist \(203\.0\.113\.9\/32\) — this is not the firewall\.$/m);
  assert.equal(/^ {2}Fix: {2}npm run box allow$/m.test(out), false);
  clearStartupState("001");
});

test("Error guessing: a failed wait reports a missing firewall rule as the reason nothing answered", async () => {
  clearStartupState("001");
  const compute = walkAdapter({ accept: ["us-west1-a"] });
  const { out } = await captureStdout(() =>
    startDevbox("001", { compute, exec: deadProbe(""), rounds: 1, model: "llama3.1:8b" }));
  assert.match(out, /^ {2}There is no yc-ollama-allow rule at all — nothing can reach tcp:11434\.$/m);
  clearStartupState("001");
});

test("Contract: a failed model pull never reports a usable box", async () => {
  clearStartupState("001");
  const compute = walkAdapter({ accept: ["us-west1-a"] });
  const exec = (command) => {
    if (command.includes("checkip.amazonaws.com")) return "203.0.113.9";
    if (command.includes("/api/pull")) return "ERROR pull refused";
    if (command.includes("/api/tags")) return '{"models":[{"name":"llama3.1:8b"}]}';
    return "";
  };
  const result = await startDevbox("001", { compute, exec, rounds: 1, model: "llama3.1:8b" });
  assert.equal(result.ok, false);
  clearStartupState("001");
});

// ── what gets built, and with which model ────────────────────────────────────────────────────
test("Contract: with no model given the box pulls the fleet default for 001", async () => {
  clearStartupState("001");
  const commands = [];
  const compute = walkAdapter({ accept: ["us-west1-a"] });
  const exec = (command) => {
    commands.push(command);
    if (command.includes("checkip.amazonaws.com")) return "203.0.113.9";
    if (command.includes("/api/tags")) return '{"models":[{"name":"llama3.1:8b"}]}';
    return "";
  };
  const result = await startDevbox("001", { compute, exec, rounds: 1 });
  assert.equal(result.model, "llama3.1:8b");
  assert.equal(commands.some((command) => command.includes("/api/pull") && command.includes("llama3.1:8b")), true);
  clearStartupState("001");
});

test("Contract: an explicit model option chooses which model the new box pulls", async () => {
  clearStartupState("001");
  const commands = [];
  const compute = walkAdapter({ accept: ["us-west1-a"] });
  const exec = (command) => {
    commands.push(command);
    if (command.includes("checkip.amazonaws.com")) return "203.0.113.9";
    if (command.includes("/api/tags")) return '{"models":[{"name":"qwen2.5:14b"}]}';
    return "";
  };
  const result = await startDevbox("001", { compute, exec, rounds: 1, model: "qwen2.5:14b" });
  assert.equal(result.model, "qwen2.5:14b");
  assert.equal(commands.some((command) => command.includes("/api/pull") && command.includes("qwen2.5:14b")), true);
  clearStartupState("001");
});

test("Contract: machine and disk options reach the instance resource, and every VM asks for an nvidia-l4", async () => {
  clearStartupState("001");
  const compute = walkAdapter({ accept: ["us-west1-a"] });
  await startDevbox("001", {
    compute, exec: noComputeCli, rounds: 1, model: "llama3.1:8b", machine: "g2-standard-24", disk: "500",
  });
  assert.equal(compute.created.length, 1);
  const [resource] = compute.created;
  assert.equal(resource.machineType, "zones/us-west1-a/machineTypes/g2-standard-24");
  assert.equal(resource.disks[0].initializeParams.diskSizeGb, "500");
  assert.equal(resource.guestAccelerators[0].acceleratorType, "zones/us-west1-a/acceleratorTypes/nvidia-l4");
  assert.deepEqual(resource.labels, { owner: "dev", purpose: "ollama-devbox" });
  clearStartupState("001");
});
