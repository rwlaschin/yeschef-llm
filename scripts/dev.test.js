import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// dev.js calls main() at import time — importing it would start emulators and containers. So the
// flag logic is read out of the source and evaluated in isolation: the assertions below are about
// the real expressions in dev.js, not a copy of them.
const SRC = fs.readFileSync(join(dirname(fileURLToPath(import.meta.url)), "dev.js"), "utf8");
const expr = (name) => {
  const m = SRC.match(new RegExp(`^const ${name} = (.+);$`, "m"));
  assert.ok(m, `dev.js no longer declares ${name} on one line — this test needs updating`);
  return m[1];
};
const flags = (argv) => {
  const ONLY = eval(`((process) => (${expr("ONLY")}))`)({ argv });
  return { ONLY, ai: eval(`((ONLY) => (${expr("RUN_AI")}))`)(ONLY), workers: eval(`((ONLY) => (${expr("RUN_WORKERS")}))`)(ONLY) };
};

// THE CONTRACT. The `b-*` pm2 apps already drain every dev model's subscription; a Docker worker on
// the same subscription is a second subscriber on one queue, and Pub/Sub would split jobs between
// them. So the Docker half is opt-in — nothing but an explicit --only=workers may turn it on.
test("a plain `npm run dev` does NOT start the Docker workers", () => {
  const f = flags(["node", "scripts/dev.js"]);
  assert.equal(f.ONLY, "all");
  assert.equal(f.workers, false);
  assert.equal(f.ai, true); // the orchestrator half, and with it setupPubSub, still runs
});

test("--only=workers is the ONLY way to start the Docker workers", () => {
  assert.equal(flags(["node", "scripts/dev.js", "--only=workers"]).workers, true);
  for (const only of ["all", "ai", "fake"]) {
    assert.equal(flags(["node", "scripts/dev.js", `--only=${only}`]).workers, false, `--only=${only} must not start Docker workers`);
  }
});
