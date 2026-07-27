import cors from "@fastify/cors";
import Fastify from "fastify";
import { aiRoutes } from "./ai/routes.js";
import type { TaskParser } from "./ai/task-parser.js";
import { taskRoutes } from "./task-routes.js";
import type { TaskRepository } from "./task-repository.js";

type AppOptions = {
  taskRepository?: TaskRepository;
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

  if (options.taskRepository) {
    app.register(taskRoutes, {
      prefix: "/api/v1",
      taskRepository: options.taskRepository
    });
  }

  if (options.taskParser) {
    app.register(aiRoutes, {
      prefix: "/api/v1/ai",
      taskParser: options.taskParser
    });
  }

  return app;
}
