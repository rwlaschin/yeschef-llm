import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("equivalence partitioning: the standalone devbox utility loads outside Nuxt so npm run box and detached snapshots can observe VM changes", () => {
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    "const devbox = await import('./dashboard/server/utils/devbox.js'); process.stdout.write(typeof devbox.writeFleetSnapshot)",
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVBOX_STARTUP_DIR: "/tmp/yeschef-devbox-standalone-import-test",
      DEVBOX_FLEET_FILE: "/tmp/yeschef-devbox-standalone-fleet-test.json",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "function");
  assert.doesNotMatch(result.stderr, /ERR_PACKAGE_IMPORT_NOT_DEFINED|ERR_MODULE_NOT_FOUND/);
});

test("domain analysis: the server stream watches the per-box state directory instead of the removed shared startup-state file", () => {
  const source = readFileSync(resolve(ROOT, "dashboard/server/api/devbox/stream.get.ts"), "utf8");

  assert.match(source, /watch\(STARTUP_DIR,/);
  assert.match(source, /fn\?\.endsWith\(['"]\.json['"]\)/);
  assert.match(source, /readAllStartupStates\(\)/);
  assert.doesNotMatch(source, /DEVBOX_STARTUP_FILE/);
});

test("combinatorial testing: create update cancel and delete events for any per-box JSON file all trigger an immediate progress refresh", () => {
  const source = readFileSync(resolve(ROOT, "dashboard/server/api/devbox/stream.get.ts"), "utf8");
  const callback = source.match(/watch\(STARTUP_DIR,\s*\([^=]*=>\s*\{([\s\S]*?)\n\s*\}\)\)/)?.[1] || "";

  assert.match(callback, /if \(fn\?\.endsWith\(['"]\.json['"]\)\) pushProgress\(\)/);
  assert.doesNotMatch(callback, /eventType|rename|change|ready|failed/);
});

test("error guessing: the fleet refresher launches a standalone-loadable script rather than relying on Nuxt alias resolution", () => {
  const getRoute = readFileSync(resolve(ROOT, "dashboard/server/api/devbox.get.ts"), "utf8");
  const streamRoute = readFileSync(resolve(ROOT, "dashboard/server/api/devbox/stream.get.ts"), "utf8");

  assert.match(getRoute, /scripts\/devbox\.js/);
  assert.match(streamRoute, /scripts\/devbox\.js/);
});
