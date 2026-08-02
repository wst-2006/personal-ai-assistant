import cors from "@fastify/cors";
import Fastify from "fastify";
import { aiRoutes } from "./ai/routes.js";
import { inboxRoutes } from "./inbox-routes.js";
import type { TaskParser } from "./ai/task-parser.js";
import { taskRoutes } from "./task-routes.js";
import type { TaskService } from "./task-service.js";
import { focusRoutes } from "./focus-routes.js";
import type { FocusService } from "./focus-service.js";
import { focusStructureRoutes } from "./focus-structure-routes.js";
import type { FocusStructureService } from "./focus-structure-service.js";
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
import type { FocusStructurePlanner } from "./ai/focus-structure-planner.js";
import { backupRoutes } from "./backup-routes.js";
import type { BackupExporter } from "./backup-service.js";
import { healthRoutes } from "./health-routes.js";
import type { HealthPlanner, HealthService, SleepImageAnalyzer } from "./health-service.js";

declare module "fastify" {
  interface FastifyRequest { rawBody?: string }
}

type AppOptions = {
  taskService?: TaskService;
  focusService?: FocusService;
  focusStructureService?: FocusStructureService;
  focusStructurePlanner?: FocusStructurePlanner;
  reviewService?: ReviewService;
  briefService?: BriefService;
  diaryService?: DiaryService;
  growthService?: GrowthService;
  feishuWebhookService?: FeishuWebhookService;
  taskParser?: TaskParser;
  backupService?: BackupExporter;
  healthService?: HealthService;
  healthPlanner?: HealthPlanner;
  sleepImageAnalyzer?: SleepImageAnalyzer;
};

export function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: true, bodyLimit: 9 * 1024 * 1024 });

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
  if (options.focusStructureService) app.register(focusStructureRoutes, {
    prefix: "/api/v1",
    focusStructureService: options.focusStructureService,
    focusStructurePlanner: options.focusStructurePlanner
  });
  if (options.reviewService) app.register(reviewRoutes, { prefix: "/api/v1", reviewService: options.reviewService });
  if (options.briefService) app.register(briefRoutes, { prefix: "/api/v1", briefService: options.briefService });
  if (options.diaryService) app.register(diaryRoutes, { prefix: "/api/v1", diaryService: options.diaryService });
  if (options.growthService) app.register(growthRoutes, { prefix: "/api/v1", growthService: options.growthService });
  if (options.feishuWebhookService) app.register(feishuRoutes, { prefix: "/api/v1", webhookService: options.feishuWebhookService });
  if (options.backupService) app.register(backupRoutes, { prefix: "/api/v1", backupService: options.backupService });
  if (options.healthService) app.register(healthRoutes, { prefix: "/api/v1", healthService: options.healthService, healthPlanner: options.healthPlanner, sleepImageAnalyzer: options.sleepImageAnalyzer });

  if (options.taskParser) {
    app.register(aiRoutes, {
      prefix: "/api/v1/ai",
      taskParser: options.taskParser
    });
  }

  return app;
}
