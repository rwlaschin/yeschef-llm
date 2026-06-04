import { PubSub } from "@google-cloud/pubsub";

export default defineEventHandler(async (event) => {
  try {
    // Use emulator if in dev
    if (process.env.NODE_ENV === "development") {
      process.env.PUBSUB_EMULATOR_HOST = "localhost:8085";
    }

    const pubsub = new PubSub({ projectId: "yeschef-c572a" });
    await pubsub.getTopics();

    return { status: "ok" };
  } catch (err) {
    throw createError({
      statusCode: 503,
      statusMessage: `Pub/Sub connection failed: ${err.message}`,
    });
  }
});
