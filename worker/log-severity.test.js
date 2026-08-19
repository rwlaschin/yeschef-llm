import test from "node:test";
import assert from "node:assert/strict";
import { installSeverityLogging } from "../config/log-severity.js";

// Lives under worker/ (not next to the source in config/) because the test glob is
// "worker/**" + "functions/**" and does not follow the functions/config symlink.

// A fake console so the shim can be exercised without polluting the real one.
const fake = () => {
  const out = { error: [], warn: [], log: [] };
  const c = {
    error: (...a) => out.error.push(a.join(" ")),
    warn: (...a) => out.warn.push(a.join(" ")),
    log: (...a) => out.log.push(a.join(" ")),
  };
  installSeverityLogging(c);
  return { c, out };
};

test("console.error emits ERROR severity as JSON", () => {
  const { c, out } = fake();
  c.error("[worker] ✗ FAILED job abc: boom");
  const p = JSON.parse(out.error[0]);
  assert.equal(p.severity, "ERROR");
  assert.equal(p.message, "[worker] ✗ FAILED job abc: boom");
});

test("console.warn emits WARNING severity", () => {
  const { c, out } = fake();
  c.warn("slow response");
  assert.equal(JSON.parse(out.warn[0]).severity, "WARNING");
});

test("console.log is left alone — INFO is already correct for it", () => {
  const { c, out } = fake();
  c.log("[worker] ■ done abc in 900ms");
  assert.equal(out.log[0], "[worker] ■ done abc in 900ms");
});

// The SIGTERM handler prints a whole stack. Unwrapped, the agent split it into one entry per line,
// which is why a clean shutdown showed a bare "Error" row that read like a crash.
test("a multi-line stack stays in ONE entry", () => {
  const { c, out } = fake();
  c.error(new Error("kaboom"));
  assert.equal(out.error.length, 1);
  const p = JSON.parse(out.error[0]);
  assert.equal(p.severity, "ERROR");
  assert.match(p.message, /kaboom/);
  assert.match(p.message, /log-severity\.test\.js/); // the stack survived intact
});

test("an already-structured JSON payload keeps its fields and gains severity", () => {
  const { c, out } = fake();
  c.error(JSON.stringify({ message: "[capacity] reconcile failed", capacityEvent: "reconcile_failed", model: "x" }));
  const p = JSON.parse(out.error[0]);
  assert.equal(p.severity, "ERROR");
  assert.equal(p.capacityEvent, "reconcile_failed");
  assert.equal(p.model, "x");
  assert.equal(p.message, "[capacity] reconcile failed");
});

test("multiple args are joined into one message", () => {
  const { c, out } = fake();
  c.error("cause:", { code: "ECONNRESET" });
  const p = JSON.parse(out.error[0]);
  assert.equal(p.message, 'cause: {"code":"ECONNRESET"}');
});

test("a string that merely starts with { but is not JSON does not throw", () => {
  const { c, out } = fake();
  c.error("{not json at all");
  assert.equal(JSON.parse(out.error[0]).message, "{not json at all");
});
