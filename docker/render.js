// Single source of truth for rendering Dockerfile.ejs.
// Both scripts/dev.js and scripts/deploy.js import this — never inline ejs.render locally.
//
// Required vars: name, model, gpu, parallel, maxQueue, subscription, gateway
// Optional: baseImage — when set (deploy.js only), FROMs the shared pre-built base instead
// of ollama/ollama:latest + inline apt-get (see docker/Dockerfile.base).
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import ejs from "ejs";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "Dockerfile.ejs");

export function renderDockerfile(vars) {
  return ejs.render(readFileSync(TEMPLATE_PATH, "utf-8"), vars);
}
