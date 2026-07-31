import cors from "@fastify/cors";
import Fastify from "fastify";
import { aiRoutes } from "./ai/routes.js";
import { inboxRoutes } from "./inbox-routes.js";
import type { TaskParser } from "./ai/task-parser.js";
import { taskRoutes } from "./task-routes.js";
import type { TaskService } from "./task-service.js";
import { focusRoutes } from "./focus-routes.js";
import type { FocusService } from "./focus-service.js";
import { reviewRoutes } from "./review-routes.js";
import type { ReviewService } from "./review-service.js";
import { briefRoutes } from "./brief-routes.js";
import type { BriefService } from "./brief-service.js";
import { diaryRoutes } from "./diary-routes.js";
import type { DiaryService } from "./diary-service.js";
import { growthRoutes } from "./growth-routes.js";
import type { GrowthService } from "./growth-service.js";
import { feishuRoutes } from "./feishu-routes.js";
import type { FeishuWebhookService } from "./feishu-webhook.js";

declare module "fastify" {
  interface FastifyRequest { rawBody?: string }
}

type AppOptions = {
  taskService?: TaskService;
  focusService?: FocusService;
  reviewService?: ReviewService;
  briefService?: BriefService;
  diaryService?: DiaryService;
  growthService?: GrowthService;
  feishuWebhookService?: FeishuWebhookService;
  taskParser?: TaskParser;
};

export function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: true });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const rawBody = String(body);
    request.rawBody = rawBody;
    try { done(null, rawBody ? JSON.parse(rawBody) : null); }
    catch (error) { done(error as Error); }
  });

  app.register(cors, {
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://tauri.localhost",
      "https://tauri.localhost"
    ]
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
  if (options.reviewService) app.register(reviewRoutes, { prefix: "/api/v1", reviewService: options.reviewService });
  if (options.briefService) app.register(briefRoutes, { prefix: "/api/v1", briefService: options.briefService });
  if (options.diaryService) app.register(diaryRoutes, { prefix: "/api/v1", diaryService: options.diaryService });
  if (options.growthService) app.register(growthRoutes, { prefix: "/api/v1", growthService: options.growthService });
  if (options.feishuWebhookService) app.register(feishuRoutes, { prefix: "/api/v1", webhookService: options.feishuWebhookService });

  if (options.taskParser) {
    app.register(aiRoutes, {
      prefix: "/api/v1/ai",
      taskParser: options.taskParser
    });
  }

  return app;
}
