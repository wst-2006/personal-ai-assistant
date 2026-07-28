import cors from "@fastify/cors";
import Fastify from "fastify";
import { aiRoutes } from "./ai/routes.js";
import { inboxRoutes } from "./inbox-routes.js";
import type { TaskParser } from "./ai/task-parser.js";
import { taskRoutes } from "./task-routes.js";
import type { TaskService } from "./task-service.js";
import { focusRoutes } from "./focus-routes.js";
import type { FocusService } from "./focus-service.js";

type AppOptions = {
  taskService?: TaskService;
  focusService?: FocusService;
  taskParser?: TaskParser;
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

  if (options.taskService) app.register(inboxRoutes, { prefix: "/api/v1", taskService: options.taskService });
  if (options.focusService) app.register(focusRoutes, { prefix: "/api/v1", focusService: options.focusService });

  if (options.taskParser) {
    app.register(aiRoutes, {
      prefix: "/api/v1/ai",
      taskParser: options.taskParser
    });
  }

  return app;
}
