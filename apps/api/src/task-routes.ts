import {
  acceptTaskConflictsSchema,
  taskBackfillInputSchema,
  taskInputSchema,
  taskOutcomeInputSchema,
  taskPatchSchema,
  taskReopenSchema,
  taskVersionActionSchema
} from "@personal-ai/domain/task";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z, ZodError } from "zod";
import {
  ConflictSetChangedError,
  InvalidTaskTransitionError,
  TaskBackfillWindowError,
  TaskNotFoundError,
  TaskScheduleBoundsError,
  TaskScheduleWindowError,
  TaskScheduleRevisionConflictError,
  TaskService,
  TaskTimeConflictError,
  TaskVersionConflictError
} from "./task-service.js";

const listQuerySchema = z.object({ date: z.string().date().optional() });
const taskParamsSchema = z.object({ id: z.string().uuid() });

type TaskRoutesOptions = { taskService: TaskService };

export const taskRoutes: FastifyPluginAsync<TaskRoutesOptions> = async (app, options) => {
  app.get("/tasks", async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(reply, "invalid_query", query.error);
    return options.taskService.list(query.data.date);
  });

  app.get("/tasks/trash", async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(reply, "invalid_query", query.error);
    return { tasks: await options.taskService.listDeleted(query.data.date) };
  });

  app.post("/tasks/trash/empty", async (_request, reply) => {
    try {
      return await options.taskService.emptyTrash();
    } catch (error) {
      return taskError(reply, error);
    }
  });

  app.get("/tasks/:id", async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, "invalid_task_id", params.error);
    try {
      return await options.taskService.get(params.data.id);
    } catch (error) {
      return taskError(reply, error);
    }
  });

  app.post("/tasks", async (request, reply) => {
    const input = taskInputSchema.safeParse(request.body);
    if (!input.success) return invalid(reply, "invalid_task", input.error);
    try {
      const result = await options.taskService.create(input.data);
      return reply.status(201).send(result);
    } catch (error) {
      return taskError(reply, error);
    }
  });

  app.post("/tasks/backfill", async (request, reply) => {
    const input = taskBackfillInputSchema.safeParse(request.body);
    if (!input.success) return invalid(reply, "invalid_task_backfill", input.error);
    try {
      const result = await options.taskService.createBackfill(input.data);
      return reply.status(201).send(result);
    } catch (error) {
      return taskError(reply, error);
    }
  });

  app.patch("/tasks/:id", async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    const input = taskPatchSchema.safeParse(request.body);
    if (!params.success) return invalid(reply, "invalid_task_id", params.error);
    if (!input.success) return invalid(reply, "invalid_task_patch", input.error);
    try {
      return await options.taskService.update(params.data.id, input.data);
    } catch (error) {
      return taskError(reply, error);
    }
  });

  app.delete("/tasks/:id", async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    const input = taskVersionActionSchema.safeParse(request.body);
    if (!params.success) return invalid(reply, "invalid_task_id", params.error);
    if (!input.success) return invalid(reply, "invalid_delete_request", input.error);
    try {
      await options.taskService.softDelete(params.data.id, input.data.expectedVersion, input.data.reason);
      return reply.status(204).send();
    } catch (error) {
      return taskError(reply, error);
    }
  });

  app.post("/tasks/:id/restore", async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    const input = taskReopenSchema.safeParse(request.body);
    if (!params.success) return invalid(reply, "invalid_task_id", params.error);
    if (!input.success) return invalid(reply, "invalid_restore_request", input.error);
    try {
      return await options.taskService.restore(
        params.data.id,
        input.data.expectedVersion,
        input.data.conflictDecision,
        input.data.expectedConflictFingerprint,
        input.data.reason
      );
    } catch (error) {
      return taskError(reply, error);
    }
  });

  app.post("/tasks/:id/cancel", async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    const input = taskVersionActionSchema.safeParse(request.body);
    if (!params.success) return invalid(reply, "invalid_task_id", params.error);
    if (!input.success) return invalid(reply, "invalid_cancel_request", input.error);
    try {
      return { task: await options.taskService.cancel(params.data.id, input.data.expectedVersion, input.data.reason) };
    } catch (error) {
      return taskError(reply, error);
    }
  });

  app.post("/tasks/:id/reopen", async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    const input = taskReopenSchema.safeParse(request.body);
    if (!params.success) return invalid(reply, "invalid_task_id", params.error);
    if (!input.success) return invalid(reply, "invalid_reopen_request", input.error);
    try {
      return await options.taskService.reopen(
        params.data.id,
        input.data.expectedVersion,
        input.data.conflictDecision,
        input.data.expectedConflictFingerprint,
        input.data.reason
      );
    } catch (error) {
      return taskError(reply, error);
    }
  });

  app.post("/tasks/:id/outcomes", async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    const input = taskOutcomeInputSchema.safeParse(request.body);
    if (!params.success) return invalid(reply, "invalid_task_id", params.error);
    if (!input.success) return invalid(reply, "invalid_task_outcome", input.error);
    try {
      const result = await options.taskService.recordOutcome(params.data.id, input.data);
      return reply.status(201).send(result);
    } catch (error) {
      return taskError(reply, error);
    }
  });

  app.post("/tasks/:id/conflicts/accept-all", async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    const input = acceptTaskConflictsSchema.safeParse(request.body);
    if (!params.success) return invalid(reply, "invalid_task_id", params.error);
    if (!input.success) return invalid(reply, "invalid_conflict_acceptance", input.error);
    try {
      return {
        conflicts: await options.taskService.acceptAllConflicts(
          params.data.id,
          input.data.expectedVersion,
          input.data.expectedConflictFingerprint
        )
      };
    } catch (error) {
      return taskError(reply, error);
    }
  });
};

function invalid(reply: FastifyReply, error: string, validation: ZodError) {
  return reply.status(400).send({ error, issues: validation.issues });
}

function taskError(reply: FastifyReply, error: unknown) {
  if (error instanceof TaskScheduleBoundsError) return reply.status(400).send({
    error: "task_schedule_outside_allowed_hours",
    minimumMinute: error.minimumMinute,
    maximumMinute: error.maximumMinute
  });
  if (error instanceof TaskBackfillWindowError) return reply.status(400).send({
    error: "task_backfill_window_unavailable",
    latestEndAt: error.latestEndAt.toISOString()
  });
  if (error instanceof TaskScheduleWindowError) return reply.status(400).send({
    error: "task_schedule_window_unavailable",
    earliestStartAt: error.earliestStartAt.toISOString()
  });
  if (error instanceof TaskNotFoundError) return reply.status(404).send({ error: "task_not_found" });
  if (error instanceof TaskVersionConflictError) {
    return reply.status(409).send({ error: "task_version_conflict", currentTask: error.currentTask });
  }
  if (error instanceof TaskScheduleRevisionConflictError) {
    return reply.status(409).send({ error: "task_schedule_revision_conflict", currentTask: error.currentTask });
  }
  if (error instanceof InvalidTaskTransitionError) {
    return reply.status(409).send({
      error: "invalid_task_transition",
      currentStatus: error.currentStatus,
      operation: error.operation
    });
  }
  if (error instanceof TaskTimeConflictError) {
    return reply.status(409).send({
      error: "task_time_conflict",
      conflicts: error.conflicts,
      conflictSetFingerprint: error.conflictSetFingerprint
    });
  }
  if (error instanceof ConflictSetChangedError) {
    return reply.status(409).send({
      error: "conflict_set_changed",
      conflicts: error.conflicts,
      conflictSetFingerprint: error.conflictSetFingerprint
    });
  }
  if (error instanceof ZodError) return invalid(reply, "invalid_task", error);
  throw error;
}
