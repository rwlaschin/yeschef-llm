// ============================================================
// Ollama Worker
// - Pulls jobs from Pub/Sub
// - Queries MongoDB Vector Search for RAG context
// - Streams Ollama response chunks to Firestore in real-time
// - Saves full result to MongoDB on completion
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
} = process.env;

for (const [k, v] of Object.entries({
  GCP_PROJECT_ID, SUBSCRIPTION_NAME, OLLAMA_MODEL, MONGO_URI, MONGO_DB, MONGO_COLLECTION,
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
const mongo = new MongoClient(MONGO_URI);
let ragCollection;

async function connectMongo() {
  await mongo.connect();
  ragCollection = mongo.db(MONGO_DB).collection(MONGO_COLLECTION);
  console.log(`MongoDB connected: ${MONGO_DB}.${MONGO_COLLECTION}`);
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

// ---- Ollama streaming --------------------------------------
async function streamInference(query, context, onChunk) {
  const prompt = context
    ? `You are a hospital dietary compliance assistant.\n\nRelevant regulations:\n${context}\n\nQuestion: ${query}\n\nAnswer:`
    : `You are a hospital dietary compliance assistant.\n\nQuestion: ${query}\n\nAnswer:`;

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: true }),
  });

  if (!res.ok) throw new Error(`Ollama inference failed: ${res.statusText}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = decoder.decode(value, { stream: true }).split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const chunk = JSON.parse(line);
        if (chunk.response) {
          full += chunk.response;
          await onChunk(chunk.response, full);
        }
      } catch {
        // malformed line — skip
      }
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

  const { jobId, query } = payload;
  console.log(`Processing job: ${jobId}`);

  const db = getFirestoreClient();
  const jobRef = db.collection("llmResults").doc(jobId);

  try {
    await jobRef.update({ status: "streaming" });

    const context = await retrieveContext(query);
    console.log(`  RAG: ${parseInt(RAG_TOP_K)} chunks retrieved`);

    const flusher = makeChunkFlusher(db, jobId);
    const fullResponse = await streamInference(query, context, flusher.push.bind(flusher));
    await flusher.flush();

    console.log(`  Streaming complete`);

    await Promise.all([
      jobRef.update({
        status:      "complete",
        response:    fullResponse,
        completedAt: FieldValue.serverTimestamp(),
      }),
      mongo.db(MONGO_DB).collection("results").insertOne({
        jobId,
        query,
        answer:       fullResponse,
        model:        OLLAMA_MODEL,
        subscription: SUBSCRIPTION_NAME,
        metadata:     payload.metadata || {},
        createdAt:    new Date(),
      }),
    ]);

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
  const subscription = pubsub.subscription(SUBSCRIPTION_NAME, {
    flowControl: { maxMessages: 2 },
  });

  subscription.on("message", handleMessage);
  subscription.on("error", (err) => console.error("Subscription error:", err));

  console.log(`Worker listening on : ${SUBSCRIPTION_NAME}`);
  console.log(`Model               : ${OLLAMA_MODEL} @ ${OLLAMA_HOST}\n`);
}

main().catch((err) => {
  console.error("Worker failed to start:", err.message);
  process.exit(1);
});
