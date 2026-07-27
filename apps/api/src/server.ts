import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { buildApp } from "./app.js";
import { loadDeepSeekConfig } from "./ai/config.js";
import { DeepSeekTaskParser } from "./ai/task-parser.js";
import { loadServerConfig } from "./config.js";
import { PostgresTaskRepository } from "./task-repository.js";

const config = loadServerConfig();
const database = await connectVerifiedDatabase(loadDatabaseConfig());
const app = buildApp({
  taskRepository: new PostgresTaskRepository(database.db),
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
