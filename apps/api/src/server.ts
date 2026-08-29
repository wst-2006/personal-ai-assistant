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
import { DeepSeekReviewResponder } from "./ai/review-responder.js";
import { BriefService } from "./brief-service.js";
import { BriefProviders } from "./brief-providers.js";
import { DeepSeekBriefWriter } from "./ai/brief-writer.js";
import { DiaryService } from "./diary-service.js";
import { GrowthService } from "./growth-service.js";
import { FeishuWebhookService, loadFeishuWebhookConfig } from "./feishu-webhook.js";
import { BackupService } from "./backup-service.js";
import { HealthService } from "./health-service.js";
import { DeepSeekHealthPlanner } from "./ai/health-planner.js";
import { DeepSeekHealthConversationResponder } from "./ai/health-conversation-responder.js";
import { HealthConversationService } from "./health-conversation-service.js";
import { FeishuHealthMessenger, loadFeishuHealthMessengerConfig } from "./feishu-health-messenger.js";
import { OpenAiCompatibleSleepImageAnalyzer } from "./ai/sleep-image-analyzer.js";
import { LongRangePlanService } from "./long-range-plan-service.js";
import { LongRangeTaskTreeService } from "./long-range-task-tree-service.js";
import { DeepSeekLongRangeTaskTreePlanner } from "./ai/long-range-task-tree-planner.js";
import { DeepSeekLongRangePlanOrganizer } from "./ai/long-range-plan-organizer.js";
import { UserProfileService } from "./user-profile-service.js";
import { ConversationService } from "./conversation-service.js";
import { DeepSeekConversationResponder } from "./ai/conversation-responder.js";
import { FeishuCardActionService, loadFeishuCardActionConfig } from "./feishu-card-actions.js";
import { FeishuLongConnectionService, loadFeishuLongConnectionConfig } from "./feishu-long-connection.js";
import { FeishuIntakeService, loadFeishuIntakeConfig } from "./feishu-intake-service.js";
import { DesktopCommandService } from "./desktop-command-service.js";

const config = loadServerConfig();
const database = await connectVerifiedDatabase(loadDatabaseConfig());
const taskStore = new PostgresTaskStore(database.db);
const taskService = new TaskService(taskStore);
const userProfileService = new UserProfileService(database.db);
const focusService = new FocusService(database.db);
const focusStructureService = new FocusStructureService(database.db);
const desktopCommandService = new DesktopCommandService(database.db);
const feishuActionConfig = loadFeishuCardActionConfig(process.env);
const feishuIntakeConfig = loadFeishuIntakeConfig(process.env);
const feishuWebhookConfig = loadFeishuWebhookConfig(process.env);
const feishuLongConnectionConfig = loadFeishuLongConnectionConfig(process.env);
const feishuHealthMessengerConfig = loadFeishuHealthMessengerConfig(process.env);
const healthConversationService = new HealthConversationService(
  database.db,
  feishuHealthMessengerConfig ? new FeishuHealthMessenger(feishuHealthMessengerConfig) : undefined
);
const deepSeekConfig = loadDeepSeekConfig();
const briefProviders = new BriefProviders({
  ...process.env,
  // External daily-brief sources are intentionally disabled in the published build.
  // Local review summaries remain available so the existing review/diary flow keeps working.
  BRIEF_EXTERNAL_SOURCES_ENABLED: process.env.BRIEF_EXTERNAL_SOURCES_ENABLED ?? "false"
});
const briefService = new BriefService(database.db, briefProviders, new DeepSeekBriefWriter(deepSeekConfig, userProfileService));
const feishuIntake = feishuIntakeConfig
  ? new FeishuIntakeService(
      feishuIntakeConfig,
      database.db,
      taskService,
      new DeepSeekTaskParser(deepSeekConfig, userProfileService),
      focusService,
      { service: healthConversationService, responder: new DeepSeekHealthConversationResponder(deepSeekConfig, userProfileService) }
    )
  : null;
const feishuActions = feishuActionConfig
  ? new FeishuCardActionService(feishuActionConfig, taskService, focusService, feishuIntake ?? undefined)
  : null;
const feishuLongConnection = feishuActions && feishuLongConnectionConfig
  ? new FeishuLongConnectionService(feishuLongConnectionConfig, feishuActions, undefined, undefined, feishuIntake ?? undefined)
  : null;
const app = buildApp({
  taskService,
  focusService,
  focusStructureService,
  focusStructurePlanner: new DeepSeekFocusStructurePlanner(deepSeekConfig, userProfileService),
  reviewService: new ReviewService(database.db),
  reviewResponder: new DeepSeekReviewResponder(deepSeekConfig, userProfileService),
  briefService,
  standaloneBriefsEnabled: false,
  diaryService: new DiaryService(database.db),
  growthService: new GrowthService(database.db),
  backupService: new BackupService(database.db),
  healthService: new HealthService(database.db, briefProviders),
  healthPlanner: new DeepSeekHealthPlanner(deepSeekConfig, userProfileService),
  healthConversationService,
  healthConversationResponder: new DeepSeekHealthConversationResponder(deepSeekConfig, userProfileService),
  healthFeishuSyncAvailable: Boolean(feishuHealthMessengerConfig),
  sleepImageAnalyzer: new OpenAiCompatibleSleepImageAnalyzer(deepSeekConfig),
  longRangePlanService: new LongRangePlanService(database.db),
  longRangeTaskTreeService: new LongRangeTaskTreeService(database.db),
  longRangeTaskTreePlanner: new DeepSeekLongRangeTaskTreePlanner(deepSeekConfig, userProfileService),
  longRangePlanOrganizer: new DeepSeekLongRangePlanOrganizer(deepSeekConfig, userProfileService),
  userProfileService,
  conversationService: new ConversationService(database.db),
  conversationResponder: new DeepSeekConversationResponder(deepSeekConfig, userProfileService),
  desktopCommandService,
  feishuWebhookService: feishuActions && feishuWebhookConfig
    ? new FeishuWebhookService(feishuWebhookConfig, feishuActions)
    : undefined,
  taskParser: new DeepSeekTaskParser(deepSeekConfig, userProfileService),
  planChangeAdvisor: new DeepSeekPlanChangeAdvisor(deepSeekConfig, userProfileService)
});

app.addHook("onClose", async () => {
  await feishuLongConnection?.stop();
  await database.client.end();
});

try {
  await feishuIntake?.recoverInterruptedConfirmations();
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  if (feishuLongConnection) await feishuLongConnection.start();
  else app.log.warn("Feishu long connection is disabled: App ID, App Secret, or target Open ID is not configured, or HTTP callback mode is selected.");
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
