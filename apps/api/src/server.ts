import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { buildApp } from "./app.js";
import { loadDeepSeekConfig } from "./ai/config.js";
import { DeepSeekTaskParser } from "./ai/task-parser.js";
import { loadServerConfig } from "./config.js";
import { PostgresTaskStore } from "./task-repository.js";
import { TaskService } from "./task-service.js";
import { FocusService } from "./focus-service.js";
import { ReviewService } from "./review-service.js";

const config = loadServerConfig();
const database = await connectVerifiedDatabase(loadDatabaseConfig());
const taskStore = new PostgresTaskStore(database.db);
const app = buildApp({
  taskService: new TaskService(taskStore),
  focusService: new FocusService(database.db),
  reviewService: new ReviewService(database.db),
  taskParser: new DeepSeekTaskParser(loadDeepSeekConfig())
});

app.addHook("onClose", async () => {
  await database.client.end();
});

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
