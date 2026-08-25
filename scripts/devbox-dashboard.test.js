import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const tmpDir = resolve(ROOT, "../tmp");
try { mkdirSync(tmpDir, { recursive: true }); } catch {}
const snapshotFile = resolve(tmpDir, "devbox-fleet-test.json");
process.env.DEVBOX_FLEET_FILE = snapshotFile;

// Seed snapshot so snapshot reader has data
writeFileSync(snapshotFile, JSON.stringify({
  at: Date.now(),
  auth: { ok: true },
  firewall: { isAllowed: true, allowedRanges: [] },
  boxes: [
    { name: "001", status: "STOPPED" },
    { name: "002", status: "STOPPED" },
    { name: "003", status: "STOPPED" },
    { name: "004", status: "STOPPED" },
  ]
}));

// Set up Nitro global stubs before dynamic import
globalThis.defineEventHandler = (fn) => fn;
globalThis.getHeader = (event, name) => "127.0.0.1";
globalThis.createError = (opts) => {
  const err = new Error(opts.statusMessage || "Error");
  err.statusCode = opts.statusCode;
  return err;
};

const GET_PATH = join(ROOT, "../dashboard/server/api/devbox.get.ts");
const POST_PATH = join(ROOT, "../dashboard/server/api/devbox.post.ts");
const AUTH_PATH = join(ROOT, "../dashboard/server/api/devbox/auth.get.ts");
const DEVBOX_PATH = join(ROOT, "..", "dashboard", "server", "utils", "devbox.js");

test("Rule 1: File Loading & Dynamic Import — devbox API routes can be imported cleanly", async () => {
  const getMod = await import(GET_PATH);
  const postMod = await import(POST_PATH);
  const authMod = await import(AUTH_PATH);

  assert.equal(typeof getMod.default, "function", "devbox.get exports default handler");
  assert.equal(typeof postMod.default, "function", "devbox.post exports default handler");
  assert.equal(typeof authMod.default, "function", "auth.get exports default handler");
});

test("Rule 2: Function Execution — devbox.get handler executes without ReferenceErrors", async () => {
  const getMod = await import(GET_PATH);

  const mockEvent = {
    node: { req: { headers: { "x-forwarded-for": "127.0.0.1" } } },
    context: {},
  };

  const res = await getMod.default(mockEvent);
  assert.ok(res, "received response");
  assert.equal(typeof res.ok, "boolean");
  assert.ok(Array.isArray(res.boxes), "boxes is an array");
  assert.ok(Array.isArray(res.workers), "workers is an array");
  assert.equal(res.boxes.length, 4, "has 4 declared boxes");
});

test("Rule 2: Function Execution — devbox.post handler dispatches actions without ReferenceErrors", async () => {
  const postMod = await import(POST_PATH);

  // Action: Missing action
  globalThis.readBody = async () => ({});
  await assert.rejects(async () => {
    await postMod.default({});
  }, /Action required/);

  // Action: Unknown action
  globalThis.readBody = async () => ({ action: "unknown-action" });
  await assert.rejects(async () => {
    await postMod.default({});
  }, /Unknown action/);
});

test("Regression: dashboard starts the CLI wrapper that consumes passed options", () => {
  const source = readFileSync(POST_PATH, "utf8");
  assert.match(source, /scripts\/devbox\.js/);
  assert.doesNotMatch(source, /new URL\('\.\.\/utils\/devbox\.js'/);
  assert.match(source, /`--timeout=\$\{timeoutMinutes\}`/);
});

test("Rule 2: Function Execution — devbox/auth.get handler executes cleanly", async () => {
  const authMod = await import(AUTH_PATH);
  const res = await authMod.default({});
  assert.ok(res, "auth response received");
  assert.equal(typeof res.ok, "boolean");
  assert.equal(res.loginCmd, "gcloud auth login");
});

test("Rule 2: Function Execution — devbox/auth.get deduplicates concurrent requests to prevent event-loop lockup", async () => {
  const authMod = await import(AUTH_PATH);
  authMod.clearAuthCache();

  let checkAuthCallCount = 0;
  let inFlight = null;
  const mockCheckAuth = async () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      checkAuthCallCount++;
      return { ok: true, account: "test@yeschef.life", error: null };
    })();
    const res = await inFlight;
    inFlight = null;
    return res;
  };

  // Fire 5 concurrent requests at once
  const promises = Array.from({ length: 5 }).map(() => authMod.handleAuthGet({}, mockCheckAuth));
  const results = await Promise.all(promises);

  assert.equal(results.length, 5, "all 5 concurrent requests completed");
  // Under proper deduplication, 5 concurrent requests must NOT invoke checkAuth 5 separate times
  assert.equal(checkAuthCallCount, 1, `checkAuth was called ${checkAuthCallCount} times; expected 1 (deduplicated)`);
});
