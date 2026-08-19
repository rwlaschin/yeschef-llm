// Does the box actually GENERATE N at once, or does it take one and queue the rest?
//
// This is the only question OLLAMA_NUM_PARALLEL exists to answer, and it cannot be answered offline:
// the Pub/Sub emulator ignores flow control, and every other check in this repo asserts arithmetic
// about the number rather than the behaviour of the server. So this one talks to a real Ollama.
//
// The measurement is a race, not a counter. Fire N identical requests at the same instant and compare
// the wall clock of the slowest against the wall clock of a single request run alone:
//   • served in parallel → total ≈ 1× solo (they overlap)
//   • still serialised    → total ≈ N× solo (they queue)
// A counter can't distinguish those — Ollama accepts all N connections either way; only the timing
// separates "running" from "waiting for a slot".
//
//   node scripts/e2e-parallel-check.mjs [--host http://ollama-001.dev.yeschef.life:11434] [--n 3]
import { parallelOf, MODELS, maxCtxFor, CTX_HEADROOM } from "../config/models.js";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : d;
};

const HOST = arg("host", process.env.OLLAMA_HOST || "http://ollama-001.dev.yeschef.life:11434");
const MODEL = arg("model", "llama3.1:8b");
const N = parseInt(arg("n", String(parallelOf(MODELS.find((m) => m.model === MODEL)))), 10);
// Long enough that generation dominates and per-request overhead doesn't blur the two outcomes.
const TOKENS = parseInt(arg("tokens", "160"), 10);
// Omitted → Ollama's own default (4096), which is NOT what the worker sends. Pass the value
// worker/steps/step.js sizeNumCtx would produce to measure the shape a real job has.
const CTX = arg("ctx") ? parseInt(arg("ctx"), 10) : null;
// Usable VRAM. An L4 reports 23034 MiB of 24 GB, but the KV cache is not the only tenant: the CUDA
// context, the compute/batch buffers and fragmentation all take a cut. Clamping to 22 aimed the load
// at 22.0 GB of 22 — no headroom at all — so budget 20 and leave the card room to breathe.
const VRAM_GB = parseFloat(arg("vram-gb", "20"));

const die = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };

// The cap is maxCtxFor() from config/models.js — the SAME function worker/index.js caps with. A
// local copy of the KV arithmetic here would be a second number that can disagree with the one that
// actually runs, which is exactly how the gate and the lease drifted apart before (worker/lease.js).
function fitCtx(ctx, slots) {
  const model = MODELS.find((m) => m.model === MODEL);
  const kv = model?.kvBytesPerToken ?? 131072;
  const weights = model?.weightsGb ?? 5;
  const used = Math.min(ctx, maxCtxFor(model, slots, VRAM_GB));
  const kvGb = (used * slots * kv) / 1e9;
  console.log(`vram    ${(weights + kvGb).toFixed(1)} GB of ${VRAM_GB} usable (weights ${weights} + KV ${kvGb.toFixed(1)} for ${used} × ${slots} slots), headroom factor ${CTX_HEADROOM}`);
  if (used < ctx) console.log(`        CLAMPED ${ctx} → ${used}: ${ctx} × ${slots} would need ${(weights + (ctx * slots * kv) / 1e9).toFixed(1)} GB of KV+weights`);
  return used;
}

// Distinct prompts on purpose: identical ones can hit a prompt/prefix cache and finish instantly,
// which reads exactly like parallelism and would make this check pass on a serialised box.
const prompt = (i) => `Count from ${i * 1000} upward, one number per line. Do not stop early.`;

async function gen(i) {
  const t0 = Date.now();
  // Changing num_ctx makes Ollama RELOAD the model, and the reload drops in-flight connections —
  // which looks identical to a dead box. Retry once through a reload before believing it; only a
  // second failure is really "no box".
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      // /api/chat, NOT /api/generate — worker/ollama.js chatRound() posts to /api/chat, so the
      // template prefill and message shape here match what a real unit pays for.
      res = await fetch(`${HOST}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL, messages: [{ role: "user", content: prompt(i) }], stream: false,
          options: { num_predict: TOKENS, ...(CTX ? { num_ctx: ctx } : {}) },
        }),
      });
      break;
    } catch (e) {
      if (attempt) die(`cannot reach ${HOST} (${e.cause?.message || e.message}) — start a box first: node scripts/devbox.js start 001`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (!res.ok) die(`${HOST} returned ${res.status} — is the box up and the model pulled?`);
  await res.json();
  return Date.now() - t0;
}

console.log(`host   ${HOST}`);
console.log(`model  ${MODEL}, ${TOKENS} tokens, expecting ${N} slots, ctx ${CTX ?? "(ollama default 4096)"}`);
// Clamped BEFORE any request, so an oversized window is trimmed instead of OOMing mid-run.
const ctx = fitCtx(CTX ?? 4096, N);
console.log();

// Warm TWICE. Once is not enough: a num_ctx different from what is resident makes Ollama reload the
// model, and a reload lands mid-batch as a dropped connection + retry — which shows up as a 5s
// "stagger" and gets misread as queueing. The first warm triggers any reload, the second proves the
// server is settled at this ctx before a single number is timed.
process.stdout.write("warming… ");
await gen(998);
await gen(999);
console.log("done");

process.stdout.write("solo request… ");
const solo = await gen(0);
console.log(`${solo} ms`);

process.stdout.write(`${N} at once… `);
const t0 = Date.now();
const each = await Promise.all(Array.from({ length: N }, (_, i) => gen(i + 1)));
const together = Date.now() - t0;
console.log(`${together} ms (each: ${each.join(", ")} ms)`);

// THROUGHPUT is the verdict, not the ratio. A ratio bar of N/2 is unreachable at N=2 (bar 1.00) and
// it also can't tell the two failure modes apart — both were measured on a live L4:
//   • QUEUEING  (1 slot, 3 requests): finished 3866 / 7168 / 10464 ms — STAGGERED by one solo time.
//   • THRASHING (4 slots, 4 requests): finished 16143..16166 ms — SIMULTANEOUS, each 4× slower.
// Only the spread separates them, so measure both: speedup says whether N is worth running, and the
// finish spread says WHY when it isn't.
const speedup = (solo * N) / together;                  // 1.0 = no better than one at a time
const spread = Math.max(...each) - Math.min(...each);   // ≈0 = ran together; ≈solo×k = queued
const queued = spread > solo * 0.5;
console.log(`\nthroughput  ${(N / (together / 1000)).toFixed(2)} req/s vs ${(1 / (solo / 1000)).toFixed(2)} solo`);
console.log(`speedup     ${speedup.toFixed(2)}× (1.0 = pointless)   finish spread ${spread} ms ${queued ? "— STAGGERED, they queued" : "— together, they ran concurrently"}`);

if (N === 1) {
  console.log("\nN=1 — nothing to prove; set --n or raise the model's `parallel`.");
} else if (speedup < 1.1) {
  die(queued
    ? `${N} at once is no faster (${speedup.toFixed(2)}×) and the finishes are staggered — the box is QUEUEING them.\n` +
      `      Check the slot count: gcloud compute ssh <vm> --tunnel-through-iap \\\n` +
      `        --command="systemctl show ollama -p Environment"`
    : `${N} at once is no faster (${speedup.toFixed(2)}×) though all ran concurrently — the box is THRASHING.\n` +
      `      ${N} slots do not fit this GPU; lower parallel (and raise ctx back) in config/models.js.`);
} else {
  console.log(`\nPASS: ${N} at once gives ${speedup.toFixed(2)}× the throughput of one at a time.`);
}
