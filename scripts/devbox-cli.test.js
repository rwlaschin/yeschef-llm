import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { finishCliResult, modelArg, fail, DevboxFailure } = await import("../dashboard/server/utils/devbox.js");

afterEach(() => { process.exitCode = undefined; });

test("CLI contract: a structured start failure is printed and exits nonzero", () => {
  const errors = [];
  const ok = finishCliResult({ ok: false, message: "BLOCKED: ADC unavailable" }, { error: (line) => errors.push(line) });

  assert.equal(ok, false);
  assert.equal(process.exitCode, 1);
  assert.deepEqual(errors, ["BLOCKED: ADC unavailable"]);
});

test("CLI contract: positional and named model arguments resolve consistently", () => {
  assert.equal(modelArg(["node", "devbox.js", "create", "001", "llama3.1:8b"]), "llama3.1:8b");
  assert.equal(modelArg(["node", "devbox.js", "create", "001", "--model=qwen3:8b"]), "qwen3:8b");
});

// REAL FAILURE 2026-09-01: `npm run box chat 001` against a box that had stopped answering printed
// no diagnosis at all — it threw "ReferenceError: fail is not defined" from devbox.js:1253. fail()
// was called from 17 places and declared in none, so EVERY operator-facing error path in the CLI
// was dead, including the two that warn "The box is RUNNING and BILLING but unusable".
test("CLI contract: fail raises a tagged failure carrying the operator message", () => {
  assert.throws(() => fail("yc-ollama-001 is not answering at http://10.0.0.1:11434."), (err) => {
    assert.ok(err instanceof DevboxFailure);
    assert.equal(err.devboxFailure, true);       // what runCli keys on to print one line, not a stack
    assert.equal(err.message, "yc-ollama-001 is not answering at http://10.0.0.1:11434.");
    return true;
  });
});

// The class of bug, not just the one instance: a helper called but never declared is invisible
// until an operator hits that branch, because this package has no eslint and node parses the file
// fine. Comments and string literals are stripped first — prose like "a spot (" otherwise reads as
// a call to `spot`.
test("CLI contract: every helper the module calls is actually declared in it", () => {
  const raw = fs.readFileSync(new URL("../dashboard/server/utils/devbox.js", import.meta.url), "utf8");
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, '""');

  const declared = new Set();
  const add = (names) => { for (const n of names.split(",")) declared.add(n.trim().split(/\s+as\s+/).pop().replace(/[{}\[\]]/g, "").split(/[:=]/)[0].trim()); };
  for (const re of [
    /(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g,
    /(?:import|const|let|var)\s*\{([^}]+)\}/g,          // named imports and destructured bindings
    /\{([^{}]*)\}\s*=/g,                                 // destructured params with defaults
    /([A-Za-z_$][\w$]*)\s*(?:=|:)\s*(?:async\s*)?\(/g,  // arrow-function and object-method properties
    /async\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\(([^()]*)\)\s*=>/g,                                // arrow parameters
  ]) for (const m of code.matchAll(re)) add(m[1]);

  const globals = new Set(["require", "fetch", "Number", "String", "Boolean", "Object", "Array", "JSON", "Math", "Date", "Set", "Map", "Error", "Promise", "RegExp", "parseInt", "parseFloat", "isNaN", "console", "process", "setTimeout", "clearTimeout", "structuredClone", "Infinity", "if", "for", "while", "switch", "catch", "return", "typeof", "await", "async", "function", "new", "super", "this", "do", "else", "constructor"]);
  const called = new Set();
  for (const m of code.matchAll(/(?:^|[^.\w$])([a-z_$][\w$]*)\s*\(/gm)) called.add(m[1]);

  const undeclared = [...called].filter((name) => !declared.has(name) && !globals.has(name));
  assert.deepEqual(undeclared, [], `called but never declared in devbox.js: ${undeclared.join(", ")}`);
});
