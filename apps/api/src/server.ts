import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { buildApp } from "./app.js";
import { loadDeepSeekConfig } from "./ai/config.js";
import { DeepSeekTaskParser } from "./ai/task-parser.js";
import { loadServerConfig } from "./config.js";
import { PostgresTaskStore } from "./task-repository.js";
import { TaskService } from "./task-service.js";

const config = loadServerConfig();
const database = await connectVerifiedDatabase(loadDatabaseConfig());
const app = buildApp({
  taskService: new TaskService(new PostgresTaskStore(database.db)),
  database: database.db,
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
