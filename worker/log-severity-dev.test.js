import test from "node:test";
import assert from "node:assert/strict";

// Lives under worker/ for the same reason as log-severity.test.js: the test glob is
// "worker/**" + "functions/**" and does not follow the functions/config symlink.
//
// Separate file from log-severity.test.js because config/log-severity.js reads NODE_ENV at MODULE
// LOAD, not per call — the two modes need two module instances, so the dev instance is imported once
// here behind a cache-busting query while NODE_ENV is temporarily "dev", then NODE_ENV is restored.
const savedNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "dev";
const { installSeverityLogging } = await import("../config/log-severity.js?mode=dev");
if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = savedNodeEnv;

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

// Equivalence partitioning: plain single-line string, the nominal logd case.
test("dev: console.error emits a bare ERR head token, no JSON wrapper", () => {
  const { c, out } = fake();
  c.error("boom");
  assert.equal(out.error[0], "ERR boom");
});

test("dev: console.warn emits a bare WRN head token, no JSON wrapper", () => {
  const { c, out } = fake();
  c.warn("careful");
  assert.equal(out.warn[0], "WRN careful");
});

// Boundary analysis on line count (1 line vs many): logd splits an ingested batch on newlines and
// reads the token at the START of each physical line, so line 1..n must each carry it, not just 0.
test("dev: a two-line error carries ERR on the second line as well as the first", () => {
  const { c, out } = fake();
  c.error("Error: boom\n    at x (y.js:1)");
  assert.equal(out.error[0], "ERR Error: boom\nERR     at x (y.js:1)");
});

test("dev: a three-line warning carries WRN on every physical line", () => {
  const { c, out } = fake();
  c.warn("slow response\n  model: llama3\n  waited: 30s");
  assert.equal(out.warn[0], "WRN slow response\nWRN   model: llama3\nWRN   waited: 30s");
});

// Boundary analysis on arg count (1 vs many): multiple args stay ONE message, token once per line.
test("dev: two args are joined into one ERR line", () => {
  const { c, out } = fake();
  c.error("cause:", { code: "ECONNRESET" });
  assert.equal(out.error[0], 'ERR cause: {"code":"ECONNRESET"}');
});

test("dev: a multi-line first arg plus a second arg tokenizes the joined text once per line", () => {
  const { c, out } = fake();
  c.error("line one\nline two", "tail");
  assert.equal(out.error[0], "ERR line one\nERR line two tail");
});

// Equivalence class: Error instance goes through render() and keeps its stack.
test("dev: an Error instance renders its stack with ERR on the first line", () => {
  const { c, out } = fake();
  c.error(new Error("kaboom"));
  assert.equal(out.error.length, 1);
  assert.match(out.error[0], /^ERR Error: kaboom\n/);
  assert.match(out.error[0], /log-severity-dev\.test\.js/); // the stack survived intact
});

test("dev: no line of a rendered Error stack is left without the ERR token", () => {
  const { c, out } = fake();
  c.error(new Error("kaboom"));
  assert.doesNotMatch(out.error[0], /\n(?!ERR )/);
});

// Domain analysis: the structured-telemetry rule wins over the dev-token rule. prod-smoke.mjs reads
// these capacityEvent/workerEvent entries out of Cloud Logging, so they must stay JSON everywhere.
test("dev: an already-structured JSON payload keeps its fields and gains severity", () => {
  const { c, out } = fake();
  c.error(JSON.stringify({ message: "[capacity] reconcile failed", capacityEvent: "reconcile_failed", model: "x" }));
  const p = JSON.parse(out.error[0]);
  assert.equal(p.severity, "ERROR");
  assert.equal(p.capacityEvent, "reconcile_failed");
  assert.equal(p.model, "x");
  assert.equal(p.message, "[capacity] reconcile failed");
});

test("dev: a structured JSON payload is NOT prefixed with the ERR token", () => {
  const { c, out } = fake();
  c.error(JSON.stringify({ workerEvent: "started" }));
  assert.equal(out.error[0], '{"severity":"ERROR","workerEvent":"started"}');
});

// Error guessing: a "{" that is not JSON must fall through to the plain wrap, not throw.
test("dev: a string that merely starts with { but is not JSON is tokenized as plain text", () => {
  const { c, out } = fake();
  c.error("{not json at all");
  assert.equal(out.error[0], "ERR {not json at all");
});
