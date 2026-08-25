import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "devbox-startup-state-test-"));
process.env.DEVBOX_STARTUP_DIR = stateDir;

const {
  beginStartupState,
  cancelStartupState,
  clearStartupState,
  endStartupState,
  readAllStartupStates,
  readStartupState,
  updateStartupState,
} = await import("../dashboard/server/utils/devbox.js");

test("equivalence partitioning: updates for boxes 001 and 002 remain independently readable", () => {
  assert.equal(beginStartupState("001", "operation-001", { phase: "preflight", msg: "checking 001" }), true);
  assert.equal(beginStartupState("002", "operation-002", { phase: "preflight", msg: "checking 002" }), true);

  const all = readAllStartupStates();
  assert.equal(all["001"].operationId, "operation-001");
  assert.equal(all["001"].msg, "checking 001");
  assert.equal(all["002"].operationId, "operation-002");
  assert.equal(all["002"].msg, "checking 002");

  clearStartupState("001", "operation-001");
  clearStartupState("002", "operation-002");
});

test("state-machine domain analysis: an old operation cannot overwrite a newer operation for the same box", () => {
  assert.equal(beginStartupState("003", "operation-old", { phase: "preflight", msg: "old start" }), true);
  assert.equal(endStartupState("003", "operation-old", "failed", "old start ended"), true);
  assert.equal(beginStartupState("003", "operation-new", { phase: "preflight", msg: "new start" }), true);

  assert.equal(updateStartupState("003", "operation-old", { phase: "hunting", msg: "stale progress" }), false);
  assert.equal(endStartupState("003", "operation-old", "ready", "stale ready"), false);
  const current = readStartupState("003");
  assert.equal(current.operationId, "operation-new");
  assert.equal(current.phase, "preflight");
  assert.equal(current.msg, "new start");

  clearStartupState("003", "operation-new");
});

test("error guessing: cancellation remains dominant over later progress and terminal ready writes from its operation", () => {
  assert.equal(beginStartupState("004", "operation-cancelled", { phase: "hunting", msg: "searching" }), true);
  assert.equal(cancelStartupState("004", "operation-cancelled"), true);

  assert.equal(updateStartupState("004", "operation-cancelled", { phase: "creating", msg: "late create" }), false);
  assert.equal(endStartupState("004", "operation-cancelled", "ready", "late ready"), false);
  const cancelled = readStartupState("004");
  assert.equal(cancelled.operationId, "operation-cancelled");
  assert.equal(cancelled.phase, "hunting");
  assert.equal(cancelled.msg, "searching");
  assert.equal(cancelled.cancelled, true);

  clearStartupState("004", "operation-cancelled");
});

test("concurrency interleaving: cancellation survives a delayed progress publication prepared before cancellation", () => {
  assert.equal(beginStartupState("003", "operation-racing", { phase: "hunting", msg: "searching" }), true);
  const stateReadBeforeCancel = JSON.parse(readFileSync(join(stateDir, "003.json"), "utf8"));
  assert.equal(stateReadBeforeCancel.operationId, "operation-racing");

  assert.equal(cancelStartupState("003", "operation-racing"), true);
  assert.equal(existsSync(join(stateDir, "003.cancel.json")), true);
  writeFileSync(join(stateDir, "003.json"), JSON.stringify({
    operationId: "operation-racing",
    phase: "creating",
    msg: "delayed create progress",
    timestamp: 4102444800000,
  }));

  const afterDelayedProgress = readStartupState("003");
  assert.equal(afterDelayedProgress.operationId, "operation-racing");
  assert.equal(afterDelayedProgress.cancelled, true);
  assert.equal(updateStartupState("003", "operation-racing", { phase: "installing", msg: "even later progress" }), false);
  assert.equal(clearStartupState("003", "operation-racing"), true);
  assert.equal(existsSync(join(stateDir, "003.cancel.json")), false);
});

test("combinatorial concurrency: a second operation cannot claim a box already owned by a live operation", () => {
  assert.equal(beginStartupState("001", "operation-owner", { phase: "preflight", msg: "owner" }), true);

  assert.equal(beginStartupState("001", "operation-contender", { phase: "preflight", msg: "contender" }), false);
  const owner = readStartupState("001");
  assert.equal(owner.operationId, "operation-owner");
  assert.equal(owner.phase, "preflight");
  assert.equal(owner.msg, "owner");

  clearStartupState("001", "operation-owner");
});

test("boundary value analysis: repeated operations reuse one bounded state file and one cancellation file per box", () => {
  assert.equal(beginStartupState("002", "operation-one", { phase: "preflight", msg: "first" }), true);
  assert.equal(cancelStartupState("002", "operation-one"), true);
  assert.equal(clearStartupState("002", "operation-one"), true);
  assert.equal(beginStartupState("002", "operation-two", { phase: "preflight", msg: "second" }), true);
  assert.equal(cancelStartupState("002", "operation-two"), true);
  assert.equal(clearStartupState("002", "operation-two"), true);
  assert.equal(beginStartupState("002", "operation-three", { phase: "preflight", msg: "third" }), true);

  assert.deepEqual(readdirSync(stateDir).sort(), ["002.json"]);
  assert.equal(JSON.parse(readFileSync(join(stateDir, "002.json"), "utf8")).operationId, "operation-three");

  clearStartupState("002", "operation-three");
});

test("error guessing: atomic publication leaves no temporary files visible after an update", () => {
  assert.equal(beginStartupState("003", "operation-atomic", { phase: "preflight", msg: "before" }), true);
  assert.equal(updateStartupState("003", "operation-atomic", { phase: "hunting", msg: "after" }), true);

  assert.equal(existsSync(join(stateDir, "003.json")), true);
  assert.deepEqual(readdirSync(stateDir).filter((name) => name.includes(".tmp")), []);
  assert.equal(JSON.parse(readFileSync(join(stateDir, "003.json"), "utf8")).msg, "after");

  clearStartupState("003", "operation-atomic");
});

test("equivalence partitioning: an unknown box name cannot create startup state", () => {
  assert.equal(beginStartupState("005", "operation-invalid-box", { phase: "preflight", msg: "invalid" }), false);
});

test("boundary value analysis: an empty operation ID cannot claim a valid box", () => {
  assert.equal(beginStartupState("001", "", { phase: "preflight", msg: "missing identity" }), false);
});

test("state-machine domain analysis: a different operation cannot cancel or clear the current owner", () => {
  assert.equal(beginStartupState("004", "operation-owner", { phase: "preflight", msg: "owner" }), true);

  assert.equal(cancelStartupState("004", "operation-stranger"), false);
  assert.equal(clearStartupState("004", "operation-stranger"), false);
  assert.equal(readStartupState("004").operationId, "operation-owner");

  clearStartupState("004", "operation-owner");
});

test("error guessing: one partially written box file is ignored without hiding another box", () => {
  writeFileSync(join(stateDir, "001.json"), "{\"operationId\":");
  writeFileSync(join(stateDir, "002.json"), JSON.stringify({
    operationId: "operation-valid",
    phase: "hunting",
    msg: "still visible",
    timestamp: 4102444800000,
  }));

  const all = readAllStartupStates();
  assert.equal(all["001"], undefined);
  assert.equal(all["002"].operationId, "operation-valid");
  assert.equal(all["002"].msg, "still visible");

  clearStartupState("002", "operation-valid");
});
