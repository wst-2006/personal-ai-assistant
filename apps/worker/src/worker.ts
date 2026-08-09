import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { ReminderWorker } from "./worker-core.js";
import { FocusTimerWorker } from "./focus-worker.js";
import { FeishuDeliveryProvider, loadFeishuConfig } from "./feishu-delivery.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
const worker = new ReminderWorker(connection.db);
const focusWorker = new FocusTimerWorker(connection.db);
const feishuConfig = loadFeishuConfig(process.env);
const provider = feishuConfig ? new FeishuDeliveryProvider(feishuConfig) : null;
let polling: Promise<void> | null = null;
let shuttingDown = false;
const timer = setInterval(() => void pollSafely(), 15_000);

async function pollDueJobs() {
  for (let processed = 0; processed < 50 && !shuttingDown; processed += 1) {
    const focusResult = await focusWorker.processNext();
    const reminderResult = provider ? await worker.processNext(provider) : "idle";
    if (focusResult === "idle" && reminderResult === "idle") return;
  }
}

async function pollSafely() {
  if (polling || shuttingDown) return polling;
  polling = pollDueJobs()
    .catch((error) => console.error("Reminder worker poll failed", error))
    .finally(() => { polling = null; });
  return polling;
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);
  await polling?.catch(() => undefined);
  await connection.client.end();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
if (!provider) console.warn("Reminder worker is idle: Feishu credentials and target are not configured.");
await pollSafely();
console.log("Reminder worker ready.");
