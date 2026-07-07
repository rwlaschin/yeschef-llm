// ============================================================
// Dev Waker — emulates the prod GCE MIG autoscaler, for MULTIPLE models.
//
// Watches each model's Pub/Sub *emulator* subscription. When a message is waiting
// AND that model's worker container is down, it `docker start`s the pre-baked
// image (Ollama + worker + model). It NEVER acks/consumes — the worker inside the
// container is the sole consumer that pulls + acks.
//
// Models come from WAKER_MODELS (JSON array of { subscription, image, container,
// model }). Falls back to single-model env vars if WAKER_MODELS is unset.
//
// Prod equivalent: a MIG autoscaler per model, scaling spot GPU VMs on the
// `num_undelivered_messages` metric. Here, `docker start` stands in.
//
// Dev-only: requires PUBSUB_EMULATOR_HOST.
// Re-test cold start with:  docker stop <container>
// ============================================================

import pubsubLib from "@google-cloud/pubsub";
import { execSync, spawn } from "child_process";
import { setTimeout as sleep } from "timers/promises";

const { PubSub, v1 } = pubsubLib;

const {
  GCP_PROJECT_ID,
  PUBSUB_EMULATOR_HOST,
  WAKER_MODELS,
  WAKER_POLL_MS = "3000",
  // shared, passed through to every container
  MONGO_URI,
  MONGO_DB,
  MONGO_COLLECTION,
  FIREBASE_PROJECT_ID,
  GOOGLE_APPLICATION_CREDENTIALS, // SA key for writing to PROD Firestore in dev
  OLLAMA_API_KEY, // web search creds for the ollama/openclaw runtime (command-line), not the worker
  BRAVE_API_KEY,  // optional web_search pool provider (search-pool.js)
  TAVILY_API_KEY, // optional web_search pool provider (search-pool.js)
  OPENCLAW_GATEWAY_TOKEN, // shared bearer token for the OpenClaw gateway (gateway tiers)
  NODE_ENV = "dev", // forwarded to the worker → loads inactive prompt_library entries in dev
  DOCKER_GPU, // e.g. "all" if an NVIDIA GPU is present; leave unset on Mac (CPU)
} = process.env;

const pollMs = parseInt(WAKER_POLL_MS, 10);

// Model list comes from WAKER_MODELS (JSON). Required — no fallback.
function resolveModels() {
  if (!WAKER_MODELS) throw new Error("WAKER_MODELS not set — required, no fallback");
  return JSON.parse(WAKER_MODELS);
}

function sh(cmd) {
  return execSync(cmd, { stdio: "pipe" }).toString().trim();
}

function containerRunning(container) {
  try {
    return !!sh(`docker ps -q --filter name=^${container}$ --filter status=running`);
  } catch {
    return false;
  }
}

// Exit code of a stopped container with this name ("0" = clean, "" = no such
// container). Lets the waker tell a crash from a normal/cold state.
function lastExitCode(container) {
  try {
    return sh(`docker inspect -f '{{.State.ExitCode}}' ${container}`);
  } catch {
    return "";
  }
}

function logsTail(container, n = 25) {
  try {
    return sh(`docker logs --tail ${n} ${container} 2>&1`);
  } catch {
    return "";
  }
}

// Stream a container's stdout/stderr into THIS process's console (prefixed), so the
// worker's [worker] logs are visible in `npm run dev` instead of hidden in the container.
// `docker run -d` is detached; without this you're blind to the entire LLM stage.
const logStreams = new Map(); // container -> child process running `docker logs -f`
function streamLogs(container, label) {
  const prior = logStreams.get(container); // replace any stale follower (e.g. previous run)
  if (prior) { try { prior.kill(); } catch { /* already gone */ } }

  // Fresh container each wake (we docker rm -f + run), so `--tail all` = its whole life:
  // Ollama boot, model load, cold-start errors, then the [worker] job logs.
  const child = spawn("docker", ["logs", "-f", "--tail", "all", container], { stdio: ["ignore", "pipe", "pipe"] });
  const prefix = `\x1b[35m[${label}]\x1b[0m `; // magenta so worker lines stand out from waker/functions

  // llama.cpp (Ollama's embedded runner) is a firehose: a full model-metadata dump
  // on cold start (print_info:/load_tensors:/llama_model_loader:…) and an access line
  // per request (srv/slot …). None of it is actionable — it just buries the [worker]
  // job logs. Drop those prefixes by default; WAKER_VERBOSE=1 shows the raw firehose
  // for debugging a model-load failure. The error|warn|fail guard means we never hide
  // a real problem even if it rode in on a noisy prefix.
  const VERBOSE = process.env.WAKER_VERBOSE === "1";
  const NOISE = /^(srv\s|slot\s|print_info:|load_tensors:|load:\s|llama_model_loader:|llama_(context|kv_cache|memory|model_load|init)|graph_reserve:|set_n_threads:|system_info:|build:\s|main:\s|init:\s|common_init)/;
  const pump = (stream) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!VERBOSE && NOISE.test(line) && !/error|warn|fail/i.test(line)) continue;
        console.log(prefix + line);
      }
    });
  };
  pump(child.stdout);
  pump(child.stderr);
  child.on("exit", () => { if (logStreams.get(container) === child) logStreams.delete(container); });
  logStreams.set(container, child);
}

function stopAllLogStreams() {
  for (const c of logStreams.values()) { try { c.kill(); } catch { /* ignore */ } }
  logStreams.clear();
}

// Tear down the worker containers the waker started. A worker is a long-lived process that
// loaded its code at container start, so a SURVIVING container keeps running STALE code no
// matter how the mounted source changes — it must be killed so the next run boots fresh. The
// waker OWNS these containers, so it kills them when it stops. Project-scoped by the
// `yeschef-worker-` name prefix (won't touch other projects' containers).
function killWorkerContainers() {
  try {
    const ids = sh(`docker ps -aq --filter name=yeschef-worker-`).split("\n").filter(Boolean);
    if (ids.length) sh(`docker rm -f ${ids.join(" ")}`);
  } catch { /* docker down, or nothing to remove */ }
}

function cleanupAndExit() {
  stopAllLogStreams();
  killWorkerContainers();
  process.exit(0);
}
process.on("SIGINT", cleanupAndExit);
process.on("SIGTERM", cleanupAndExit);

function startContainer(m) {
  // ALWAYS recreate from current config: remove any existing container (running or
  // exited) and `docker run` fresh. This guarantees the latest mounts/code/start.sh
  // are applied every time — no stale "docker start", no manual `docker rm -f`.
  try { sh(`docker rm -f ${m.container}`); } catch { /* nothing to remove */ }
  console.log(`[waker:${m.model}] starting fresh: docker run ${m.image}`);
  // Expose Ollama to the host so external tools (n8n scraper) can call it directly.
  // Set OLLAMA_HOST_PORT=11434 in .env.dev to enable. Only one container should bind
  // a given port — in dev only one model runs at a time, so this is safe.
  const ollamaPortFlag = process.env.OLLAMA_HOST_PORT ? `-p ${process.env.OLLAMA_HOST_PORT}:11434` : '';
  const env = [
    `PUBSUB_EMULATOR_HOST=host.docker.internal:8185`,
    `GCP_PROJECT_ID=${GCP_PROJECT_ID}`,
    `SUBSCRIPTION_NAME=${m.subscription}`,
    `OLLAMA_MODEL=${m.model}`,
    `OLLAMA_HOST=http://localhost:11434`,
    `MONGO_URI=${MONGO_URI}`,
    `MONGO_DB=${MONGO_DB}`,
    `MONGO_COLLECTION=${MONGO_COLLECTION}`,
    `FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID || GCP_PROJECT_ID}`,
    `NODE_ENV=${NODE_ENV}`,
  ];
  if (OLLAMA_API_KEY) env.push(`OLLAMA_API_KEY=${OLLAMA_API_KEY}`);
  if (BRAVE_API_KEY) env.push(`BRAVE_API_KEY=${BRAVE_API_KEY}`);
  if (TAVILY_API_KEY) env.push(`TAVILY_API_KEY=${TAVILY_API_KEY}`);
  if (m.gateway) {
    env.push(`GATEWAY=${m.gateway}`);
    if (OPENCLAW_GATEWAY_TOKEN) env.push(`OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}`);
  }
  if (GOOGLE_APPLICATION_CREDENTIALS) env.push(`GOOGLE_APPLICATION_CREDENTIALS=/secrets/sa.json`);
  const envFlags = env.map((e) => `-e ${e}`).join(" ");
  const credMount = GOOGLE_APPLICATION_CREDENTIALS
    ? `-v "${GOOGLE_APPLICATION_CREDENTIALS}":/secrets/sa.json:ro`
    : "";
  const gpuFlag = DOCKER_GPU ? `--gpus ${DOCKER_GPU}` : "";
  // Mount live worker code + start.sh over the baked copies so edits apply on a
  // container restart — no image rebuild needed in dev.
  const workerMount = `-v "${process.cwd()}/worker":/app/worker`;
  const configMount = `-v "${process.cwd()}/config":/app/config`; // shared config/models.js (subtypes, tools)
  const startMount = `-v "${process.cwd()}/docker/common/start.sh":/start.sh`;
  // The ollama base image sets ENTRYPOINT ["ollama"]; override it. Run the script
  // explicitly as `sh /start.sh` so it works even when the bind-mounted file lacks
  // the execute bit (a plain `--entrypoint /start.sh` fails with "permission denied").
  sh(
    `docker run -d --name ${m.container} --entrypoint sh ` +
      `--add-host=host.docker.internal:host-gateway ` +
      `${gpuFlag} ${ollamaPortFlag} ${envFlags} ${credMount} ${workerMount} ${configMount} ${startMount} ${m.image} /start.sh`
  );
  // Pipe this container's logs into the dev console so worker [worker]/Ollama output is
  // visible live (not buried in `docker logs`). Follows the fresh container we just ran.
  streamLogs(m.container, m.model);
}

async function hasBacklog(subClient, subPath) {
  const [res] = await subClient.pull({ subscription: subPath, maxMessages: 1, returnImmediately: true });
  const msgs = res.receivedMessages || [];
  if (msgs.length === 0) return false;
  await subClient.modifyAckDeadline({
    subscription: subPath,
    ackIds: msgs.map((m) => m.ackId),
    ackDeadlineSeconds: 0, // release immediately so the worker can pull it
  });
  return true;
}

async function main() {
  if (!PUBSUB_EMULATOR_HOST) {
    throw new Error("PUBSUB_EMULATOR_HOST not set — the waker is a dev-only emulation");
  }
  const models = resolveModels();
  // Build the low-level subscriber client from the high-level PubSub class's own
  // emulator-aware options (servicePath/port/insecure SSL, derived from
  // PUBSUB_EMULATOR_HOST). This reuses the library's exact logic and avoids the
  // gax ":443" endpoint-parsing pitfall.
  const pubsub = new PubSub({ projectId: GCP_PROJECT_ID });
  const subClient = new v1.SubscriberClient(pubsub.options);

  console.log(`[waker] emulator ${PUBSUB_EMULATOR_HOST}; watching ${models.length} model(s):`);
  for (const m of models) console.log(`  - ${m.model}  (${m.subscription} → ${m.container})`);
  console.log(`[waker] prod equivalent → GCE MIG autoscaler per model on Pub/Sub backlog\n`);

  const crash = new Map(); // container -> { fails, until } for crash backoff

  for (;;) {
    for (const m of models) {
      try {
        if (containerRunning(m.container)) {
          crash.delete(m.container); // healthy → reset crash tracking
          continue; // worker owns its sub while up
        }

        // Respect a crash backoff window so a broken worker isn't hammered + spammed every poll.
        const st = crash.get(m.container);
        if (st && Date.now() < st.until) continue;

        const subPath = subClient.subscriptionPath(GCP_PROJECT_ID, m.subscription);
        if (!(await hasBacklog(subClient, subPath))) continue;

        // Surface a previous crash (non-zero exit) with its logs, so failures are
        // visible here instead of requiring a manual `docker logs`.
        const exit = lastExitCode(m.container);
        if (exit && exit !== "0") {
          const fails = (st?.fails || 0) + 1;
          const backoffMs = Math.min(30000, 3000 * fails);
          crash.set(m.container, { fails, until: Date.now() + backoffMs });
          console.error(`[waker:${m.model}] worker exited code ${exit} (attempt ${fails}). Last logs:`);
          for (const line of logsTail(m.container).split("\n")) console.error(`    ${line}`);
          console.error(`[waker:${m.model}] retrying after ${backoffMs / 1000}s backoff`);
        }

        console.log(`[waker:${m.model}] backlog detected → waking worker`);
        startContainer(m);
      } catch (err) {
        console.error(`[waker:${m.model}] error:`, err.message);
      }
    }
    await sleep(pollMs);
  }
}

main().catch((e) => {
  console.error("[waker] fatal:", e.message);
  process.exit(1);
});
