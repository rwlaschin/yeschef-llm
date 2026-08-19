// GUARD: a deployed Cloud Function has NO Ollama. /ai/categorize once called Ollama over HTTP
// directly and returned 500 in production for every request. INVARIANT: only a worker talks to
// Ollama; a function publishes a job. This test walks every deployed .js under functions/ and
// fails if any of them names Ollama's port, host env var, or inference endpoints.
import { test } from "node:test";
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const BANNED = ["11434", "OLLAMA_HOST", "/api/chat", "/api/generate"];

// Deployed source only: node_modules is vendored, tests aren't deployed, and symlinked dirs
// (e.g. a linked local package) belong to whatever they point at, not to functions/.
function deployedFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      deployedFiles(p, out);
    } else if (e.name.endsWith(".js") && !e.name.endsWith(".test.js")) {
      out.push(p);
    }
  }
  return out;
}

test("no function talks to Ollama directly", () => {
  const violations = [];
  for (const file of deployedFiles(ROOT)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const needle of BANNED) {
        if (line.includes(needle)) violations.push(`${file.slice(ROOT.length + 1)}:${i + 1}  [${needle}]  ${line.trim()}`);
      }
    });
  }
  assert.deepStrictEqual(
    violations, [],
    `Functions must NOT call Ollama — publish a job to a worker instead:\n${violations.join("\n")}`
  );
});
