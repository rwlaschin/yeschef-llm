// END-TO-END: the REAL worker/index.js against the Pub/Sub emulator on the fake/canned path.
// No Ollama, no GPU, no GCE. This is the check the unit tests cannot make: that the actual subscriber
// wiring drains a backlog of >1 and survives between messages.
//
// Asserts:
//   1. the worker boots and reports its lease bound == generation slots (the P1 fix, from the real log)
//   2. THREE messages published while it is running are ALL acked  (P1-1: nothing stranded)
//   3. the process is still alive and listening afterwards          (P1-2: it keeps pulling)
import { spawn } from "node:child_process";
import { PubSub } from "@google-cloud/pubsub";
import dotenvFlow from "dotenv-flow";

process.env.NODE_ENV = "dev";
dotenvFlow.config({ path: process.argv[2] || "." });

const EMU = "localhost:8185";
const PROJECT = process.env.GCP_PROJECT_ID || "yeschef-c572a";
// A DEDICATED topic+subscription per run. Sharing sub_fake_canned_v1 means the dev stack's own
// workers compete for these messages — a message consumed by one of them looks exactly like a
// stranded message here, which is a false P1. The canned path is keyed on payload.fake, not on the
// subscription name, so a private subscription still exercises the fake path end to end.
const TOPIC = `e2e_lease_${process.pid}`;
const SUB = `sub_${TOPIC}`;
const N = 3;

const env = {
  ...process.env,
  NODE_ENV: "dev",
  PUBSUB_EMULATOR_HOST: EMU,
  GCP_PROJECT_ID: PROJECT,
  SUBSCRIPTION_NAME: SUB,
  OLLAMA_NUM_PARALLEL: "1",
  MAX_CONCURRENCY: "2",           // deliberately set: must be IGNORED and logged as such
};

const admin = new PubSub({ projectId: PROJECT, apiEndpoint: `http://${EMU}` });
const [topicObj] = await admin.createTopic(TOPIC);
await topicObj.createSubscription(SUB, { ackDeadlineSeconds: 60 });
console.log(`✓ dedicated ${TOPIC} / ${SUB} created (no competing consumers)`);

const lines = [];
const worker = spawn("node", ["worker/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
const collect = (b) => String(b).split("\n").filter(Boolean).forEach((l) => lines.push(l));
worker.stdout.on("data", collect);
worker.stderr.on("data", collect);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const seen = (re) => lines.some((l) => re.test(l));
const waitFor = async (re, ms, label) => {
  for (let i = 0; i < ms / 250; i++) { if (seen(re)) return true; await wait(250); }
  console.log(`  ✗ timeout waiting for ${label}`);
  return false;
};

const fail = [];
try {
  if (!(await waitFor(/Listening|listening/, 60_000, "the worker to listen"))) {
    console.log("worker output so far:");
    lines.slice(-25).forEach((l) => console.log("   ", l.slice(0, 160)));
    throw new Error("worker never started listening");
  }
  console.log("✓ worker booted and is listening");

  // 1. the lease bound, straight out of the real boot log
  const flow = lines.find((l) => l.includes("Flow control:"));
  const gate = lines.find((l) => l.includes("generation gate:"));
  console.log("  " + flow?.trim());
  console.log("  " + gate?.trim());
  if (!/maxMessages=1\b/.test(flow || "")) fail.push(`lease bound is not 1: ${flow}`);
  if (!seen(/MAX_CONCURRENCY=2 is IGNORED/)) fail.push("MAX_CONCURRENCY was not reported as ignored");

  // 2. publish a backlog of N and require every one to be acked
  const ps = admin;
  const ids = [];
  for (let i = 0; i < N; i++) {
    const jobId = `e2e-lease-${process.pid}-${i}`;
    ids.push(jobId);
    await ps.topic(TOPIC).publishMessage({
      data: Buffer.from(JSON.stringify({
        jobId, query: `e2e backlog probe ${i}`, type: "task", subtype: "", model: TOPIC, fake: true, style: "structured",
      })),
    });
  }
  console.log(`✓ published ${N} messages to ${TOPIC}`);

  const acked = async () => ids.filter((id) => seen(new RegExp(`acked ${id}`))).length;
  for (let i = 0; i < 240 && (await acked()) < N; i++) await wait(500);
  const got = await acked();
  console.log(`${got === N ? "✓" : "✗"} acked ${got}/${N} messages`);
  if (got !== N) fail.push(`only ${got}/${N} messages were acked — the backlog stranded ${N - got}`);

  // 3. still alive and still listening after draining
  await wait(1500);
  const alive = worker.exitCode === null && !worker.killed;
  console.log(`${alive ? "✓" : "✗"} worker still alive after draining (exitCode=${worker.exitCode})`);
  if (!alive) fail.push("worker died after processing the backlog");
  if (seen(/subscription CLOSED|close-giving-up/)) fail.push("subscriber closed during the run");
} catch (e) {
  fail.push(e.message);
} finally {
  worker.kill("SIGKILL");
  await admin.subscription(SUB).delete().catch(() => {});
  await admin.topic(TOPIC).delete().catch(() => {});
}

console.log();
if (fail.length) {
  console.log("E2E FAILED:");
  fail.forEach((f) => console.log("  -", f));
  console.log("\nlast 30 worker lines:");
  lines.slice(-30).forEach((l) => console.log("   ", l.slice(0, 170)));
  process.exit(1);
}
console.log("E2E PASSED — real worker drained a 3-message backlog and stayed alive");
