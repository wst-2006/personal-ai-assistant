import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { ReminderWorker } from "./worker-core.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
const worker = new ReminderWorker(connection.db);
const timer = setInterval(() => void poll().catch((error) => console.error("Reminder worker poll failed", error)), 15_000);

async function poll() {
  const job = await worker.claimDueJob();
  if (job) await worker.markFailed(job.id, "no reminder delivery provider configured");
}

process.once("SIGINT", async () => { clearInterval(timer); await connection.client.end(); process.exit(0); });
process.once("SIGTERM", async () => { clearInterval(timer); await connection.client.end(); process.exit(0); });
await poll();
