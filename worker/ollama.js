// worker/ollama.js — the Ollama HTTP transport (one streamed /api/chat round).
// Extracted from index.js so it's UNIT-TESTABLE: it takes its sampler + host/model/timeouts as
// injectable opts (defaulting from env) and has no Mongo/Firestore/Pub-Sub coupling. See ollama.test.js.
//
// Why node:http and not global fetch: Node's fetch (undici) imposes a 5-minute headersTimeout/
// bodyTimeout that fires INDEPENDENTLY of our AbortController — on a CPU box a cold load + prefill
// exceeds 5 min before the first token, so undici killed healthy requests with UND_ERR_HEADERS_TIMEOUT.
// node:http has no such built-in timeout; the AbortController (firstChunkMs / idleMs) is the ONLY one.
import http from "node:http";
import https from "node:https";
import { generationSlots } from "./lease.js";

// Keep-alive connection pool. A single unit makes SEVERAL /api/chat round-trips (chat → tool → chat →
// …); keep-alive reuses one socket across them instead of a fresh TCP+handshake each round. maxSockets
// defaults to OLLAMA_NUM_PARALLEL + 1 — match what THIS box runs in parallel, +1 for socket handoff.
// NOT a scaling ceiling (scale by adding boxes); override with OLLAMA_MAX_SOCKETS for a shared box.
const _override = parseInt(process.env.OLLAMA_MAX_SOCKETS, 10);
const _numParallel = generationSlots();
const _agentOpts = { keepAlive: true, keepAliveMsecs: 30000, maxSockets: _override > 0 ? _override : _numParallel + 1 };
export const ollamaHttpAgent = new http.Agent(_agentOpts);
export const ollamaHttpsAgent = new https.Agent(_agentOpts);

// One streamed /api/chat round: streams assistant content via onChunk(piece, fullSoFar) and returns
// { content, toolCalls } (tool_calls arrive in the final/done chunk). opts is injectable for tests.
export async function chatRound(messages, tools, onChunk, numCtx, opts = {}) {
  const {
    sampler = {},
    host = process.env.OLLAMA_HOST || "http://localhost:11434",
    model = process.env.OLLAMA_MODEL,
    numPredict = parseInt(process.env.OLLAMA_NUM_PREDICT, 10) || -1,
    // Two windows, because the FIRST byte and SUBSEQUENT bytes have very different latencies:
    //   • firstChunkMs — generous, covers a COLD model load + prefill, during which zero bytes stream.
    //   • idleMs — tight gap-between-tokens detector, applied only AFTER the first chunk arrives.
    idleMs = parseInt(process.env.GEN_TIMEOUT_MS, 10) || 120000,
    firstChunkMs = parseInt(process.env.GEN_FIRST_CHUNK_MS, 10) || 600000,
    httpAgent = ollamaHttpAgent,
    httpsAgent = ollamaHttpsAgent,
  } = opts;

  const ctl = new AbortController();
  let firstChunk = true;
  let timer = setTimeout(() => ctl.abort(), firstChunkMs);
  const bump = () => { firstChunk = false; clearTimeout(timer); timer = setTimeout(() => ctl.abort(), idleMs); };

  const body = JSON.stringify({
    model,
    messages,
    tools,
    stream: true,
    // num_ctx holds INPUT + OUTPUT; sized per-request by the caller (sizeNumCtx). Listed AFTER the
    // sampler spread so it always wins over any DB sampler value.
    options: { ...sampler, num_ctx: numCtx, num_predict: numPredict },
  });
  const url = new URL(`${host}/api/chat`);
  const lib = url.protocol === "https:" ? https : http;
  let req, onReqError; // hoisted so the catch can destroy the socket and we can detach the listener
  try {
    const res = await new Promise((resolve, reject) => {
      req = lib.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        agent: lib === https ? httpsAgent : httpAgent,
        signal: ctl.signal,
      }, resolve);
      onReqError = reject;
      req.once("error", onReqError);
      req.end(body);
    });
    // Settled successfully → detach our error-listener closure so a pooled keep-alive socket doesn't
    // accrue listeners or pin this round's memory (messages/body/content). The error path destroys
    // the socket, which strips listeners anyway.
    req.removeListener("error", onReqError);
    if (res.statusCode !== 200) { res.resume(); throw new Error(`Ollama chat failed: ${res.statusCode} ${res.statusMessage}`); }
    res.setEncoding("utf8");
    let content = "", toolCalls = [], buf = "";
    // Ollama streams NDJSON. A data event yields arbitrary chunks, NOT line-aligned, so a JSON object
    // can straddle two events — buffer the trailing partial line or it fails to parse and is dropped.
    const consume = async (line) => {
      if (!line.trim()) return;
      let chunk; try { chunk = JSON.parse(line); } catch { return; } // genuinely malformed → skip
      const piece = chunk.message?.content;
      if (piece) { content += piece; await onChunk(piece, content); }
      if (chunk.message?.tool_calls?.length) toolCalls = toolCalls.concat(chunk.message.tool_calls);
    };
    // for-await over the IncomingMessage applies backpressure, so per-line onChunk stays ordered.
    for await (const value of res) {
      bump(); // progress made → reset the stall timer
      buf += value;
      const lines = buf.split("\n");
      buf = lines.pop() ?? ""; // last element may be an INCOMPLETE line — hold it for the next event
      for (const line of lines) await consume(line);
    }
    await consume(buf);      // final complete line (Ollama's last chunk often has no trailing newline)
    return { content, toolCalls };
  } catch (err) {
    // Tear the socket DOWN on any failure so it's neither pooled-and-reused-dirty nor leaked as a
    // dangling fd. Only on the error path — a successful response is left for keep-alive to pool.
    req?.destroy();
    if (ctl.signal.aborted) throw new Error(`Ollama chat stalled — no output for ${firstChunk ? firstChunkMs : idleMs}ms (aborted${firstChunk ? ", before first token — model load/prefill" : ""})`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
