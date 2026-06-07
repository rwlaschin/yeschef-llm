// ============================================================
// Ollama Worker
// - Pulls jobs from Pub/Sub
// - Queries MongoDB Vector Search for RAG context
// - Streams Ollama response chunks to Firestore in real-time
// - Writes the final result to Firestore on completion (Mongo is RAG-only)
// - Acks on success, nacks on failure (job returns to queue)
// ============================================================

import { PubSub } from "@google-cloud/pubsub";
import { MongoClient } from "mongodb";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

// ---- Config ------------------------------------------------
const {
  GCP_PROJECT_ID,
  SUBSCRIPTION_NAME,
  OLLAMA_HOST = "http://localhost:11434",
  OLLAMA_MODEL,
  MONGO_URI,
  MONGO_DB,
  MONGO_COLLECTION,
  MONGO_INDEX = "vector_index",
  RAG_TOP_K = "5",
  FIREBASE_PROJECT_ID,
  NEO4J_URI,
  NEO4J_USERNAME,
  NEO4J_PASSWORD,
  GATEWAY,                                          // "openclaw" → infer via the OpenClaw gateway
  OPENCLAW_URL = "http://localhost:18789",
  OPENCLAW_GATEWAY_TOKEN,
  OLLAMA_API_KEY,                                   // web_search/web_fetch (both paths). Required.
  OLLAMA_WEB_BASE = "https://ollama.com/api",       // hosted search/fetch endpoints
  MAX_TOOL_ROUNDS = "4",                            // safety cap on tool-call loops (raw path)
  DEPLOY_ENV = "production",                         // "dev" → also load inactive prompts
  PROMPT_COLLECTION = "prompt_library",
  OLLAMA_NUM_CTX = "8192",                           // context window; Ollama defaults to a tiny 2-4k which
                                                     // a long system prompt fills, starving the output
  OLLAMA_NUM_PREDICT = "-1",                          // max output tokens; -1 = until done or context full
} = process.env;

for (const [k, v] of Object.entries({
  GCP_PROJECT_ID, SUBSCRIPTION_NAME, OLLAMA_MODEL, MONGO_URI, MONGO_DB, MONGO_COLLECTION,
  OLLAMA_API_KEY, // web search is on for every tier — no key, no run
})) {
  if (!v) throw new Error(`${k} env var is required`);
}

// ---- Firebase Admin ----------------------------------------
// Cloud Run: Application Default Credentials used automatically.
// Local dev: set GOOGLE_APPLICATION_CREDENTIALS to a service account key file.
function getFirestoreClient() {
  if (!getApps().length) {
    initializeApp({ projectId: FIREBASE_PROJECT_ID || GCP_PROJECT_ID });
  }
  return getFirestore();
}

// ---- MongoDB -----------------------------------------------
// Resilient options so the connection recovers when the network changes
// (laptop WiFi/VPN/sleep): fail server-selection fast instead of hanging, retry
// transient reads, heartbeat often to rediscover the topology, and drop sockets
// stranded by the old network. RAG is also opt-in + non-fatal (see handleMessage),
// so a Mongo blip never fails the job.
const mongo = new MongoClient(MONGO_URI, {
  serverSelectionTimeoutMS: 8000,
  socketTimeoutMS: 45000,
  heartbeatFrequencyMS: 5000,
  maxIdleTimeMS: 30000,
  retryReads: true,
});
let ragCollection;
let promptCollection;

async function connectMongo() {
  await mongo.connect();
  ragCollection = mongo.db(MONGO_DB).collection(MONGO_COLLECTION);
  promptCollection = mongo.db(MONGO_DB).collection(PROMPT_COLLECTION);
  console.log(`MongoDB connected: ${MONGO_DB} (rag=${MONGO_COLLECTION}, prompts=${PROMPT_COLLECTION})`);
}

// ---- Prompt library (Mongo-backed, cached) -----------------
// Prompts live in `prompt_library`: { mapping: { <topic>: <priority> }, active, content }.
//   - `mapping` is a MAP keyed by message TYPE → order key, for O(1) lookup.
//   - dev loads inactive prompts too; prod only active:true.
//   - cached with NO TTL; ~5% of requests re-query to pick up edits eventually.
//   - for a type: join all matching prompts, sorted ASC by the lexBetween order key
//     via plain code-unit compare (matches the dashboard's drag-drop ordering).
const INCLUDE_INACTIVE = DEPLOY_ENV !== "production";
let promptCache = null;
let promptCacheAt = 0;
const PROMPT_CACHE_TTL_MS = 15000; // re-query at most this often, so newly-added/edited prompts appear within ~15s

async function loadPrompts() {
  const filter = { isDeleted: { $ne: true } };          // never load soft-deleted
  if (!INCLUDE_INACTIVE) filter.active = true;            // prod: active only; dev: all
  return promptCollection.find(filter).toArray();
}

async function getPrompts() {
  if (!promptCache || Date.now() - promptCacheAt > PROMPT_CACHE_TTL_MS) {
    try {
      promptCache = await loadPrompts();
      promptCacheAt = Date.now();
      console.log(`  prompt_library: ${promptCache.length} prompt(s) cached (includeInactive=${INCLUDE_INACTIVE})`);
    } catch (e) {
      console.warn(`  prompt_library load failed (${e.message}) — using ${promptCache ? "cached" : "empty"} set`);
      promptCache = promptCache || [];
    }
  }
  return promptCache;
}

// System prompt for a message TYPE (e.g. "query") = matching prompts joined,
// sorted ascending by priority. `mapping` is keyed by message type, not the model.
async function systemPromptFor(type) {
  const prompts = await getPrompts();
  return prompts
    .filter((p) => p.mapping && p.mapping[type] != null)
    // plain code-unit sort — must match the dashboard's lexBetween ordering, NOT localeCompare
    .sort((a, b) => {
      const x = String(a.mapping[type]), y = String(b.mapping[type]);
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .map((p) => p.content)
    .filter(Boolean)
    // Strip stray markdown escape backslashes (e.g. "\#", "\-") that older editor
    // saves may have left in stored content, so the model gets clean markdown.
    .map((c) => c.replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1"))
    .join("\n\n");
}

// ---- RAG ---------------------------------------------------
async function getEmbedding(text) {
  const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.statusText}`);
  const { embedding } = await res.json();
  return embedding;
}

async function retrieveContext(query) {
  const embedding = await getEmbedding(query);
  const results = await ragCollection.aggregate([
    {
      $vectorSearch: {
        index: MONGO_INDEX,
        path: "embedding",
        queryVector: embedding,
        numCandidates: parseInt(RAG_TOP_K) * 10,
        limit: parseInt(RAG_TOP_K),
      },
    },
    { $project: { _id: 0, text: 1, score: { $meta: "vectorSearchScore" } } },
  ]).toArray();
  return results.map((r) => r.text).join("\n\n");
}

// ---- Prompt construction -----------------------------------
// Chat-model messages: the prompt_library system prompt (+ optional RAG context) as a
// `system` message, and the user's query as a `user` message. No "Question:/Answer:"
// scaffolding — instruction/chat models don't want it. If no library prompt maps to
// the type, there's simply no system message.
function buildMessages(system, query, context) {
  const messages = [];
  const sys = [system, context && `Relevant context:\n${context}`].filter(Boolean).join("\n\n");
  if (sys) messages.push({ role: "system", content: sys });
  messages.push({ role: "user", content: query });
  return messages;
}

// ---- Ollama web tools (web_search / web_fetch) -------------
// On the raw (non-gateway) path the MODEL calls these; the WORKER executes them
// against Ollama's hosted endpoints with OLLAMA_API_KEY, then feeds results back.
// (Gateway tiers get the same tools from OpenClaw instead — see chatViaOpenClaw.)
const TOOLS = [
  { type: "function", function: {
      name: "web_search",
      description: "Search the web for current, factual, or recent information.",
      parameters: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number" } }, required: ["query"] } } },
  { type: "function", function: {
      name: "web_fetch",
      description: "Fetch the full contents of a specific URL.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
];

async function executeTool(name, args) {
  const path = name === "web_fetch" ? "web_fetch" : "web_search";
  const body = name === "web_fetch" ? { url: args.url } : { query: args.query, max_results: args.max_results || 5 };
  const res = await fetch(`${OLLAMA_WEB_BASE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OLLAMA_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { error: `${name} failed: ${res.status} ${res.statusText}` };
  return await res.json();
}

// One streamed /api/chat round: streams assistant content via onChunk and returns
// any tool calls the model emitted (tool_calls arrive in the final/done chunk).
async function chatRound(messages, tools, onChunk) {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      tools,
      stream: true,
      // Without this Ollama defaults to a tiny context (~2–4k); a long system prompt
      // then leaves almost no room for output, so the model truncates after a little.
      options: { num_ctx: parseInt(OLLAMA_NUM_CTX, 10), num_predict: parseInt(OLLAMA_NUM_PREDICT, 10) },
    }),
  });
  if (!res.ok) throw new Error(`Ollama chat failed: ${res.statusText}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let content = "", toolCalls = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value, { stream: true }).split("\n").filter(Boolean)) {
      try {
        const chunk = JSON.parse(line);
        const piece = chunk.message?.content;
        if (piece) { content += piece; await onChunk(piece, content); }
        if (chunk.message?.tool_calls?.length) toolCalls = toolCalls.concat(chunk.message.tool_calls);
      } catch { /* skip malformed line */ }
    }
  }
  return { content, toolCalls };
}

// Raw-path inference WITH web tools: loop chat rounds, executing any web_search/
// web_fetch the model requests, until it answers (no tool calls). Streams the answer.
async function chatWithTools(initialMessages, onChunk) {
  const messages = [...initialMessages];
  const maxRounds = parseInt(MAX_TOOL_ROUNDS, 10) || 4;
  for (let round = 0; round < maxRounds; round++) {
    const { content, toolCalls } = await chatRound(messages, TOOLS, onChunk);
    messages.push({ role: "assistant", content, tool_calls: toolCalls });
    if (!toolCalls.length) return content; // model answered → done
    for (const call of toolCalls) {
      const result = await executeTool(call.function.name, call.function.arguments || {});
      console.log(`  tool: ${call.function.name}(${JSON.stringify(call.function.arguments || {})})`);
      messages.push({ role: "tool", tool_name: call.function.name, content: JSON.stringify(result) });
    }
  }
  const final = await chatRound(messages, undefined, onChunk); // round cap → answer tool-free
  return final.content;
}

// ---- OpenClaw gateway inference ----------------------------
// For gateway tiers the worker talks to OpenClaw's OpenAI-compatible endpoint
// (:18789/v1/chat/completions). OpenClaw runs the tools (web_search/web_fetch) for
// us — we just stream the answer back the same way the generate path does.
async function chatViaOpenClaw(messages, onChunk) {
  const res = await fetch(`${OPENCLAW_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
    },
    body: JSON.stringify({
      model: "openclaw/default",
      messages,
      stream: true,
    }),
  });
  if (!res.ok) throw new Error(`OpenClaw gateway failed: ${res.status} ${res.statusText}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || ""; // keep the trailing partial line
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const piece = JSON.parse(data).choices?.[0]?.delta?.content;
        if (piece) { full += piece; await onChunk(piece, full); }
      } catch { /* keepalive / non-JSON line */ }
    }
  }
  return full;
}

// ---- Chunk flusher -----------------------------------------
// Batches Firestore writes: flushes every 20 chunks or 500ms
function makeChunkFlusher(db, jobId) {
  const jobRef = db.collection("llmResults").doc(jobId);
  let pending = "";
  let accumulated = "";
  let timer = null;
  let count = 0;

  async function flush() {
    if (!pending) return;
    const full = accumulated;
    pending = "";
    clearTimeout(timer);
    timer = null;
    await jobRef.update({ response: full, updatedAt: FieldValue.serverTimestamp() });
  }

  return {
    async push(chunk, fullSoFar) {
      pending += chunk;
      accumulated = fullSoFar;
      count++;
      if (count % 20 === 0) {
        await flush();
      } else if (!timer) {
        timer = setTimeout(flush, 500);
      }
    },
    flush,
  };
}

// ---- Message handler ---------------------------------------
async function handleMessage(message) {
  let payload;
  try {
    payload = JSON.parse(message.data.toString());
  } catch {
    console.error("Invalid message payload — nacking");
    message.nack();
    return;
  }

  const { jobId, query, type = "query" } = payload;
  console.log(`Processing job: ${jobId} (type: ${type})`);

  const db = getFirestoreClient();
  const jobRef = db.collection("llmResults").doc(jobId);

  try {
    await jobRef.update({ status: "streaming" });

    // RAG is an OPTIONAL augmentation — it must never break a plain query.
    // Default: just send the query. If a request opts in (metadata.rag) we try to
    // augment, but missing/failed RAG is NOT fatal — we log and send the query as-is.
    let context = "";
    if (payload.rag === true || payload.metadata?.rag === true) {
      try {
        context = await retrieveContext(query);
        console.log(`  RAG: ${parseInt(RAG_TOP_K)} chunks retrieved`);
      } catch (e) {
        console.warn(`  RAG unavailable (${e.message}) — sending query without context`);
      }
    } else {
      console.log("  RAG: not requested");
    }

    // System prompt comes from the prompt_library (joined by message TYPE, sorted by
    // priority) — no hard-coded persona. Build chat messages (system + user) and
    // persist a readable copy of what was sent for the record.
    const system = await systemPromptFor(type);
    console.log(`  Prompt: ${system ? system.length + " chars from prompt_library" : "no library prompt for type " + type}`);
    const messages = buildMessages(system, query, context);
    await jobRef.update({ prompt: messages.map((m) => m.content).join("\n\n") });

    // Both paths support web_search/web_fetch: gateway tiers via OpenClaw, raw tiers
    // via the worker tool-loop against Ollama's API. Same free OLLAMA_API_KEY behind both.
    const flusher = makeChunkFlusher(db, jobId);
    const useGateway = GATEWAY === "openclaw";
    console.log(`  Inference: ${useGateway ? "OpenClaw gateway (web tools)" : "Ollama chat + web tools"}`);
    const fullResponse = useGateway
      ? await chatViaOpenClaw(messages, flusher.push.bind(flusher))
      : await chatWithTools(messages, flusher.push.bind(flusher));
    await flusher.flush();

    console.log(`  Streaming complete`);

    // Results live in Firestore only — clients react via onSnapshot.
    // MongoDB is RAG-only; do NOT write results there.
    await jobRef.update({
      status:      "complete",
      response:    fullResponse,
      completedAt: FieldValue.serverTimestamp(),
    });

    message.ack();
    console.log(`  Acked: ${jobId}`);
  } catch (err) {
    console.error(`  Failed job ${jobId}:`, err.message);
    await jobRef.update({ status: "error", error: err.message }).catch(() => {});
    message.nack();
  }
}

// ---- Main --------------------------------------------------
async function main() {
  await connectMongo();

  const pubsub = new PubSub({ projectId: GCP_PROJECT_ID });
  const subscriptionNames = SUBSCRIPTION_NAME.split(',').map(s => s.trim());

  for (const subName of subscriptionNames) {
    const subscription = pubsub.subscription(subName, {
      flowControl: { maxMessages: 2 },
    });
    subscription.on("message", handleMessage);
    subscription.on("error", (err) => console.error(`Subscription error (${subName}):`, err));
    console.log(`  Listening: ${subName}`);
  }

  console.log(`Model: ${OLLAMA_MODEL} @ ${OLLAMA_HOST}\n`);
}

main().catch((err) => {
  console.error("Worker failed to start:", err.message);
  process.exit(1);
});
