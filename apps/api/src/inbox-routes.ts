import { taskInputSchema } from "@personal-ai/domain/task";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ConflictSetChangedError, InboxEntryConflictError, TaskService, TaskTimeConflictError } from "./task-service.js";

const paramsSchema = z.object({ id: z.string().uuid() });
const createSchema = z.object({
  entryKind: z.enum(["idea", "question"]),
  content: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(4000).nullable().optional()
}).strict();
const convertSchema = z.object({
  confirmed: z.literal(true),
  expectedVersion: z.number().int().positive(),
  task: taskInputSchema
}).strict();

export const inboxRoutes: FastifyPluginAsync<{ taskService: TaskService }> = async (app, options) => {
  app.get("/inbox-entries", () => options.taskService.listInbox());

  app.post("/inbox-entries", async (request, reply) => {
    const input = createSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: "invalid_inbox_entry", issues: input.error.issues });
    return reply.status(201).send({ entry: await options.taskService.createInbox(input.data.entryKind, input.data.content, input.data.notes) });
  });

  app.post("/inbox-entries/:id/convert-to-task", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const input = convertSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_inbox_conversion" });
    try {
      return reply.status(201).send(await options.taskService.convertInbox(params.data.id, input.data.expectedVersion, input.data.task));
    } catch (error) {
      if (error instanceof InboxEntryConflictError) return reply.status(409).send({ error: "inbox_entry_conflict", currentEntry: error.currentEntry });
      if (error instanceof TaskTimeConflictError) return reply.status(409).send({ error: "task_time_conflict", conflicts: error.conflicts, conflictSetFingerprint: error.conflictSetFingerprint });
      if (error instanceof ConflictSetChangedError) return reply.status(409).send({ error: "conflict_set_changed", conflicts: error.conflicts, conflictSetFingerprint: error.conflictSetFingerprint });
      throw error;
    }
  });
};
