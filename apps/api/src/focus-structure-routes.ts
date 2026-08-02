import type { FastifyInstance } from "fastify";
import { focusStructureInputSchema } from "@personal-ai/domain/focus";
import { z } from "zod";
import {
  FocusStructureNotFoundError,
  FocusStructureService,
  FocusStructureTaskConflictError,
  FocusStructureStateError,
  FocusStructureVersionConflictError,
  InvalidFocusStructureError
} from "./focus-structure-service.js";

const taskParamsSchema = z.object({ taskId: z.string().uuid() });
const structureParamsSchema = z.object({ id: z.string().uuid() });
const confirmSchema = z.object({
  expectedVersion: z.number().int().positive(),
  expectedTaskVersion: z.number().int().positive(),
  expectedTaskScheduleRevision: z.number().int().positive()
}).strict();
const cancelSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();

export async function focusStructureRoutes(app: FastifyInstance, options: { focusStructureService: FocusStructureService }) {
  const { focusStructureService } = options;

  app.post("/focus-structures/candidates", async (request, reply) => {
    const input = focusStructureInputSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: "invalid_focus_structure", details: input.error.flatten() });
    try {
      return reply.status(201).send({ focusStructure: serialize(await focusStructureService.createCandidate(input.data)) });
    } catch (error) {
      return focusStructureError(reply, error);
    }
  });

  app.get("/tasks/:taskId/focus-structures", async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: "invalid_task_id" });
    try {
      return { focusStructures: (await focusStructureService.list(params.data.taskId)).map(serialize) };
    } catch (error) {
      return focusStructureError(reply, error);
    }
  });

  app.post("/focus-structures/:id/confirm", async (request, reply) => {
    const params = structureParamsSchema.safeParse(request.params);
    const input = confirmSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_focus_structure_confirmation" });
    try {
      return { focusStructure: serialize(await focusStructureService.confirm(
        params.data.id,
        input.data.expectedVersion,
        input.data.expectedTaskVersion,
        input.data.expectedTaskScheduleRevision
      )) };
    } catch (error) {
      return focusStructureError(reply, error);
    }
  });

  app.post("/focus-structures/:id/cancel", async (request, reply) => {
    const params = structureParamsSchema.safeParse(request.params);
    const input = cancelSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_focus_structure_cancellation" });
    try {
      return { focusStructure: serialize(await focusStructureService.cancel(params.data.id, input.data.expectedVersion)) };
    } catch (error) {
      return focusStructureError(reply, error);
    }
  });
}

function serialize(value: Awaited<ReturnType<FocusStructureService["list"]>>[number]) {
  return {
    ...value.structure,
    segments: value.segments
  };
}

function focusStructureError(reply: { status: (statusCode: number) => { send: (body: unknown) => unknown } }, error: unknown) {
  if (error instanceof FocusStructureNotFoundError) return reply.status(404).send({ error: "focus_structure_not_found" });
  if (error instanceof FocusStructureTaskConflictError) return reply.status(409).send({ error: "focus_structure_task_conflict", task: error.currentTask });
  if (error instanceof FocusStructureVersionConflictError) return reply.status(409).send({ error: "focus_structure_version_conflict", focusStructure: serialize(error.current) });
  if (error instanceof FocusStructureStateError) return reply.status(409).send({ error: "invalid_focus_structure_transition", state: error.state, operation: error.operation });
  if (error instanceof InvalidFocusStructureError) return reply.status(409).send({ error: "invalid_focus_structure", message: error.message });
  throw error;
}
