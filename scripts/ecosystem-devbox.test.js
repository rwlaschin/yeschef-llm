import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOX_NAMES } from "../config/devboxes.js";
import { devModels, subscriptionOf } from "../config/models.js";

// The ecosystem file is CommonJS and reads process.argv — pm2's own — to decide whether to expose the
// GPU apps. So it is exercised the way pm2 loads it: a fresh node process whose argv either carries
// --only or does not. Nothing here starts pm2 and nothing creates a VM.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (argv = []) => {
  // `--` keeps node from claiming --only as one of its own options; pm2 passes it the same way.
  const r = spawnSync(process.execPath, ["-e", `console.log(JSON.stringify(require('./ecosystem.devbox.config.cjs').apps))`, "--", ...argv],
    { cwd: ROOT, encoding: "utf8" });
  return { apps: JSON.parse(r.stdout), err: r.stderr };
};

const workerApps = (apps) => apps.filter((a) => a.name.startsWith("b-"));

test("a bare load withholds every box — only the non-GPU workers are exposed", () => {
  const { apps, err } = load();
  assert.equal(apps.some((a) => a.name.startsWith("ollama-")), false);
  assert.equal(workerApps(apps).length, apps.length);
  assert.match(err, /no --only: withholding the boxes/);
});

test("with --only, the app list is the enabled boxes plus the baremetal workers", () => {
  const { apps } = load(["--only", "ollama-001"]);
  assert.deepEqual(apps.map((a) => a.name).slice(0, BOX_NAMES.length), BOX_NAMES.map((n) => `ollama-${n}`));
  assert.equal(apps.length, BOX_NAMES.length + devModels().length);
});

// THE DRIFT GUARD. One app per dev model, no more and no less: a model added to config/models.js with
// dev:true and no worker app here would leave its subscription undrained, and jobs would just sit.
test("the baremetal worker apps are exactly devModels(), each with its own model and subscription", () => {
  const { apps } = load();
  const byModel = new Map(workerApps(apps).map((a) => [a.env.WORKER_MODEL + "|" + a.env.WORKER_SUBSCRIPTION, a]));
  assert.equal(byModel.size, devModels().length);
  for (const m of devModels()) {
    const a = byModel.get(`${m.model}|${subscriptionOf(m)}`);
    assert.ok(a, `no worker app for dev model ${m.topic}`);
  }
});

// Two subscribers on one subscription split the messages, so a duplicated subscription silently
// halves throughput on both apps instead of failing.
test("no two worker apps drain the same subscription", () => {
  const subs = workerApps(load().apps).map((a) => a.env.WORKER_SUBSCRIPTION);
  assert.equal(new Set(subs).size, subs.length);
});

// The model and the subscription must arrive as ENV, never baked into the launch command — see the
// header of scripts/worker-native.mjs for what the baked form cost.
test("each worker ships through the pm2-dev shim as component script, tagged with its own name, with no target in the command", () => {
  for (const a of workerApps(load().apps)) {
    assert.equal(a.script, "pm2-dev.mjs");
    assert.deepEqual(a.args, ["npm run dev:worker:native", "script", a.name]);
    assert.equal(a.autorestart, true, a.name);
    assert.equal(a.min_uptime, "10s", a.name);
    assert.equal(a.max_restarts, 5, a.name);
    assert.equal(a.watch, false, a.name);
    assert.equal(a.env.WORKER_OLLAMA_HOST, undefined, `${a.name} must share the host from .env.dev`);
  }
});

test("the ecosystem holds no box list of its own — it matches the registry exactly", () => {
  const { apps } = load(["--only"]);
  const boxes = apps.filter((a) => a.name.startsWith("ollama-")).map((a) => a.name.replace("ollama-", ""));
  assert.deepEqual(boxes, BOX_NAMES);
});

test("no generated app is named for a letter — boxes are 001..004", () => {
  const { apps } = load(["--only"]);
  assert.equal(apps.some((a) => /^ollama-[a-z]$/.test(a.name)), false);
});

// The invariant the whole per-app design rests on: pm2 puts WORKER_MODEL/WORKER_SUBSCRIPTION in the
// child's environment, and worker-native.mjs then calls dotenv-flow. If dotenv-flow overwrote what is
// already there, every app would read the same .env.dev values and drain the same queue.
test("dotenv-flow does not overwrite a variable pm2 already set", () => {
  const r = spawnSync(process.execPath, ["-e",
    `import('dotenv-flow').then(d => { d.default.config({ node_env: 'dev' }); console.log(process.env.WORKER_OLLAMA_HOST) })`],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, WORKER_OLLAMA_HOST: "http://from-pm2:11434" } });
  assert.equal(r.stdout.trim(), "http://from-pm2:11434");
});

// The crash-loop guard: an agent that respawns would power a GPU VM back on by itself.
test("every generated box app keeps autorestart:false, max_restarts:0, kill_timeout:120000", () => {
  const { apps } = load(["--only"]);
  const boxes = apps.filter((a) => a.name.startsWith("ollama-"));
  assert.equal(boxes.length > 0, true);
  for (const a of boxes) {
    assert.equal(a.autorestart, false, a.name);
    assert.equal(a.max_restarts, 0, a.name);
    assert.equal(a.kill_timeout, 120000, a.name);
    assert.equal(a.watch, false, a.name);
  }
});

test("each box runs through the pm2-dev shim as component script, tagged with its own name", () => {
  const { apps } = load(["--only"]);
  for (const a of apps.filter((x) => x.name.startsWith("ollama-"))) {
    const n = a.name.replace("ollama-", "");
    assert.equal(a.script, "pm2-dev.mjs");
    assert.deepEqual(a.args.slice(1), ["script", `ollama-${n}`]);
    assert.match(a.args[0], new RegExp(`devbox-agent\\.mjs ${n}$`));
  }
});
