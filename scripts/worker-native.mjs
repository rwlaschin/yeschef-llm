#!/usr/bin/env node
// The BAREMETAL worker: worker/index.js as a plain host process, no Docker.
//
// This replaces a hand-typed `node -e '…process.env.OLLAMA_HOST="http://localhost:11434"…'` that
// had its target BAKED INTO THE LAUNCH ARGS. That is the bug this file exists to prevent: editing
// .env.dev or running `pm2 restart` changed nothing, because the value never came from the
// environment in the first place. Everything here is read at boot from .env / .env.dev, so the
// target moves when the config moves.
//
// Ollama runs wherever WORKER_OLLAMA_HOST points — the Mac's own Ollama.app
// (http://host.docker.internal:11434 / http://localhost:11434) or a GCE devbox
// (http://ollama-001.dev.yeschef.life:11434, see scripts/devbox.js). Same worker either way.
import dotenvFlow from "dotenv-flow";
dotenvFlow.config({ node_env: process.env.NODE_ENV || "dev" });

const {
  WORKER_OLLAMA_HOST = "http://localhost:11434",
  WORKER_MODEL = "llama3.1:8b",
  WORKER_SUBSCRIPTION = "sub_llama3_1_8b_v1",
  PUBSUB_EMULATOR_HOST = "localhost:8185",
} = process.env;

// worker/index.js reads OLLAMA_HOST; the dev-side name is WORKER_OLLAMA_HOST (the same handoff
// waker.js does when it passes the value into a container).
process.env.OLLAMA_HOST = WORKER_OLLAMA_HOST;
process.env.OLLAMA_MODEL = WORKER_MODEL;
process.env.SUBSCRIPTION_NAME = WORKER_SUBSCRIPTION;
process.env.PUBSUB_EMULATOR_HOST = PUBSUB_EMULATOR_HOST;

console.log(`[worker-native] ${WORKER_MODEL} @ ${WORKER_OLLAMA_HOST}  sub=${WORKER_SUBSCRIPTION}  pubsub=${PUBSUB_EMULATOR_HOST}`);
await import("../worker/index.js");
