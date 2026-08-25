import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

const { finishCliResult, modelArg } = await import("../dashboard/server/utils/devbox.js");

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
