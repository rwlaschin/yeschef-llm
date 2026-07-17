import { MongoClient } from "mongodb";

async function run() {
  const uri = process.env.MONGO_URI;
  const dbName = process.env.MONGO_DB || "yeschef";

  if (!uri) {
    console.error("Error: MONGO_URI environment variable is not set.");
    console.error("Please run this script with: node --env-file=.env.production <script>");
    process.exit(1);
  }

  const client = new MongoClient(uri);

  try {
    console.log(`Connecting to MongoDB...`);
    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection("region_capacity_stats");

    console.log(`Querying region_capacity_stats collection...\n`);
    const stats = await collection.find({}).sort({ dayTs: -1 }).toArray();

    if (stats.length === 0) {
      console.log("No capacity stats found in the database.");
    } else {
      console.table(
        stats.map((row) => ({
          Region: row.region,
          Daypart: row.daypart,
          Day: row.day,
          Ok: row.ok || 0,
          Fail: row.fail || 0,
        }))
      );
    }
  } catch (error) {
    console.error("Database query failed:", error);
  } finally {
    await client.close();
  }
}

run();
