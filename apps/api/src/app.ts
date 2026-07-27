import cors from "@fastify/cors";
import Fastify from "fastify";
import { aiRoutes } from "./ai/routes.js";
import { inboxRoutes } from "./inbox-routes.js";
import type { AppDatabase } from "@personal-ai/db/client";
import type { TaskParser } from "./ai/task-parser.js";
import { taskRoutes } from "./task-routes.js";
import type { TaskService } from "./task-service.js";

type AppOptions = {
  taskService?: TaskService;
  taskParser?: TaskParser;
  database?: AppDatabase;
};

export function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: true });

  app.register(cors, {
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"]
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "personal-ai-api"
  }));

  if (options.taskService) {
    app.register(taskRoutes, {
      prefix: "/api/v1",
      taskService: options.taskService
    });
  }

  if (options.database) app.register(inboxRoutes, { prefix: "/api/v1", database: options.database });

  if (options.taskParser) {
    app.register(aiRoutes, {
      prefix: "/api/v1/ai",
      taskParser: options.taskParser
    });
  }

  return app;
}
