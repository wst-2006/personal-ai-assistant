import type { FastifyInstance } from "fastify";
import { createHealthPlanCandidateSchema, createManualHealthPlanCandidateSchema, healthCollaborationMessageInputSchema, healthPlanConfirmationSchema, healthSleepRevisionCandidateSchema, healthWeekStartSchema, saveHealthDailyActualSchema, saveHealthProfileSchema, sleepImageAnalysisRequestSchema, updateManualHealthPlanCandidateSchema } from "@personal-ai/domain/health";
import { reviewDateSchema } from "@personal-ai/domain/review";
import { z } from "zod";
import {
  HealthPlanNotFoundError,
  HealthActivePlanRequiredError,
  HealthPlanBaseChangedError,
  HealthPlanStateError,
  HealthPlanVersionConflictError,
  HealthProfileNotFoundError,
  HealthProfileVersionConflictError,
  HealthService,
  SleepImageValidationError,
  SleepAnalysisNotFoundError,
  SleepAnalysisOutsideWeekError,
  type SleepImageAnalyzer,
  type HealthPlanner
} from "./health-service.js";
import {
  HealthConversationNoPendingReplyError,
  HealthConversationNotFoundError,
  HealthConversationReplyPendingError,
  HealthConversationReplyUnavailableError,
  type HealthConversationResponder,
  type HealthConversationService
} from "./health-conversation-service.js";
import { HealthPlanningOutputError, HealthPlanningProviderError, HealthPlanningTimeoutError } from "./ai/health-planner.js";

const planIdParams = z.object({ id: z.string().uuid() });
const weekParams = z.object({ weekStart: healthWeekStartSchema });
const sleepAnalysisParams = z.object({ localDate: reviewDateSchema });
const sundayOpenInput = z.object({ localDate: reviewDateSchema }).strict();

export async function healthRoutes(app: FastifyInstance, options: {
  healthService: HealthService;
  healthPlanner?: HealthPlanner;
  healthConversationService?: HealthConversationService;
  healthConversationResponder?: HealthConversationResponder;
  feishuClarificationSyncAvailable?: boolean;
  sleepImageAnalyzer?: SleepImageAnalyzer;
}) {
  const { healthService, healthPlanner, healthConversationService, healthConversationResponder, feishuClarificationSyncAvailable, sleepImageAnalyzer } = options;

  app.get("/health/capabilities", async () => ({
    sleepImageAnalysis: Boolean(sleepImageAnalyzer),
    sleepImageAnalysisReason: sleepImageAnalyzer ? null : "vision_model_not_configured",
    feishuClarificationSync: Boolean(feishuClarificationSyncAvailable)
  }));

  app.get("/health/profile", async () => ({ profile: serializeProfile(await healthService.getProfile()) }));

  app.put("/health/profile", async (request, reply) => {
    const input = saveHealthProfileSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: "invalid_health_profile", details: input.error.flatten() });
    try {
      return reply.status(200).send({ profile: serializeProfile(await healthService.saveProfile(input.data.profile, input.data.expectedVersion)) });
    } catch (error) {
      return healthError(reply, error);
    }
  });

  app.get("/health/weeks/:weekStart", async (request, reply) => {
    const params = weekParams.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: "invalid_health_week" });
    const week = await healthService.getWeek(params.data.weekStart);
    return { active: serializePlan(week.active), candidate: serializePlan(week.candidate) };
  });

  if (healthConversationService && healthConversationResponder) {
    app.get("/health/weeks/:weekStart/collaboration", async (request, reply) => {
      const params = weekParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ error: "invalid_health_week" });
      return healthConversationService.getOrOpen(params.data.weekStart);
    });

    app.post("/health/collaborations/:id/messages", async (request, reply) => {
      const params = planIdParams.safeParse(request.params);
      const input = healthCollaborationMessageInputSchema.safeParse(request.body);
      if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_health_collaboration_message" });
      try {
        return reply.status(201).send(await healthConversationService.saveUserMessage(params.data.id, input.data.content));
      } catch (error) {
        return healthCollaborationError(reply, error);
      }
    });

    app.post("/health/collaborations/:id/reply-last", async (request, reply) => {
      const params = planIdParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ error: "invalid_health_collaboration_id" });
      try {
        return reply.status(201).send(await healthConversationService.retryLast(params.data.id, healthConversationResponder));
      } catch (error) {
        return healthCollaborationError(reply, error);
      }
    });
  }

  app.post("/health/weeks/sunday-open", async (request, reply) => {
    const input = sundayOpenInput.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: "invalid_health_sunday_open" });
    return { status: "explicit_generation_required", plan: null };
  });

  app.get("/health/days/:localDate", async (request, reply) => {
    const params = sleepAnalysisParams.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: "invalid_health_reference_date" });
    const reference = await healthService.getDay(params.data.localDate);
    return { reference: reference ? { plan: reference.plan, day: { ...reference.day, content: reference.day.content } } : null };
  });

  app.get("/health/days/:localDate/actual", async (request, reply) => {
    const params = sleepAnalysisParams.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: "invalid_health_actual_date" });
    return { actual: await healthService.getDailyActual(params.data.localDate) };
  });

  app.put("/health/days/:localDate/actual", async (request, reply) => {
    const params = sleepAnalysisParams.safeParse(request.params);
    const input = saveHealthDailyActualSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_health_daily_actual" });
    return { actual: await healthService.saveDailyActual(params.data.localDate, input.data) };
  });

  app.get("/health/sleep-analyses/:localDate", async (request, reply) => {
    const params = sleepAnalysisParams.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: "invalid_sleep_analysis_date" });
    return { analyses: await healthService.listSleepAnalyses(params.data.localDate) };
  });

  app.post("/health/sleep-analyses", async (request, reply) => {
    if (!sleepImageAnalyzer) return reply.status(503).send({ error: "sleep_image_analysis_unavailable", message: "视觉分析服务尚未配置。" });
    const input = sleepImageAnalysisRequestSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: "invalid_sleep_image", details: input.error.flatten() });
    try {
      return reply.status(201).send({ analysis: await healthService.analyzeSleepImage(input.data, sleepImageAnalyzer) });
    } catch (error) {
      if (error instanceof SleepImageValidationError) return reply.status(400).send({ error: "invalid_sleep_image", message: error.message });
      app.log.warn({ reason: error instanceof Error ? error.message : "unknown" }, "Sleep image analysis failed");
      return reply.status(502).send({ error: "sleep_image_analysis_unavailable", message: "视觉分析暂时不可用，未保存任何分析结果。" });
    }
  });

  app.post("/health/weeks/manual-candidates", async (request, reply) => {
    const input = createManualHealthPlanCandidateSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: "invalid_manual_health_candidate", details: input.error.flatten() });
    try {
      return reply.status(201).send({ plan: serializePlan(await healthService.createManualCandidate(input.data)) });
    } catch (error) {
      return healthError(reply, error);
    }
  });

  app.put("/health/weeks/:id/manual-candidate", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    const input = updateManualHealthPlanCandidateSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_manual_health_candidate_update" });
    try {
      return reply.status(200).send({ plan: serializePlan(await healthService.updateManualCandidate(params.data.id, input.data)) });
    } catch (error) {
      return healthError(reply, error);
    }
  });

  if (healthPlanner) app.post("/health/weeks/ai-candidates", async (request, reply) => {
    const input = createHealthPlanCandidateSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: "invalid_health_candidate", details: input.error.flatten() });
    try {
      const collaborationContext = healthConversationService
        ? await healthConversationService.contextForWeek(input.data.weekStart)
        : null;
      return reply.status(201).send({ plan: serializePlan(await healthService.createAiCandidate(input.data.weekStart, input.data.specialContext ?? null, healthPlanner, collaborationContext)) });
    } catch (error) {
      if (error instanceof HealthProfileNotFoundError || error instanceof HealthProfileVersionConflictError) return healthError(reply, error);
      app.log.warn({
        reason: error instanceof Error ? error.message : "unknown",
        validationIssues: error instanceof HealthPlanningOutputError ? error.validationIssues : undefined
      }, "AI health planning failed");
      return healthPlanningError(reply, error);
    }
  });

  if (healthPlanner) app.post("/health/weeks/sleep-revision-candidates", async (request, reply) => {
    const input = healthSleepRevisionCandidateSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: "invalid_sleep_revision_candidate", details: input.error.flatten() });
    try {
      return reply.status(201).send({ plan: serializePlan(await healthService.createSleepRevisionCandidate(input.data, healthPlanner)) });
    } catch (error) {
      if (error instanceof HealthProfileNotFoundError
        || error instanceof HealthActivePlanRequiredError
        || error instanceof SleepAnalysisNotFoundError
        || error instanceof SleepAnalysisOutsideWeekError
        || error instanceof HealthPlanBaseChangedError) return healthError(reply, error);
      app.log.warn({ reason: error instanceof Error ? error.message : "unknown" }, "AI sleep-based health revision failed");
      return reply.status(502).send({ error: "ai_health_plan_unavailable", message: "AI 暂时无法生成睡眠修订候选，现有参考保持不变。" });
    }
  });

  app.post("/health/weeks/:id/confirm", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    const input = healthPlanConfirmationSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_health_plan_confirmation" });
    try {
      return { plan: serializePlan(await healthService.confirm(params.data.id, input.data.expectedVersion)) };
    } catch (error) {
      return healthError(reply, error);
    }
  });

  app.post("/health/weeks/:id/cancel", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    const input = healthPlanConfirmationSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_health_plan_cancellation" });
    try {
      return { plan: serializePlan(await healthService.cancel(params.data.id, input.data.expectedVersion)) };
    } catch (error) {
      return healthError(reply, error);
    }
  });
}

function healthPlanningError(reply: { status: (statusCode: number) => { send: (body: unknown) => unknown } }, error: unknown) {
  if (error instanceof HealthPlanningTimeoutError) return reply.status(504).send({ error: "ai_health_plan_timeout", message: "AI 已收到请求，但在健康候选等待时限内没有返回完整结果；没有写入候选，也不会自动重复请求。" });
  if (error instanceof HealthPlanningOutputError) return reply.status(502).send({
    error: "ai_health_plan_invalid",
    message: `AI 本次没有产生可写入的完整候选：${error.userMessage}；本周交流已经保留，现有参考没有变化。请修正后重新生成候选；系统不会自动重复请求。`,
    validationIssues: error.validationIssues
  });
  if (error instanceof HealthPlanningProviderError) return reply.status(502).send({ error: "ai_health_plan_provider_error", message: "AI 服务暂时拒绝或中断了本次请求；没有写入候选。" });
  return reply.status(502).send({ error: "ai_health_plan_unavailable", message: "AI 暂时无法生成健康参考，现有计划没有变化。" });
}

function healthCollaborationError(reply: { status: (statusCode: number) => { send: (body: unknown) => unknown } }, error: unknown) {
  if (error instanceof HealthConversationNotFoundError) return reply.status(404).send({ error: "health_collaboration_not_found" });
  if (error instanceof HealthConversationNoPendingReplyError) return reply.status(409).send({ error: "health_collaboration_has_no_pending_reply" });
  if (error instanceof HealthConversationReplyPendingError) return reply.status(409).send({ error: "health_collaboration_reply_pending", message: "上一条健康说明已经保存，等待 AI 回应或直接重试即可，不需要重复发送。" });
  if (error instanceof HealthConversationReplyUnavailableError) return reply.status(502).send({
    error: "ai_health_collaboration_unavailable",
    conversationId: error.conversationId,
    userMessageId: error.userMessageId,
    message: "你的健康说明已经保存，但 AI 暂时没有返回回应；可以直接重试，不需要重新输入。"
  });
  throw error;
}

function serializeProfile(profile: Awaited<ReturnType<HealthService["getProfile"]>>) {
  return profile ? { ...profile, profile: profile.profile } : null;
}

function serializePlan(plan: Awaited<ReturnType<HealthService["getWeek"]>>["active"] | null) {
  return plan ? { ...plan.plan, days: plan.days.map((day) => ({ ...day, content: day.content })) } : null;
}

function healthError(reply: { status: (statusCode: number) => { send: (body: unknown) => unknown } }, error: unknown) {
  if (error instanceof HealthProfileNotFoundError) return reply.status(409).send({ error: "health_profile_required" });
  if (error instanceof HealthProfileVersionConflictError) return reply.status(409).send({ error: "health_profile_version_conflict", profile: serializeProfile(error.current) });
  if (error instanceof HealthPlanNotFoundError) return reply.status(404).send({ error: "health_plan_not_found" });
  if (error instanceof HealthActivePlanRequiredError) return reply.status(409).send({ error: "health_active_plan_required" });
  if (error instanceof SleepAnalysisNotFoundError) return reply.status(404).send({ error: "sleep_analysis_not_found" });
  if (error instanceof SleepAnalysisOutsideWeekError) return reply.status(409).send({ error: "sleep_analysis_outside_week" });
  if (error instanceof HealthPlanBaseChangedError) return reply.status(409).send({ error: "health_plan_base_changed", active: serializePlan(error.current) });
  if (error instanceof HealthPlanVersionConflictError) return reply.status(409).send({ error: "health_plan_version_conflict", plan: serializePlan(error.current) });
  if (error instanceof HealthPlanStateError) return reply.status(409).send({ error: "invalid_health_plan_transition", state: error.state, operation: error.operation });
  throw error;
}
