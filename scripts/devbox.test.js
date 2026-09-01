import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// devbox.js is a CLI: it runs `await cmds[cmd]()` at module load, so it cannot be imported. It is
// exercised the way an operator does — as a subprocess — with FAKE `gcloud`, `curl` and `sleep`
// first on PATH. Nothing here reaches the network, GCE, sudo, or the real /etc/hosts: HOSTS is
// redirected via DEVBOX_HOSTS_FILE, which the script supports for exactly this reason.
//
// Every gcloud argv the script issues is appended to gcloud.log, so the tests assert on WHAT THE
// SCRIPT DID (which zones it tried, in what order, whether it reserved an address, whether it
// stopped or deleted), not on what it printed about itself.
const DEVBOX = join(dirname(fileURLToPath(import.meta.url)), "devbox.js");

const FAKE_GCLOUD = `#!/bin/sh
printf '%s\\n' "$*" >> "$DEVBOX_FAKE_LOG"
zone=\`echo "$*" | sed -n 's/.*--zone=\\([a-z0-9-]*\\).*/\\1/p'\`
case "$*" in
  *"auth list"*) printf '%s' "$DEVBOX_FAKE_AUTH"; exit 0;;
  *"print-access-token"*) printf '%s' "$DEVBOX_FAKE_AUTH"; exit 0;;

  *"instances create"*)
    case ",$DEVBOX_FAKE_CAPACITY," in *",$zone,"*)
      echo "$zone" > "$DEVBOX_FAKE_STATE"; echo "Created instance."; exit 0;;
    esac
    case ",$DEVBOX_FAKE_NO_L4," in *",$zone,"*)
      echo "ERROR: (gcloud.compute.instances.create) Invalid value for field 'resource.guestAccelerators': type nvidia-l4 is not available in $zone" >&2
      exit 1;;
    esac
    echo "ERROR: (gcloud.compute.instances.create) Could not fetch resource: ZONE_RESOURCE_POOL_EXHAUSTED - the zone $zone does not have enough resources. zonesAvailable: $DEVBOX_FAKE_HINT" >&2
    exit 1;;

  *"compute ssh"*)
    if [ -n "$DEVBOX_FAKE_SSH_FAIL" ]; then echo "ERROR: (gcloud.compute.ssh) [/usr/bin/ssh] exited with return code [255]." >&2; exit 1; fi
    echo "pulling manifest"; exit 0;;

  *"instances delete"*) rm -f "$DEVBOX_FAKE_STATE"; echo "Deleted."; exit 0;;
  *"instances stop"*) echo "Stopped."; exit 0;;

  *"labels.purpose=ollama-devbox"*)
    if [ -f "$DEVBOX_FAKE_STATE" ]; then
      echo "yc-ollama-001,\`cat "$DEVBOX_FAKE_STATE"\`,RUNNING,$DEVBOX_FAKE_MACHINE,$DEVBOX_FAKE_IP"
    else
      printf '%s' "$DEVBOX_FAKE_LIST"
    fi
    exit 0;;

  *"instances list"*)
    if [ -f "$DEVBOX_FAKE_STATE" ]; then cat "$DEVBOX_FAKE_STATE"; else echo "$DEVBOX_FAKE_ZONE"; fi
    exit 0;;

  *"instances describe"*)
    if [ -f "$DEVBOX_FAKE_STATE" ]; then state=RUNNING; else state="$DEVBOX_FAKE_STATUS"; fi
    if [ -z "$state" ]; then echo "ERROR: The resource was not found."; exit 0; fi
    case "$*" in
      *natIP*) echo "$DEVBOX_FAKE_IP";;
      *machineType*) echo "$DEVBOX_FAKE_MACHINE";;
      *status*) echo "$state";;
      *) echo "yc-ollama-001";;
    esac
    exit 0;;

  *"firewall-rules describe"*)
    if [ -z "$DEVBOX_FAKE_SOURCES" ]; then echo "ERROR: rule not found"; else echo "$DEVBOX_FAKE_SOURCES"; fi
    exit 0;;
  *) echo "ok"; exit 0;;
esac
`;

const FAKE_CURL = `#!/bin/sh
case "$*" in
  *checkip*) echo "$DEVBOX_FAKE_MY_IP"; exit 0;;
esac
if [ "$DEVBOX_FAKE_OLLAMA" = "down" ]; then exit 7; fi
case "$*" in
  *api/tags*) printf '%s' "$DEVBOX_FAKE_TAGS";;
  *api/ps*) if [ "$DEVBOX_FAKE_PS" = "down" ]; then exit 7; fi; printf '%s' "$DEVBOX_FAKE_PS";;
  *api/pull*) printf '%s' "$DEVBOX_FAKE_PULL";;
  *api/generate*) if [ "$DEVBOX_FAKE_GENERATE" = "down" ]; then exit 7; fi; printf '%s' "$DEVBOX_FAKE_GENERATE";;
  *) echo '{}';;
esac
exit 0
`;

// Sleep is stubbed to nothing so the find loop's 8s pause between zone attempts does not make a
// 65-attempt walk take nine minutes.
const FAKE_SLEEP = `#!/bin/sh\nexit 0\n`;

let n = 0;
function sandbox(hostsContent = "127.0.0.1\tlocalhost\n") {
  const dir = mkdtempSync(join(tmpdir(), `devbox-test-${n++}-`));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, body] of [["gcloud", FAKE_GCLOUD], ["curl", FAKE_CURL], ["sleep", FAKE_SLEEP]]) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const hosts = join(dir, "hosts");
  writeFileSync(hosts, hostsContent);
  return { dir, bin, hosts, log: join(dir, "gcloud.log"), state: join(dir, "vm.state") };
}

// Runs devbox.js in the sandbox. `scenario` becomes DEVBOX_FAKE_* env for the fake gcloud.
function devbox(sb, argv, scenario = {}) {
  const env = {
    PATH: `${sb.bin}:/usr/bin:/bin`,
    HOME: sb.dir,
    NODE_ENV: "test",
    DEVBOX_HOSTS_FILE: sb.hosts,
    DEVBOX_DNS_SUFFIX: "dev.example.test",
    CLOUDFLARE_API_TOKEN: scenario.cfToken ?? "",
    GCP_PROJECT_ID: "test-project",
    GCP_ZONE: "us-central1-a",
    DEVBOX_FAKE_LOG: sb.log,
    DEVBOX_FAKE_STATE: sb.state,
    DEVBOX_FAKE_CAPACITY: scenario.capacity ?? "",
    DEVBOX_FAKE_NO_L4: scenario.noL4 ?? "",
    DEVBOX_FAKE_HINT: scenario.hint ?? "us-west4-c",
    DEVBOX_FAKE_STATUS: scenario.status ?? "",
    DEVBOX_FAKE_IP: scenario.ip ?? "34.10.0.1",
    DEVBOX_FAKE_ZONE: scenario.zone ?? "",
    DEVBOX_FAKE_LIST: scenario.list ?? "",
    DEVBOX_FAKE_SOURCES: scenario.sources ?? "",
    DEVBOX_FAKE_AUTH: scenario.auth ?? "dev@example.com",
    DEVBOX_FAKE_MY_IP: scenario.myIp ?? "203.0.113.9",
    DEVBOX_FAKE_OLLAMA: scenario.ollama ?? "up",
    DEVBOX_FAKE_TAGS: scenario.tags ?? `{"models":[{"name":"llama3.1:8b","size":4700000000}]}`,
    DEVBOX_FAKE_PS: scenario.ps ?? `{"models":[]}`,
    DEVBOX_FAKE_PULL: scenario.pull ?? `{}`,
    DEVBOX_FAKE_MACHINE: scenario.machine ?? "g2-standard-8",
    DEVBOX_FAKE_GENERATE: scenario.generate ?? `{"response":"Hello there.","eval_count":10,"eval_duration":2000000000}`,
    DEVBOX_FAKE_SSH_FAIL: scenario.sshFail ?? "",
  };
  // `omit` drops a variable entirely, so the script's own default for it is what runs.
  for (const k of scenario.omit ?? []) delete env[k];
  const r = spawnSync(process.execPath, [DEVBOX, ...argv], {
    cwd: sb.dir,                       // away from the repo so dotenv-flow finds no real .env
    encoding: "utf8",
    env,
  });
  const calls = existsSync(sb.log) ? readFileSync(sb.log, "utf8").split("\n").filter(Boolean) : [];
  return { code: r.status, out: r.stdout, err: r.stderr, calls, hosts: readFileSync(sb.hosts, "utf8") };
}

const createdIn = (calls) =>
  calls.filter((c) => c.includes("instances create")).map((c) => c.match(/--zone=([a-z0-9-]+)/)[1]);

// ── rounds: boundary value analysis on --rounds ───────────────────────────────────────────────
test("--rounds=0 issues no create attempt at all", () => {
  const sb = sandbox();
  const r = devbox(sb, ["create", "001", "--rounds=0"], { capacity: "" });
  assert.deepEqual(createdIn(r.calls), []);
});

test("--rounds=abc creates nothing rather than looping on a NaN bound", () => {
  const sb = sandbox();
  const r = devbox(sb, ["create", "001", "--rounds=abc"], { capacity: "us-central1-a" });
  assert.deepEqual(createdIn(r.calls), []);
});

test("--rounds=abc exits non-zero", () => {
  const sb = sandbox();
  const r = devbox(sb, ["create", "001", "--rounds=abc"], { capacity: "us-central1-a" });
  assert.equal(r.code, 1);
});

test("--rounds=-1 creates nothing", () => {
  const sb = sandbox();
  const r = devbox(sb, ["create", "001", "--rounds=-1"], { capacity: "us-central1-a" });
  assert.deepEqual(createdIn(r.calls), []);
});

test("exhausting every zone exits non-zero", () => {
  const sb = sandbox();
  const r = devbox(sb, ["create", "001", "--rounds=1"], { capacity: "" });
  assert.equal(r.code, 1);
});

// ── failure classification ───────────────────────────────────────────────────────────────────
test("a non-stockout refusal is never mislabelled 'stockout' for that zone", () => {
  const sb = sandbox();
  const r = devbox(sb, ["create", "001", "--rounds=1"], { capacity: "", noL4: "us-central1-b" });
  assert.equal(/us-central1-b: stockout/.test(r.out), false);
});

// ── nothing is reserved: no static IP addresses, ever ────────────────────────────────────────
test("a successful create never reserves a static address", () => {
  const sb = sandbox();
  const r = devbox(sb, ["create", "001"], { capacity: "us-central1-a" });
  assert.deepEqual(r.calls.filter((c) => c.includes("addresses")), []);
});

test("an exhausted create never reserves a static address", () => {
  const sb = sandbox();
  const r = devbox(sb, ["create", "001", "--rounds=1"], { capacity: "" });
  assert.deepEqual(r.calls.filter((c) => c.includes("addresses")), []);
});

test("delete never touches addresses", () => {
  const sb = sandbox();
  const r = devbox(sb, ["delete", "001"], { status: "RUNNING", zone: "us-central1-a", sources: "1.2.3.4/32" });
  assert.deepEqual(r.calls.filter((c) => c.includes("addresses")), []);
});

test("status reports the URL built from the instance's ephemeral IP", () => {
  const sb = sandbox();
  const r = devbox(sb, ["status", "001"], { status: "RUNNING", zone: "us-west1-b", ip: "35.20.0.9" });
  assert.match(r.out, /^URL: {5}http:\/\/35\.20\.0\.9:11434$/m);
});

// ── delete: the dnsDelete crash ──────────────────────────────────────────────────────────────
test("delete of a running box exits zero", () => {
  const sb = sandbox();
  const r = devbox(sb, ["delete", "001"], { status: "RUNNING", zone: "us-central1-a" });
  assert.equal(r.code, 0);
});

test("delete does not throw a ReferenceError about an undefined helper", () => {
  const sb = sandbox();
  const r = devbox(sb, ["delete", "001"], { status: "RUNNING", zone: "us-central1-a" });
  assert.equal(/is not defined/.test(r.err), false);
});

test("delete removes the instance", () => {
  const sb = sandbox();
  const r = devbox(sb, ["delete", "001"], { status: "RUNNING", zone: "us-central1-a" });
  assert.equal(r.calls.some((c) => c.includes("instances delete yc-ollama-001")), true);
});

test("delete of the last box preserves the free shared firewall rule", () => {
  const sb = sandbox();
  const r = devbox(sb, ["delete", "001"], { status: "RUNNING", zone: "us-central1-a", sources: "1.2.3.4/32" });
  assert.equal(r.calls.some((c) => c.includes("firewall-rules delete")), false);
});

test("delete keeps the shared firewall rule while another box still exists", () => {
  const sb = sandbox();
  const r = devbox(sb, ["delete", "001"], {
    status: "RUNNING", zone: "us-central1-a", sources: "1.2.3.4/32",
    list: "yc-ollama-002,us-west1-a,RUNNING,g2-standard-8,34.10.0.2\n",
  });
  assert.equal(r.calls.some((c) => c.includes("firewall-rules delete")), false);
});

// ── stop DELETES, because a stopped VM is pinned to its zone ─────────────────────────────────
test("stop deletes the instance", () => {
  const sb = sandbox();
  const r = devbox(sb, ["stop", "001"], { status: "RUNNING", zone: "us-east4-c" });
  assert.equal(r.calls.some((c) => c.includes("instances delete yc-ollama-001")), true);
});

test("stop never issues 'instances stop', which would pin the box to one zone", () => {
  const sb = sandbox();
  const r = devbox(sb, ["stop", "001"], { status: "RUNNING", zone: "us-east4-c" });
  assert.equal(r.calls.some((c) => c.includes("instances stop")), false);
});

test("stop of a box that does not exist deletes nothing", () => {
  const sb = sandbox();
  const r = devbox(sb, ["stop", "001"], { status: "" });
  assert.equal(r.calls.some((c) => c.includes("instances delete")), false);
});

// ── start: the state matrix (domain analysis over the VM's status) ───────────────────────────
test("start adopts a box that is already RUNNING and creates nothing", () => {
  const sb = sandbox();
  const r = devbox(sb, ["start", "001"], { status: "RUNNING", zone: "us-west1-c" });
  assert.deepEqual(createdIn(r.calls), []);
});

test("start of a TERMINATED box exits non-zero", () => {
  const sb = sandbox();
  const r = devbox(sb, ["start", "001"], { status: "TERMINATED", zone: "us-east4-c" });
  assert.equal(r.code, 1);
});

test("start of a STOPPING box exits non-zero rather than racing the shutdown", () => {
  const sb = sandbox();
  const r = devbox(sb, ["start", "001"], { status: "STOPPING", zone: "us-east4-c" });
  assert.equal(r.code, 1);
});

test("start of a TERMINATED box issues no create, so it never duplicates a box", () => {
  const sb = sandbox();
  const r = devbox(sb, ["start", "001"], { status: "TERMINATED", zone: "us-east4-c" });
  assert.deepEqual(createdIn(r.calls), []);
});

// ── hosts: writes the file, replaces stale lines, never escalates ────────────────────────────
test("hosts writes one entry mapping the running box's IP to its hostname", () => {
  const sb = sandbox("127.0.0.1\tlocalhost\n");
  const r = devbox(sb, ["hosts"], { list: "yc-ollama-001,us-central1-a,RUNNING,g2-standard-8,34.10.0.5\n" });
  assert.equal(r.hosts, "127.0.0.1\tlocalhost\n34.10.0.5\tollama-001.dev.example.test\n");
});

test("hosts REPLACES a stale line for the same hostname instead of appending a duplicate", () => {
  const sb = sandbox("127.0.0.1\tlocalhost\n34.10.0.5\tollama-001.dev.example.test\n");
  const r = devbox(sb, ["hosts"], { list: "yc-ollama-001,us-west1-a,RUNNING,g2-standard-8,35.99.0.1\n" });
  assert.equal(r.hosts, "127.0.0.1\tlocalhost\n35.99.0.1\tollama-001.dev.example.test\n");
});

// The hostname is not always the last field: `<ip> <fqdn> <alias>` is ordinary /etc/hosts. A stale
// line like this one surviving leaves a second mapping, and the resolver takes the first.
test("hosts replaces a stale line where the hostname is followed by an alias", () => {
  const sb = sandbox("127.0.0.1\tlocalhost\n10.0.0.1 ollama-001.dev.example.test ollama-001\n");
  const r = devbox(sb, ["hosts"], { list: "yc-ollama-001,us-west1-a,RUNNING,g2-standard-8,35.99.0.1\n" });
  assert.equal(r.hosts, "127.0.0.1\tlocalhost\n35.99.0.1\tollama-001.dev.example.test\n");
});

test("hosts replaces a stale line carrying a trailing comment", () => {
  const sb = sandbox("127.0.0.1\tlocalhost\n10.0.0.1\tollama-001.dev.example.test\t# old box\n");
  const r = devbox(sb, ["hosts"], { list: "yc-ollama-001,us-west1-a,RUNNING,g2-standard-8,35.99.0.1\n" });
  assert.equal(r.hosts, "127.0.0.1\tlocalhost\n35.99.0.1\tollama-001.dev.example.test\n");
});

// A commented-out line is not a mapping, so deleting it destroys an operator's own note.
test("hosts leaves a commented-out line for the same hostname in place", () => {
  const sb = sandbox("#1.2.3.4 ollama-001.dev.example.test\n127.0.0.1\tlocalhost\n");
  const r = devbox(sb, ["hosts"], { list: "yc-ollama-001,us-central1-a,RUNNING,g2-standard-8,34.10.0.5\n" });
  assert.equal(r.hosts, "#1.2.3.4 ollama-001.dev.example.test\n127.0.0.1\tlocalhost\n34.10.0.5\tollama-001.dev.example.test\n");
});

test("hosts leaves unrelated entries untouched", () => {
  const sb = sandbox("127.0.0.1\tlocalhost\n10.0.0.4\tprinter.local\n");
  const r = devbox(sb, ["hosts"], { list: "yc-ollama-001,us-central1-a,RUNNING,g2-standard-8,34.10.0.5\n" });
  assert.equal(r.hosts, "127.0.0.1\tlocalhost\n10.0.0.4\tprinter.local\n34.10.0.5\tollama-001.dev.example.test\n");
});

test("hosts running twice with the same IP leaves exactly one line for that hostname", () => {
  const sb = sandbox("127.0.0.1\tlocalhost\n");
  devbox(sb, ["hosts"], { list: "yc-ollama-001,us-central1-a,RUNNING,g2-standard-8,34.10.0.5\n" });
  const r = devbox(sb, ["hosts"], { list: "yc-ollama-001,us-central1-a,RUNNING,g2-standard-8,34.10.0.5\n" });
  assert.equal(r.hosts, "127.0.0.1\tlocalhost\n34.10.0.5\tollama-001.dev.example.test\n");
});

test("hosts gives two boxes one hostname each, pointed at their own IPs", () => {
  const sb = sandbox("127.0.0.1\tlocalhost\n");
  const r = devbox(sb, ["hosts"], {
    list: "yc-ollama-001,us-central1-a,RUNNING,g2-standard-8,34.10.0.5\nyc-ollama-002,us-west1-a,RUNNING,g2-standard-8,35.99.0.1\n",
  });
  assert.equal(r.hosts,
    "127.0.0.1\tlocalhost\n34.10.0.5\tollama-001.dev.example.test\n35.99.0.1\tollama-002.dev.example.test\n");
});

test("hosts on a file with no trailing newline appends without gluing onto the last line", () => {
  const sb = sandbox("127.0.0.1\tlocalhost");
  const r = devbox(sb, ["hosts"], { list: "yc-ollama-001,us-central1-a,RUNNING,g2-standard-8,34.10.0.5\n" });
  assert.equal(r.hosts, "127.0.0.1\tlocalhost\n34.10.0.5\tollama-001.dev.example.test\n");
});

test("hosts on an empty file writes just the entry", () => {
  const sb = sandbox("");
  const r = devbox(sb, ["hosts"], { list: "yc-ollama-001,us-central1-a,RUNNING,g2-standard-8,34.10.0.5\n" });
  assert.equal(r.hosts, "\n34.10.0.5\tollama-001.dev.example.test\n");
});

test("hosts prints each line it wrote, naming the file it wrote to", () => {
  const sb = sandbox("127.0.0.1\tlocalhost\n");
  const r = devbox(sb, ["hosts"], { list: "yc-ollama-001,us-central1-a,RUNNING,g2-standard-8,34.10.0.5\n" });
  assert.match(r.out, new RegExp(`^${sb.hosts.replace(/[/.]/g, "\\$&")}: 34\\.10\\.0\\.5\tollama-001\\.dev\\.example\\.test$`, "m"));
});

test("hosts with no box carrying an IP leaves the file untouched", () => {
  const sb = sandbox("127.0.0.1\tlocalhost\n");
  const r = devbox(sb, ["hosts"], { list: "yc-ollama-001,us-central1-a,TERMINATED,g2-standard-8,\n" });
  assert.equal(r.hosts, "127.0.0.1\tlocalhost\n");
});

test("hosts with no boxes at all says so instead of writing", () => {
  const sb = sandbox("127.0.0.1\tlocalhost\n");
  const r = devbox(sb, ["hosts"], { list: "" });
  assert.match(r.out, /^No running boxes with an IP yet\.$/m);
});

test("an unwritable hosts file is left unchanged", () => {
  const sb = sandbox("127.0.0.1\tlocalhost\n");
  chmodSync(sb.hosts, 0o444);
  const r = devbox(sb, ["hosts"], { list: "yc-ollama-001,us-central1-a,RUNNING,g2-standard-8,34.10.0.5\n" });
  chmodSync(sb.hosts, 0o644);
  assert.equal(r.hosts, "127.0.0.1\tlocalhost\n");
});

test("an unwritable hosts file prints the sudo command rather than escalating", () => {
  const sb = sandbox("127.0.0.1\tlocalhost\n");
  chmodSync(sb.hosts, 0o444);
  const r = devbox(sb, ["hosts"], { list: "yc-ollama-001,us-central1-a,RUNNING,g2-standard-8,34.10.0.5\n" });
  chmodSync(sb.hosts, 0o644);
  assert.match(r.out, /is not writable by this user — NOT escalating\. Run:/);
});

test("an unwritable hosts file never runs sudo itself", () => {
  const sb = sandbox("127.0.0.1\tlocalhost\n");
  chmodSync(sb.hosts, 0o444);
  const r = devbox(sb, ["hosts"], { list: "yc-ollama-001,us-central1-a,RUNNING,g2-standard-8,34.10.0.5\n" });
  chmodSync(sb.hosts, 0o644);
  assert.equal(r.calls.some((c) => c.includes("sudo")), false);
});

// ── create wires the hosts write in, so the name is true the moment the box exists ───────────
test("a create that finds no capacity leaves the hosts file untouched", () => {
  const sb = sandbox("127.0.0.1\tlocalhost\n34.10.0.5\tollama-001.dev.example.test\n");
  const r = devbox(sb, ["create", "001", "--rounds=1"], { capacity: "" });
  assert.equal(r.hosts, "127.0.0.1\tlocalhost\n34.10.0.5\tollama-001.dev.example.test\n");
});

test("create refuses when the box already exists, without attempting any zone", () => {
  const sb = sandbox();
  const r = devbox(sb, ["create", "001"], { status: "RUNNING", zone: "us-central1-a", capacity: "us-central1-a" });
  assert.deepEqual(createdIn(r.calls), []);
});

// ── auth and usage guards: every verb runs behind these ──────────────────────────────────────
test("an unknown verb prints usage and exits non-zero", () => {
  const sb = sandbox();
  const r = devbox(sb, ["restart", "001"]);
  assert.equal(r.code, 1);
});

test("an unknown verb never reaches gcloud at all", () => {
  const sb = sandbox();
  const r = devbox(sb, ["restart", "001"]);
  assert.deepEqual(r.calls, []);
});

test("no active gcloud account exits 2 and tells you to log in", () => {
  const sb = sandbox();
  const r = devbox(sb, ["list"], { auth: "" });
  assert.equal(r.code, 2);
});

test("no active gcloud account issues no instance calls", () => {
  const sb = sandbox();
  const r = devbox(sb, ["list"], { auth: "" });
  assert.equal(r.calls.some((c) => c.includes("instances")), false);
});

test("a reauthentication prompt from gcloud auth exits 2 rather than reporting no boxes", () => {
  const sb = sandbox();
  const r = devbox(sb, ["list"], { auth: "Reauthentication required" });
  assert.equal(r.code, 2);
});

test("an expired token surfacing on describe exits 2, not 'does not exist'", () => {
  const sb = sandbox();
  const r = devbox(sb, ["status", "001"], { status: "Reauthentication required", zone: "us-central1-a" });
  assert.equal(r.code, 2);
});

test("a box name that is actually a flag is refused with usage", () => {
  const sb = sandbox();
  const r = devbox(sb, ["status", "--zone=us-central1-a"]);
  assert.equal(r.code, 1);
});

// ── list ─────────────────────────────────────────────────────────────────────────────────────
test("standalone Node CLI list resolves shared config before reporting no boxes", () => {
  const sb = sandbox();
  const r = devbox(sb, ["list"], { list: "" });
  assert.match(r.out, /^No devboxes\. Create one: node scripts\/devbox\.js create <name>$/m);
});

test("list prints one row per box with its URL", () => {
  const sb = sandbox();
  const r = devbox(sb, ["list"], { list: "yc-ollama-001,us-central1-a,RUNNING,g2-standard-8,34.10.0.5\n" });
  assert.equal(r.out.split("\n").includes("001          RUNNING    g2-standard-8    http://34.10.0.5:11434         us-central1-a"), true);
});

test("list totals the hourly burn of only the RUNNING boxes", () => {
  const sb = sandbox();
  const r = devbox(sb, ["list"], {
    list: "yc-ollama-001,us-central1-a,RUNNING,g2-standard-8,34.10.0.5\nyc-ollama-002,us-west1-a,TERMINATED,g2-standard-8,\n",
  });
  assert.match(r.out, /^1 running of 2 — ~\$0\.85\/hr\./m);
});

test("list shows a dash for a box with no IP", () => {
  const sb = sandbox();
  const r = devbox(sb, ["list"], { list: "yc-ollama-002,us-west1-a,TERMINATED,g2-standard-8,\n" });
  assert.equal(r.out.split("\n").includes("002          TERMINATED g2-standard-8    -                              us-west1-a"), true);
});

test("list warns when no firewall rule exists", () => {
  const sb = sandbox();
  const r = devbox(sb, ["list"], { list: "yc-ollama-001,us-central1-a,RUNNING,g2-standard-8,34.10.0.5\n", sources: "" });
  assert.match(r.out, /^ACCESS: tcp:11434 from \(no firewall rule!\)$/m);
});

test("list ignores gcloud's stray WARNING line instead of treating it as a box", () => {
  const sb = sandbox();
  const r = devbox(sb, ["list"], { list: "WARNING: The following filter keys were not present in any resource : labels.purpose\n" });
  assert.match(r.out, /^No devboxes\./m);
});

// ── allow / allowlist ────────────────────────────────────────────────────────────────────────
test("allow creates the firewall rule scoped to your own IP when none exists", () => {
  const sb = sandbox();
  const r = devbox(sb, ["allow"], { sources: "", myIp: "203.0.113.9" });
  assert.equal(r.calls.some((c) => c.includes("firewall-rules create yc-ollama-allow") && c.includes("--source-ranges=203.0.113.9/32")), true);
});

test("allow never opens the rule to the whole internet", () => {
  const sb = sandbox();
  const r = devbox(sb, ["allow"], { sources: "", myIp: "203.0.113.9" });
  assert.equal(r.calls.some((c) => c.includes("0.0.0.0/0")), false);
});

test("allow appends your IP to an existing allowlist instead of replacing it", () => {
  const sb = sandbox();
  const r = devbox(sb, ["allow"], { sources: "198.51.100.7/32", myIp: "203.0.113.9" });
  assert.equal(r.calls.some((c) => c.includes("firewall-rules update yc-ollama-allow") && c.includes("--source-ranges=198.51.100.7/32,203.0.113.9/32")), true);
});

test("allow is a no-op when your IP is already allowed", () => {
  const sb = sandbox();
  const r = devbox(sb, ["allow"], { sources: "203.0.113.9/32", myIp: "203.0.113.9" });
  assert.equal(r.calls.some((c) => c.includes("firewall-rules update")), false);
});

test("a public IP lookup that returns garbage exits 2 rather than writing a bogus rule", () => {
  const sb = sandbox();
  const r = devbox(sb, ["allow"], { sources: "198.51.100.7/32", myIp: "<html>error</html>" });
  assert.equal(r.code, 2);
});

test("allowlist prints the current source ranges", () => {
  const sb = sandbox();
  const r = devbox(sb, ["allowlist"], { sources: "198.51.100.7/32" });
  assert.match(r.out, /^tcp:11434 allowed from:\n {2}198\.51\.100\.7\/32$/m);
});

test("allowlist reports when there is no rule at all", () => {
  const sb = sandbox();
  const r = devbox(sb, ["allowlist"], { sources: "" });
  assert.match(r.out, /^No firewall rule yc-ollama-allow — nothing can reach the boxes\.$/m);
});

test("allowlist warns loudly when the rule is open to 0.0.0.0/0", () => {
  const sb = sandbox();
  const r = devbox(sb, ["allowlist"], { sources: "0.0.0.0/0" });
  assert.match(r.out, /WARNING: open to the whole internet, and Ollama has NO auth\./);
});

// ── status ───────────────────────────────────────────────────────────────────────────────────
test("status of a box that does not exist says so and exits zero", () => {
  const sb = sandbox();
  const r = devbox(sb, ["status", "001"], { status: "" });
  assert.match(r.out, /^yc-ollama-001: does not exist in us-central1-a\.$/m);
});

test("status of a RUNNING box quotes its hourly rate", () => {
  const sb = sandbox();
  const r = devbox(sb, ["status", "001"], { status: "RUNNING", zone: "us-central1-a" });
  assert.match(r.out, /^BILLING: ~\$0\.85\/hr while RUNNING$/m);
});

test("status lists the models the box actually holds", () => {
  const sb = sandbox();
  const r = devbox(sb, ["status", "001"], { status: "RUNNING", zone: "us-central1-a" });
  assert.match(r.out, /^OLLAMA: {2}answering — models: llama3\.1:8b$/m);
});

test("status of a RUNNING box that is not answering points at the allow verb", () => {
  const sb = sandbox();
  const r = devbox(sb, ["status", "001"], { status: "RUNNING", zone: "us-central1-a", ollama: "down" });
  assert.match(r.out, /^OLLAMA: {2}not answering\. If you changed networks: node scripts\/devbox\.js allow$/m);
});

test("status of a TERMINATED box blames the VM state, not the network", () => {
  const sb = sandbox();
  const r = devbox(sb, ["status", "001"], { status: "TERMINATED", zone: "us-central1-a", ollama: "down" });
  assert.match(r.out, /^OLLAMA: {2}not answering\. \(VM is TERMINATED\)$/m);
});

test("status of a box holding no models says none are pulled", () => {
  const sb = sandbox();
  const r = devbox(sb, ["status", "001"], { status: "RUNNING", zone: "us-central1-a", tags: `{"models":[]}` });
  assert.match(r.out, /^OLLAMA: {2}answering — models: \(none pulled\)$/m);
});

// "answering" alone reads as healthy, and a box holding nothing 404s every request. Say BROKEN.
test("status calls a box that answers but holds no models BROKEN, and names the fix", () => {
  const sb = sandbox();
  const r = devbox(sb, ["status", "001"], { status: "RUNNING", zone: "us-central1-a", tags: `{"models":[]}` });
  assert.match(r.out, /^BROKEN: {2}no models — every generation 404s\. Fix: node scripts\/devbox\.js pull 001 <model>$/m);
});

test("status does not call a box with a model BROKEN", () => {
  const sb = sandbox();
  const r = devbox(sb, ["status", "001"], { status: "RUNNING", zone: "us-central1-a" });
  assert.equal(/^BROKEN:/m.test(r.out), false);
});

// ── create's wait-for-boot path ──────────────────────────────────────────────────────────────
test("a create whose model pull fails exits non-zero rather than reporting a usable box", () => {
  const sb = sandbox();
  const r = devbox(sb, ["create", "001"], { capacity: "us-central1-a", sshFail: "1" });
  assert.equal(r.code, 1);
});

test("every create attempt asks for an nvidia-l4 accelerator", () => {
  const sb = sandbox();
  const r = devbox(sb, ["create", "001", "--rounds=1"], { capacity: "" });
  assert.equal(r.calls.filter((c) => c.includes("instances create")).every((c) => c.includes("--accelerator=type=nvidia-l4,count=1")), true);
});

test("every create attempt labels the box purpose=ollama-devbox so list can find it", () => {
  const sb = sandbox();
  const r = devbox(sb, ["create", "001", "--rounds=1"], { capacity: "" });
  assert.equal(r.calls.filter((c) => c.includes("instances create")).every((c) => c.includes("--labels=owner=dev,purpose=ollama-devbox")), true);
});

// ── pull / models / use / chat ───────────────────────────────────────────────────────────────
test("pull without a model name exits non-zero", () => {
  const sb = sandbox();
  const r = devbox(sb, ["pull", "001"], { status: "RUNNING", zone: "us-central1-a" });
  assert.equal(r.code, 1);
});

test("pull onto a box that is not RUNNING exits non-zero", () => {
  const sb = sandbox();
  const r = devbox(sb, ["pull", "001", "llama3.1:8b"], { status: "TERMINATED", zone: "us-central1-a" });
  assert.equal(r.code, 1);
});

test("pull onto a RUNNING box exits zero", () => {
  const sb = sandbox();
  const r = devbox(sb, ["pull", "001", "llama3.1:8b"], { status: "RUNNING", zone: "us-central1-a" });
  assert.equal(r.code, 0);
});

test("models marks the model loaded in VRAM with a filled dot", () => {
  const sb = sandbox();
  const r = devbox(sb, ["models", "001"], {
    status: "RUNNING", zone: "us-central1-a", ps: `{"models":[{"name":"llama3.1:8b"}]}`,
  });
  assert.equal(r.out.split("\n").includes("  ● llama3.1:8b                  4.7GB"), true);
});

test("models marks a model that is on disk but not loaded with a hollow dot", () => {
  const sb = sandbox();
  const r = devbox(sb, ["models", "001"], { status: "RUNNING", zone: "us-central1-a", ps: `{"models":[]}` });
  assert.equal(r.out.split("\n").includes("  ○ llama3.1:8b                  4.7GB"), true);
});

test("models against an unreachable box exits non-zero", () => {
  const sb = sandbox();
  const r = devbox(sb, ["models", "001"], { status: "RUNNING", zone: "us-central1-a", ollama: "down" });
  assert.equal(r.code, 1);
});

test("use without a model name exits non-zero", () => {
  const sb = sandbox();
  const r = devbox(sb, ["use", "001"], { status: "RUNNING", zone: "us-central1-a" });
  assert.equal(r.code, 1);
});

test("use on a box that is not RUNNING exits non-zero", () => {
  const sb = sandbox();
  const r = devbox(sb, ["use", "001", "llama3.1:8b"], { status: "TERMINATED", zone: "us-central1-a" });
  assert.equal(r.code, 1);
});

test("use warms a model the box already holds", () => {
  const sb = sandbox();
  const r = devbox(sb, ["use", "001", "llama3.1:8b"], { status: "RUNNING", zone: "us-central1-a" });
  assert.match(r.out, /^001 is now warm on llama3\.1:8b\. {2}http:\/\/34\.10\.0\.1:11434$/m);
});

test("use pulls a model the box does not hold before warming it", () => {
  const sb = sandbox();
  const r = devbox(sb, ["use", "001", "qwen2.5:14b"], { status: "RUNNING", zone: "us-central1-a" });
  assert.match(r.out, /^qwen2\.5:14b is not on 001 yet — pulling \(this can take a while\)…$/m);
});

test("use reports a failed load instead of claiming the box is warm", () => {
  const sb = sandbox();
  const r = devbox(sb, ["use", "001", "llama3.1:8b"], {
    status: "RUNNING", zone: "us-central1-a", generate: `{"error":"model requires more system memory"}`,
  });
  assert.equal(r.code, 1);
});

test("use against an unreachable box exits non-zero", () => {
  const sb = sandbox();
  const r = devbox(sb, ["use", "001", "llama3.1:8b"], { status: "RUNNING", zone: "us-central1-a", ollama: "down" });
  assert.equal(r.code, 1);
});

test("chat prints the model's reply", () => {
  const sb = sandbox();
  const r = devbox(sb, ["chat", "001", "hi"], { status: "RUNNING", zone: "us-central1-a" });
  assert.match(r.out, /^Hello there\.$/m);
});

test("chat reports Ollama's own tokens-per-second accounting", () => {
  const sb = sandbox();
  const r = devbox(sb, ["chat", "001", "hi"], { status: "RUNNING", zone: "us-central1-a" });
  assert.match(r.out, /^10 tokens in 2\.0s = 5\.0 tok\/s/m);
});

test("chat prefers the model already warm in VRAM", () => {
  const sb = sandbox();
  const r = devbox(sb, ["chat", "001", "hi"], {
    status: "RUNNING", zone: "us-central1-a",
    tags: `{"models":[{"name":"llama3.1:8b","size":4700000000},{"name":"qwen2.5:14b","size":9000000000}]}`,
    ps: `{"models":[{"name":"qwen2.5:14b"}]}`,
  });
  assert.match(r.out, /^\[001 · qwen2\.5:14b\] hi$/m);
});

test("chat falls back to the first model on disk when nothing is warm", () => {
  const sb = sandbox();
  const r = devbox(sb, ["chat", "001", "hi"], { status: "RUNNING", zone: "us-central1-a", ps: `{"models":[]}` });
  assert.match(r.out, /^\[001 · llama3\.1:8b\] hi$/m);
});

test("chat on a box holding no models exits non-zero", () => {
  const sb = sandbox();
  const r = devbox(sb, ["chat", "001", "hi"], { status: "RUNNING", zone: "us-central1-a", tags: `{"models":[]}` });
  assert.equal(r.code, 1);
});

test("chat with no prompt sends the default one", () => {
  const sb = sandbox();
  const r = devbox(sb, ["chat", "001"], { status: "RUNNING", zone: "us-central1-a" });
  assert.match(r.out, /^\[001 · llama3\.1:8b\] Say hello in one short sentence\.$/m);
});

test("chat against an unreachable box exits non-zero", () => {
  const sb = sandbox();
  const r = devbox(sb, ["chat", "001", "hi"], { status: "RUNNING", zone: "us-central1-a", ollama: "down" });
  assert.equal(r.code, 1);
});

// ── stop-all ─────────────────────────────────────────────────────────────────────────────────
test("stop-all with nothing running says so and touches no instance", () => {
  const sb = sandbox();
  const r = devbox(sb, ["stop-all"], { list: "yc-ollama-001,us-central1-a,TERMINATED,g2-standard-8,\n" });
  assert.equal(r.calls.some((c) => c.includes("instances stop") || c.includes("instances delete")), false);
});

test("stop-all acts on every RUNNING box", () => {
  const sb = sandbox();
  const r = devbox(sb, ["stop-all"], {
    list: "yc-ollama-001,us-central1-a,RUNNING,g2-standard-8,34.10.0.5\nyc-ollama-002,us-west1-a,RUNNING,g2-standard-8,35.99.0.1\n",
  });
  assert.match(r.out, /^Deleted 2 box\(es\)\. All billing ends — no compute, no disk, no address\.$/m);
});

// stop-all DELETES like stop: leaving the whole fleet stopped pins every box to its zone at once.
test("stop-all deletes each RUNNING box", () => {
  const sb = sandbox();
  const r = devbox(sb, ["stop-all"], {
    list: "yc-ollama-001,us-central1-a,RUNNING,g2-standard-8,34.10.0.5\nyc-ollama-002,us-west1-a,RUNNING,g2-standard-8,35.99.0.1\n",
  });
  assert.equal(r.calls.some((c) => c.includes("instances delete yc-ollama-001")), true);
  assert.equal(r.calls.some((c) => c.includes("instances delete yc-ollama-002")), true);
});

test("stop-all never issues 'instances stop', which would pin every box to one zone", () => {
  const sb = sandbox();
  const r = devbox(sb, ["stop-all"], {
    list: "yc-ollama-001,us-central1-a,RUNNING,g2-standard-8,34.10.0.5\n",
  });
  assert.equal(r.calls.some((c) => c.includes("instances stop")), false);
});

// ── delete of a box that is already gone ─────────────────────────────────────────────────────
test("delete of a box that does not exist still exits zero", () => {
  const sb = sandbox();
  const r = devbox(sb, ["delete", "001"], { status: "" });
  assert.equal(r.code, 0);
});

test("delete of a box that does not exist issues no instance delete", () => {
  const sb = sandbox();
  const r = devbox(sb, ["delete", "001"], { status: "" });
  assert.equal(r.calls.some((c) => c.includes("instances delete")), false);
});

// ── the script's own defaults, exercised by omitting the environment variable ─────────────────
test("with no GCP_PROJECT_ID set, every gcloud call targets yeschef-c572a", () => {
  const sb = sandbox();
  const r = devbox(sb, ["status", "001"], { omit: ["GCP_PROJECT_ID"], status: "RUNNING", zone: "us-central1-a" });
  assert.equal(r.calls.every((c) => c.includes("auth list") || c.includes("--project=yeschef-c572a")), true);
});

test("with no GCP_ZONE set, a box that does not exist is reported against us-central1-a", () => {
  const sb = sandbox();
  const r = devbox(sb, ["status", "001"], { omit: ["GCP_ZONE"], status: "" });
  assert.match(r.out, /^yc-ollama-001: does not exist in us-central1-a\.$/m);
});

test("with no NODE_ENV set the script still runs", () => {
  const sb = sandbox();
  const r = devbox(sb, ["allowlist"], { omit: ["NODE_ENV"], sources: "198.51.100.7/32" });
  assert.equal(r.code, 0);
});

test("with no DEVBOX_DNS_SUFFIX set the hostname falls back to dev.yeschef.life", () => {
  const sb = sandbox("127.0.0.1\tlocalhost\n");
  const r = devbox(sb, ["hosts"], {
    omit: ["DEVBOX_DNS_SUFFIX"], list: "yc-ollama-001,us-central1-a,RUNNING,g2-standard-8,34.10.0.5\n",
  });
  assert.equal(r.hosts, "127.0.0.1\tlocalhost\n34.10.0.5\tollama-001.dev.yeschef.life\n");
});

// The /etc/hosts fallback is exercised only on the path that returns BEFORE reading or writing the
// file, so this suite can prove the default without ever touching a system file.
test("with no DEVBOX_HOSTS_FILE set and no boxes, nothing is read or written", () => {
  const sb = sandbox("127.0.0.1\tlocalhost\n");
  const before = readFileSync("/etc/hosts", "utf8");
  const r = devbox(sb, ["hosts"], { omit: ["DEVBOX_HOSTS_FILE"], list: "" });
  assert.equal(readFileSync("/etc/hosts", "utf8"), before);
  assert.match(r.out, /^No running boxes with an IP yet\.$/m);
});

// ── missing / unexpected values from GCE ─────────────────────────────────────────────────────
test("a RUNNING box with no external IP yet reports an empty URL rather than a broken one", () => {
  const sb = sandbox();
  const r = devbox(sb, ["status", "001"], { status: "RUNNING", zone: "us-central1-a", ip: "" });
  assert.match(r.out, /^URL: {5}$/m);
});

test("list shows a question mark for a box whose machine type is missing", () => {
  const sb = sandbox();
  const r = devbox(sb, ["list"], { list: "yc-ollama-001,us-central1-a,RUNNING,,34.10.0.5\n" });
  assert.equal(r.out.split("\n").includes("001          RUNNING    ?                http://34.10.0.5:11434         us-central1-a"), true);
});

test("list bills $0.00/hr for a machine type with no known rate", () => {
  const sb = sandbox();
  const r = devbox(sb, ["list"], { list: "yc-ollama-001,us-central1-a,RUNNING,n1-standard-1,34.10.0.5\n" });
  assert.match(r.out, /^1 running of 1 — ~\$0\.00\/hr\./m);
});

test("status bills $0.00/hr for a machine type with no known rate", () => {
  const sb = sandbox();
  const r = devbox(sb, ["status", "001"], { status: "RUNNING", zone: "us-central1-a", machine: "n1-standard-1" });
  assert.match(r.out, /^BILLING: ~\$0\.00\/hr while RUNNING$/m);
});

// Nothing here manages DNS, so status must not advertise a name it does not publish — a
// CLOUDFLARE_API_TOKEN in the environment changes nothing.
test("status never advertises a DNS name, even with a Cloudflare token set", () => {
  const sb = sandbox();
  const r = devbox(sb, ["status", "001"], { status: "RUNNING", zone: "us-central1-a", cfToken: "cf-token-abc" });
  assert.equal(/^DNS:/m.test(r.out), false);
});

test("status survives a tags response with no models key at all", () => {
  const sb = sandbox();
  const r = devbox(sb, ["status", "001"], { status: "RUNNING", zone: "us-central1-a", tags: `{}` });
  assert.match(r.out, /^OLLAMA: {2}answering — models: \(none pulled\)$/m);
});

test("models treats an unreachable /api/ps as nothing loaded rather than failing", () => {
  const sb = sandbox();
  const r = devbox(sb, ["models", "001"], { status: "RUNNING", zone: "us-central1-a", ps: "down" });
  assert.equal(r.out.split("\n").includes("  ○ llama3.1:8b                  4.7GB"), true);
});

test("models survives a tags response with no models key at all", () => {
  const sb = sandbox();
  const r = devbox(sb, ["models", "001"], { status: "RUNNING", zone: "us-central1-a", tags: `{}` });
  assert.equal(r.code, 0);
});

test("use does not re-pull a model the box holds under its :latest tag", () => {
  const sb = sandbox();
  const r = devbox(sb, ["use", "001", "mistral"], {
    status: "RUNNING", zone: "us-central1-a", tags: `{"models":[{"name":"mistral:latest","size":4100000000}]}`,
  });
  assert.equal(/is not on 001 yet — pulling/.test(r.out), false);
});

test("use reports a failed pull instead of trying to load the model", () => {
  const sb = sandbox();
  const r = devbox(sb, ["use", "001", "qwen2.5:14b"], {
    status: "RUNNING", zone: "us-central1-a", pull: `{"error":"model \\"qwen2.5:14b\\" not found"}`,
  });
  assert.equal(r.code, 1);
});

test("chat treats an unreachable /api/ps as nothing warm and still picks a model", () => {
  const sb = sandbox();
  const r = devbox(sb, ["chat", "001", "hi"], { status: "RUNNING", zone: "us-central1-a", ps: "down" });
  assert.match(r.out, /^\[001 · llama3\.1:8b\] hi$/m);
});

test("chat survives a ps response with no models key at all", () => {
  const sb = sandbox();
  const r = devbox(sb, ["chat", "001", "hi"], { status: "RUNNING", zone: "us-central1-a", ps: `{}` });
  assert.match(r.out, /^\[001 · llama3\.1:8b\] hi$/m);
});

test("chat exits non-zero when the generate call itself fails", () => {
  const sb = sandbox();
  const r = devbox(sb, ["chat", "001", "hi"], { status: "RUNNING", zone: "us-central1-a", generate: "down" });
  assert.equal(r.code, 1);
});

test("chat prints the raw body when the reply carries no response field", () => {
  const sb = sandbox();
  const r = devbox(sb, ["chat", "001", "hi"], { status: "RUNNING", zone: "us-central1-a", generate: `{"done":true}` });
  assert.match(r.out, /^\{"done":true\}$/m);
});

test("--model overrides both the warm model and the first model on disk in chat", () => {
  const sb = sandbox();
  const r = devbox(sb, ["chat", "001", "hi", "--model=qwen2.5:14b"], {
    status: "RUNNING", zone: "us-central1-a",
    tags: `{"models":[{"name":"llama3.1:8b","size":4700000000}]}`,
    ps: `{"models":[{"name":"llama3.1:8b"}]}`,
  });
  assert.match(r.out, /^\[001 · qwen2\.5:14b\] hi$/m);
});

test("models survives a ps response with no models key at all", () => {
  const sb = sandbox();
  const r = devbox(sb, ["models", "001"], { status: "RUNNING", zone: "us-central1-a", ps: `{}` });
  assert.equal(r.out.split("\n").includes("  ○ llama3.1:8b                  4.7GB"), true);
});

test("use pulls when the tags response has no models key at all", () => {
  const sb = sandbox();
  const r = devbox(sb, ["use", "001", "llama3.1:8b"], { status: "RUNNING", zone: "us-central1-a", tags: `{}` });
  assert.match(r.out, /^llama3\.1:8b is not on 001 yet — pulling \(this can take a while\)…$/m);
});

test("chat exits non-zero when the tags response has no models key at all", () => {
  const sb = sandbox();
  const r = devbox(sb, ["chat", "001", "hi"], { status: "RUNNING", zone: "us-central1-a", tags: `{}` });
  assert.equal(r.code, 1);
});
