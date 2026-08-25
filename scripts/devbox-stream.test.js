import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(ROOT, "../dashboard/server/api/devbox/stream.get.ts"), "utf8");

test("SSE source contract: every per-box startup-state file change pushes aggregated progress without waiting for a terminal phase", () => {
  const watchCallback = source.match(/watch\(STARTUP_DIR,\s*\([^=]*=>\s*\{([\s\S]*?)\n\s*\}\)\)/)?.[1] || "";

  assert.match(watchCallback, /if \(fn.*\.json.*\) pushProgress\(\)/);
  assert.doesNotMatch(watchCallback, /ready|failed|terminal/);
  assert.match(source, /readAllStartupStates/);
  assert.match(source, /stream\.push\(JSON\.stringify\(\{ progress: state \}\)\)/);
});
