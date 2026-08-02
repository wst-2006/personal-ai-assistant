import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { localDateAtTimeZone } from "@personal-ai/domain/task";
import type { TaskParser } from "./task-parser.js";
import {
  filterAdviceToKnownTasks,
  type PlanChangeAdvisor,
  type PlanChangeTaskContext
} from "./plan-change-advisor.js";
import { TaskNotFoundError, type TaskService } from "../task-service.js";

const parseRequestSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  referenceDate: z.string().date(),
  timeZone: z.literal("Asia/Shanghai")
});

const planChangeRequestSchema = z.object({
  taskId: z.string().uuid(),
  message: z.string().trim().min(1).max(4000)
}).strict();

type AiRoutesOptions = {
  taskParser?: TaskParser;
  taskService?: TaskService;
  planChangeAdvisor?: PlanChangeAdvisor;
};

export const aiRoutes: FastifyPluginAsync<AiRoutesOptions> = async (app, options) => {
  if (options.taskParser) app.post("/tasks/parse", async (request, reply) => {
    const parsed = parseRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_parse_request",
        issues: parsed.error.issues
      });
    }

    try {
      const candidate = await options.taskParser!.parse(parsed.data);
      return { candidate };
    } catch (error) {
      app.log.warn(
        {
          reason: error instanceof Error ? error.message : "Unknown AI parser failure"
        },
        "DeepSeek task parsing failed"
      );
      return reply.status(502).send({
        error: "ai_unavailable",
        message: "AI 暂时无法整理这条内容，原始输入没有丢失。",
        ...(process.env.NODE_ENV === "production" || !(error instanceof Error)
          ? {}
          : { detail: error.message })
      });
    }
  });

  if (options.taskService && options.planChangeAdvisor) app.post("/plan-change-advisories", async (request, reply) => {
    const parsed = planChangeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_plan_change_consultation",
        issues: parsed.error.issues
      });
    }

    try {
      const detail = await options.taskService!.get(parsed.data.taskId);
      const task = toPlanChangeTaskContext(detail.task);
      const referenceDate = task.localDate ?? localDateAtTimeZone(new Date(), task.timeZone);
      const today = await options.taskService!.list(referenceDate);
      const dayTasks = today.tasks.map(toPlanChangeTaskContext);
      if (!dayTasks.some((candidate) => candidate.id === task.id)) dayTasks.unshift(task);
      const advice = await options.planChangeAdvisor!.advise({
        message: parsed.data.message,
        referenceDate,
        task,
        dayTasks
      });
      const knownTasks = new Map(dayTasks.map((candidate) => [candidate.id, candidate]));
      const filtered = filterAdviceToKnownTasks(advice, new Set(knownTasks.keys()));
      return {
        advisory: {
          ...filtered,
          taskId: task.id,
          taskVersion: task.version,
          taskScheduleRevision: task.scheduleRevision,
          affectedTasks: filtered.affectedTaskIds.map((id) => {
            const affected = knownTasks.get(id)!;
            return { id: affected.id, title: affected.title, startAt: affected.startAt, endAt: affected.endAt };
          })
        }
      };
    } catch (error) {
      if (error instanceof TaskNotFoundError) return reply.status(404).send({ error: "task_not_found" });
      app.log.warn(
        { reason: error instanceof Error ? error.message : "Unknown AI consultation failure" },
        "DeepSeek plan-change consultation failed"
      );
      return reply.status(502).send({
        error: "ai_unavailable",
        message: "AI 暂时无法分析这次变动，原始说明仍保留在侧边层。",
        ...(process.env.NODE_ENV === "production" || !(error instanceof Error)
          ? {}
          : { detail: error.message })
      });
    }
  });
};

function toPlanChangeTaskContext(task: {
  id: string;
  title: string;
  lifecycleStatus: string;
  scheduleKind: string;
  localDate: string | null;
  daypart: string | null;
  startAt: Date | null;
  endAt: Date | null;
  timeZone: string;
  notes: string | null;
  version: number;
  scheduleRevision: number;
}): PlanChangeTaskContext {
  return {
    ...task,
    lifecycleStatus: expectedEnum(task.lifecycleStatus, ["open", "active", "awaiting_outcome", "closed", "cancelled"] as const, "lifecycle status"),
    scheduleKind: expectedEnum(task.scheduleKind, ["none", "daypart", "exact"] as const, "schedule kind"),
    daypart: task.daypart === null ? null : expectedEnum(task.daypart, ["morning", "afternoon", "evening"] as const, "daypart"),
    startAt: task.startAt?.toISOString() ?? null,
    endAt: task.endAt?.toISOString() ?? null
  };
}

function expectedEnum<T extends string>(value: string, values: readonly T[], label: string): T {
  if (!values.includes(value as T)) throw new Error(`Unexpected task ${label}.`);
  return value as T;
}
