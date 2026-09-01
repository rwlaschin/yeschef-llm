import { test } from "node:test";
import assert from "node:assert/strict";
import { assertGpuResident } from "./gpuGate.js";

const GB = 1e9;
const noSleep = () => Promise.resolve();

// Fake ollama: /api/generate is a no-op load, /api/ps reports whatever size_vram the case wants.
// `vramByCall` lets a case model a box whose GPU only becomes usable on a later attempt.
const fakeOllama = (vramByCall) => {
  let call = 0;
  return async (url) => {
    if (url.endsWith("/api/generate")) return { ok: true };
    const vram = vramByCall[Math.min(call++, vramByCall.length - 1)];
    return { json: async () => ({ models: vram === null ? [] : [{ name: "llama3.1:8b", size_vram: vram }] }) };
  };
};

const opts = (fetchImpl, extra = {}) => ({
  host: "http://x", model: "llama3.1:8b", fetchImpl,
  log: { log() {} }, sleep: noSleep, ...extra,
});

test("passes when the model is resident in VRAM", async () => {
  const vram = await assertGpuResident(opts(fakeOllama([6 * GB])));
  assert.equal(vram, 6 * GB);
});

test("FAILS on CPU fallback — the incident: model loads, size_vram is 0", async () => {
  // This is the exact production state that must never reach loop.listen(): llama-server fell back
  // to CPU, ollama still served the model, and the box happily leased messages it could not run.
  await assert.rejects(
    () => assertGpuResident(opts(fakeOllama([0]), { attempts: 2 })),
    /GPU gate FAILED.*size_vram=0.*CPU fallback/s,
  );
});

test("fails when no model is resident at all", async () => {
  await assert.rejects(
    () => assertGpuResident(opts(fakeOllama([null]), { attempts: 2 })),
    /no model resident/,
  );
});

test("tolerates a slow driver — CPU on early attempts, GPU later, still passes", async () => {
  // The driver race is a race, not a permanent state; a box that gets there on attempt 3 is healthy.
  const vram = await assertGpuResident(opts(fakeOllama([0, 0, 7 * GB]), { attempts: 5 }));
  assert.equal(vram, 7 * GB);
});

test("fails closed when ollama is unreachable", async () => {
  const boom = async () => { throw new Error("ECONNREFUSED"); };
  await assert.rejects(
    () => assertGpuResident(opts(boom, { attempts: 2 })),
    /probe failed: ECONNREFUSED/,
  );
});

test("rejects a sliver of VRAM — rounding noise is not a loaded model", async () => {
  await assert.rejects(
    () => assertGpuResident(opts(fakeOllama([1024]), { attempts: 2 })),
    /size_vram=1024/,
  );
});
