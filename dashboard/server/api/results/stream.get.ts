import { MongoClient } from "mongodb";

const mongoClients = new Map();

async function getMongoClient(uri, environment) {
  const key = `${environment}`;

  if (!mongoClients.has(key)) {
    const client = new MongoClient(uri);
    await client.connect();
    mongoClients.set(key, client);
  }

  return mongoClients.get(key);
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const environment = query.environment || "local";

  // Get MongoDB URI from environment
  const mongoUri =
    process.env.MONGO_URI ||
    "mongodb+srv://rwuser:UNDERDOG*dish9consort@yeschef-development.vfmtkz4.mongodb.net/?appName=YesChef-Development";
  const mongoDb = process.env.MONGO_DB || "yeschef_dev";

  // Set up SSE
  setHeader(event, "Content-Type", "text/event-stream");
  setHeader(event, "Cache-Control", "no-cache");
  setHeader(event, "Connection", "keep-alive");

  const client = await getMongoClient(mongoUri, environment);
  const db = client.db(mongoDb);
  const collection = db.collection("results");

  // Create change stream to watch for new/updated results
  const changeStream = collection.watch([
    {
      $match: {
        $or: [{ operationType: "insert" }, { operationType: "update" }],
      },
    },
  ]);

  // Send initial results
  const existingResults = await collection
    .find({})
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray();

  for (const result of existingResults) {
    const formatted = formatResult(result);
    event.node.res.write(`data: ${JSON.stringify(formatted)}\n\n`);
  }

  // Listen for changes
  const onClose = () => {
    changeStream.close();
    client.close();
    mongoClients.delete(environment);
  };

  event.node.res.on("close", onClose);

  changeStream.on("change", (change) => {
    const result = change.fullDocument || change.updateDescription;
    if (result) {
      const formatted = formatResult(result);
      event.node.res.write(`data: ${JSON.stringify(formatted)}\n\n`);
    }
  });

  changeStream.on("error", (err) => {
    console.error("Change stream error:", err);
    onClose();
  });

  // Keep connection alive
  const heartbeat = setInterval(() => {
    event.node.res.write(": heartbeat\n\n");
  }, 30000);

  event.node.res.on("close", () => {
    clearInterval(heartbeat);
  });
});

function formatResult(doc) {
  return {
    jobId: doc.jobId,
    query: doc.query,
    answer: doc.answer,
    error: doc.error,
    status: doc.error ? "error" : doc.answer ? "success" : "pending",
    timestamp: new Date(doc.createdAt || doc.updatedAt).toISOString(),
    latency: doc.latency,
  };
}
