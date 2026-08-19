import { PubSub } from "@google-cloud/pubsub";

const pubsubClients = new Map();

function getPubSubClient(projectId, environment) {
  const key = `${projectId}-${environment}`;

  if (!pubsubClients.has(key)) {
    const options = {};

    if (environment === "local") {
      // Use emulator
      process.env.PUBSUB_EMULATOR_HOST = "localhost:8185";
    }

    const client = new PubSub({ projectId });
    pubsubClients.set(key, client);
  }

  return pubsubClients.get(key);
}

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const { topic, message, environment } = body;

  if (!topic || !message) {
    throw createError({
      statusCode: 400,
      statusMessage: "Missing topic or message",
    });
  }

  try {
    const projectId = "yeschef-c572a";
    const pubsub = getPubSubClient(projectId, environment);

    const topicRef = pubsub.topic(topic);
    const messageId = await topicRef.publish(
      Buffer.from(JSON.stringify(message))
    );

    return {
      success: true,
      messageId,
      topic,
    };
  } catch (err) {
    console.error("Pub/Sub publish error:", err);
    throw createError({
      statusCode: 500,
      statusMessage: `Failed to publish: ${err.message}`,
    });
  }
});
