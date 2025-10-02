import { MongoClient } from "mongodb";
import AnalyticsDashboard from "@/components/AnalyticsDashboard";
import type { AnalyticsResponse } from "@/lib/analytics";
import { computeAnalyticsFromMongo } from "@/lib/analytics";

const DB_NAME = process.env.DB_NAME ?? "BMR";
const MONGO_URI = process.env.MONGO_URI;

async function getAnalytics(): Promise<AnalyticsResponse | null> {
  if (!MONGO_URI) {
    console.warn("[page] Missing MONGO_URI - skipping analytics fetch.");
    return null;
  }

  let client: MongoClient | undefined;
  try {
    client = new MongoClient(MONGO_URI, { maxPoolSize: 5 });
    await client.connect();
    const db = client.db(DB_NAME);
    const analytics = await computeAnalyticsFromMongo(db);
    return analytics;
  } catch (error) {
    console.error("[page] Failed to fetch analytics", error);
    return null;
  } finally {
    if (client) {
      await client.close().catch(() => undefined);
    }
  }
}

export default async function Page() {
  const analytics = await getAnalytics();

  if (!analytics) {
    return (
      <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold">Advanced Analytics Dashboard</h1>
          <p className="text-slate-400">
            Unable to load analytics. Check database credentials.
          </p>
        </header>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 p-8">
      <header className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Advanced Analytics Dashboard</h1>
          <p className="text-slate-400">
            Behavioral models with clear narratives.
          </p>
        </div>
        <div className="text-sm text-slate-400">
          Backend: {analytics.__version}
        </div>
      </header>

      <AnalyticsDashboard initialData={analytics} />
    </main>
  );
}
