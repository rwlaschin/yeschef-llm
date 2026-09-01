// GPU gate — a prod worker must NEVER subscribe on a box that lost its GPU.
//
// Incident 2026-08-27: llama-server's GPU discovery watchdog timed out at boot ("context deadline
// exceeded") because the NVIDIA driver was not ready yet, so it silently fell back to CPU:
//   load_tensors: CPU_Mapped model buffer size = 4685.30 MiB     (no CUDA buffer lines at all)
//   slot print_timing: prompt processing … 19.31 tokens per second
// 20 tok/s PREFILL on an L4 that does thousands. The box still subscribed, still leased messages,
// and generations that normally take seconds ran 9+ minutes — long enough that the idle timer tore
// the VM down mid-generation, Pub/Sub redelivered to the next box, and that box started over.
// Delivery attempt 7 in 30 minutes, converging on maxDeliveryAttempts=50 and a dead-letter queue
// nothing consumes. A silent 100x slowdown is worse than a crash: nothing alerts on it.
//
// The probe asserts the REAL condition — the model is resident in VRAM — not a proxy for it.
// nvidia-smi can report a healthy device while llama-server has already fallen back to CPU (that is
// exactly what happened), and ollama's own scheduler kept advertising 21.6 GiB of free VRAM while
// serving from CPU. /api/ps reporting size_vram > 0 is the only signal that cannot be true unless
// the weights actually landed on the GPU.

const VRAM_MIN_BYTES = 1 << 30; // 1 GiB — any real 8b model dwarfs this; guards a rounding-noise pass

// Loading a cold model is slow, and this runs while the driver may still be settling, so poll rather
// than judge on the first answer. The box is billing either way; a minute here is cheaper than an
// hour of CPU-speed generations nobody notices.
export async function assertGpuResident({
  host, model, fetchImpl = fetch, log = console,
  attempts = 10, delayMs = 6000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let last = "no attempt made";
  for (let i = 1; i <= attempts; i++) {
    try {
      // Force the model resident: /api/ps only lists what is already loaded, so an empty prompt
      // (which returns as soon as the load completes) is what makes the probe meaningful on a
      // cold box instead of trivially reporting "nothing loaded".
      await fetchImpl(`${host}/api/generate`, {
        method: "POST",
        body: JSON.stringify({ model, prompt: "", keep_alive: "5m" }),
      });
      const res = await fetchImpl(`${host}/api/ps`);
      const { models = [] } = await res.json();
      const entry = models.find((m) => m.name === model || m.model === model) ?? models[0];
      const vram = entry?.size_vram ?? 0;
      if (vram >= VRAM_MIN_BYTES) {
        log.log(`[worker] GPU gate PASS — ${model} resident in VRAM (${(vram / 1e9).toFixed(1)} GB)`);
        return vram;
      }
      last = entry
        ? `${model} loaded with size_vram=${vram} (CPU fallback — llama-server did not use the GPU)`
        : `no model resident after load attempt`;
    } catch (e) {
      last = `probe failed: ${e?.message || e}`;
    }
    if (i < attempts) await sleep(delayMs);
  }
  throw new Error(`GPU gate FAILED after ${attempts} attempts — ${last}`);
}
