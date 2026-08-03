import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { buildApp } from "./app.js";
import { loadDeepSeekConfig } from "./ai/config.js";
import { DeepSeekTaskParser } from "./ai/task-parser.js";
import { DeepSeekPlanChangeAdvisor } from "./ai/plan-change-advisor.js";
import { DeepSeekFocusStructurePlanner } from "./ai/focus-structure-planner.js";
import { loadServerConfig } from "./config.js";
import { PostgresTaskStore } from "./task-repository.js";
import { TaskService } from "./task-service.js";
import { FocusService } from "./focus-service.js";
import { FocusStructureService } from "./focus-structure-service.js";
import { ReviewService } from "./review-service.js";
import { BriefService } from "./brief-service.js";
import { DiaryService } from "./diary-service.js";
import { GrowthService } from "./growth-service.js";
import { FeishuWebhookService, loadFeishuWebhookConfig } from "./feishu-webhook.js";
import { BackupService } from "./backup-service.js";
import { HealthService } from "./health-service.js";
import { DeepSeekHealthPlanner } from "./ai/health-planner.js";
import { DeepSeekSleepImageAnalyzer } from "./ai/sleep-image-analyzer.js";
import { LongRangePlanService } from "./long-range-plan-service.js";
import { LongRangeTaskTreeService } from "./long-range-task-tree-service.js";
import { DeepSeekLongRangeTaskTreePlanner } from "./ai/long-range-task-tree-planner.js";
import { UserProfileService } from "./user-profile-service.js";
import { ConversationService } from "./conversation-service.js";
import { DeepSeekConversationResponder } from "./ai/conversation-responder.js";

const config = loadServerConfig();
const database = await connectVerifiedDatabase(loadDatabaseConfig());
const taskStore = new PostgresTaskStore(database.db);
const taskService = new TaskService(taskStore);
const userProfileService = new UserProfileService(database.db);
const focusService = new FocusService(database.db);
const focusStructureService = new FocusStructureService(database.db);
const feishuConfig = loadFeishuWebhookConfig(process.env);
const deepSeekConfig = loadDeepSeekConfig();
const app = buildApp({
  taskService,
  focusService,
  focusStructureService,
  focusStructurePlanner: new DeepSeekFocusStructurePlanner(deepSeekConfig, userProfileService),
  reviewService: new ReviewService(database.db),
  briefService: new BriefService(database.db),
  diaryService: new DiaryService(database.db),
  growthService: new GrowthService(database.db),
  backupService: new BackupService(database.db),
  healthService: new HealthService(database.db),
  healthPlanner: new DeepSeekHealthPlanner(deepSeekConfig, userProfileService),
  sleepImageAnalyzer: new DeepSeekSleepImageAnalyzer(deepSeekConfig, userProfileService),
  longRangePlanService: new LongRangePlanService(database.db),
  longRangeTaskTreeService: new LongRangeTaskTreeService(database.db),
  longRangeTaskTreePlanner: new DeepSeekLongRangeTaskTreePlanner(deepSeekConfig, userProfileService),
  userProfileService,
  conversationService: new ConversationService(database.db),
  conversationResponder: new DeepSeekConversationResponder(deepSeekConfig, userProfileService),
  feishuWebhookService: feishuConfig ? new FeishuWebhookService(feishuConfig, taskService, focusService) : undefined,
  taskParser: new DeepSeekTaskParser(deepSeekConfig, userProfileService),
  planChangeAdvisor: new DeepSeekPlanChangeAdvisor(deepSeekConfig, userProfileService)
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
