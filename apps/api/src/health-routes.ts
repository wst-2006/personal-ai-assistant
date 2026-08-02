import type { FastifyInstance } from "fastify";
import { createHealthPlanCandidateSchema, healthPlanConfirmationSchema, healthWeekStartSchema, saveHealthProfileSchema, sleepImageAnalysisRequestSchema } from "@personal-ai/domain/health";
import { reviewDateSchema } from "@personal-ai/domain/review";
import { z } from "zod";
import {
  HealthPlanNotFoundError,
  HealthPlanStateError,
  HealthPlanVersionConflictError,
  HealthProfileNotFoundError,
  HealthProfileVersionConflictError,
  HealthService,
  SleepImageValidationError,
  type SleepImageAnalyzer,
  type HealthPlanner
} from "./health-service.js";

const planIdParams = z.object({ id: z.string().uuid() });
const weekParams = z.object({ weekStart: healthWeekStartSchema });
const sleepAnalysisParams = z.object({ localDate: reviewDateSchema });

export async function healthRoutes(app: FastifyInstance, options: { healthService: HealthService; healthPlanner?: HealthPlanner; sleepImageAnalyzer?: SleepImageAnalyzer }) {
  const { healthService, healthPlanner, sleepImageAnalyzer } = options;

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

  app.post("/health/weeks/template-candidates", async (request, reply) => {
    const input = createHealthPlanCandidateSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: "invalid_health_candidate", details: input.error.flatten() });
    try {
      return reply.status(201).send({ plan: serializePlan(await healthService.createTemplateCandidate(input.data.weekStart, input.data.specialContext ?? null)) });
    } catch (error) {
      return healthError(reply, error);
    }
  });

  if (healthPlanner) app.post("/health/weeks/ai-candidates", async (request, reply) => {
    const input = createHealthPlanCandidateSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: "invalid_health_candidate", details: input.error.flatten() });
    try {
      return reply.status(201).send({ plan: serializePlan(await healthService.createAiCandidate(input.data.weekStart, input.data.specialContext ?? null, healthPlanner)) });
    } catch (error) {
      if (error instanceof HealthProfileNotFoundError || error instanceof HealthProfileVersionConflictError) return healthError(reply, error);
      app.log.warn({ reason: error instanceof Error ? error.message : "unknown" }, "DeepSeek health planning failed");
      return reply.status(502).send({ error: "ai_health_plan_unavailable", message: "AI 暂时无法生成健康参考，现有计划没有变化。" });
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
  if (error instanceof HealthPlanVersionConflictError) return reply.status(409).send({ error: "health_plan_version_conflict", plan: serializePlan(error.current) });
  if (error instanceof HealthPlanStateError) return reply.status(409).send({ error: "invalid_health_plan_transition", state: error.state, operation: error.operation });
  throw error;
}
