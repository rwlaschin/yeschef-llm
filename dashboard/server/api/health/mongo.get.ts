import { MongoClient } from "mongodb";

export default defineEventHandler(async (event) => {
  const mongoUri =
    process.env.MONGO_URI ||
    "mongodb+srv://rwuser:UNDERDOG*dish9consort@yeschef-development.vfmtkz4.mongodb.net/?appName=YesChef-Development";

  try {
    const client = new MongoClient(mongoUri);
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    await client.close();

    return { status: "ok" };
  } catch (err) {
    throw createError({
      statusCode: 503,
      statusMessage: `MongoDB connection failed: ${err.message}`,
    });
  }
});
