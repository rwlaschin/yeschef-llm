import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPLOY_SOURCE = fs.readFileSync(join(HERE, "deploy.js"), "utf8");
const DEV_SOURCE = fs.readFileSync(join(HERE, "dev.js"), "utf8");

test("error guessing: production deployment ignores an ambient OLLAMA_NUM_PARALLEL override", () => {
  assert.doesNotMatch(
    DEPLOY_SOURCE,
    /parallel:\s*process\.env\.OLLAMA_NUM_PARALLEL/,
    "deploy must derive each image's parallel value from its model, even when the shell has a stale global override",
  );
});

test("domain analysis: production deployment derives each image capacity from its model", () => {
  assert.match(DEPLOY_SOURCE, /parallel:\s*parallelOf\(m\)/);
});

test("error guessing: local development ignores an ambient OLLAMA_NUM_PARALLEL override", () => {
  assert.doesNotMatch(
    DEV_SOURCE,
    /parallel:\s*process\.env\.OLLAMA_NUM_PARALLEL/,
    "dev must not let a machine-wide environment value replace a model's declared capacity",
  );
});

test("domain analysis: local development derives each image capacity from its model", () => {
  assert.match(DEV_SOURCE, /parallel:\s*parallelOf\(m\)/);
});
