import { MongoClient } from "mongodb";
import { computeAnalyticsFromMongo } from "@/lib/analytic.service";

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME ?? "BMR";

if (!MONGO_URI) {
  console.warn(
    "[api/data] MONGO_URI is not defined. Requests will fail until it is provided."
  );
}

export async function GET() {
  if (!MONGO_URI) {
    return new Response(
      JSON.stringify({ error: "Missing MONGO_URI environment variable" }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      }
    );
  }

  let client: MongoClient | undefined;
  try {
    client = new MongoClient(MONGO_URI, { maxPoolSize: 5 });
    await client.connect();
    const db = client.db(DB_NAME);
    const analytics = await computeAnalyticsFromMongo(db);
    return Response.json(analytics);
  } catch (error) {
    console.error("[api/data] error", error);
    return new Response(
      JSON.stringify({
        error: "Failed to load analytics",
        details: String((error as Error)?.message ?? error),
      }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      }
    );
  } finally {
    if (client) {
      await client.close().catch(() => undefined);
    }
  }
}
