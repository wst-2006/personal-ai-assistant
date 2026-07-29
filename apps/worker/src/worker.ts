import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { ReminderWorker } from "./worker-core.js";
import { FeishuDeliveryProvider, loadFeishuConfig } from "./feishu-delivery.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
const worker = new ReminderWorker(connection.db);
const feishuConfig = loadFeishuConfig(process.env);
const provider = feishuConfig ? new FeishuDeliveryProvider(feishuConfig) : null;
const timer = setInterval(() => void poll().catch((error) => console.error("Reminder worker poll failed", error)), 15_000);

async function poll() {
  if (!provider) return;
  await worker.processNext(provider);
}

process.once("SIGINT", async () => { clearInterval(timer); await connection.client.end(); process.exit(0); });
process.once("SIGTERM", async () => { clearInterval(timer); await connection.client.end(); process.exit(0); });
if (!provider) console.warn("Reminder worker is idle: Feishu credentials and target are not configured.");
else await poll();
