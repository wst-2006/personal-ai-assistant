import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  createLongRangePlanSchema,
  longRangePlanScopeSchema,
  setLongRangePlanStatusSchema,
  updateLongRangePlanSchema
} from "@personal-ai/domain/long-range-plan";
import {
  LongRangePlanNotFoundError,
  LongRangePlanService,
  LongRangePlanStateError,
  LongRangePlanVersionConflictError
} from "./long-range-plan-service.js";

const paramsSchema = z.object({ id: z.string().uuid() });
const listQuerySchema = z.object({ scope: longRangePlanScopeSchema.optional(), includeArchived: z.coerce.boolean().optional().default(false) });

export async function longRangePlanRoutes(app: FastifyInstance, options: { longRangePlanService: LongRangePlanService }) {
  const { longRangePlanService } = options;

  app.get("/long-range-plans", async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: "invalid_long_range_plan_query", details: query.error.flatten() });
    return { plans: await longRangePlanService.list(query.data.scope, query.data.includeArchived) };
  });

  app.get("/long-range-plans/:id", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: "invalid_long_range_plan_id" });
    try { return { plan: await longRangePlanService.get(params.data.id) }; }
    catch (error) { return planError(reply, error); }
  });

  app.post("/long-range-plans", async (request, reply) => {
    const input = createLongRangePlanSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: "invalid_long_range_plan", details: input.error.flatten() });
    return reply.status(201).send({ plan: await longRangePlanService.create(input.data) });
  });

  app.put("/long-range-plans/:id", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const input = updateLongRangePlanSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_long_range_plan_update", details: input.success ? undefined : input.error.flatten() });
    try { return { plan: await longRangePlanService.update(params.data.id, input.data) }; }
    catch (error) { return planError(reply, error); }
  });

  app.post("/long-range-plans/:id/status", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const input = setLongRangePlanStatusSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_long_range_plan_status" });
    try { return { plan: await longRangePlanService.setStatus(params.data.id, input.data.expectedVersion, input.data.status) }; }
    catch (error) { return planError(reply, error); }
  });
}

function planError(reply: FastifyReply, error: unknown) {
  if (error instanceof LongRangePlanNotFoundError) return reply.status(404).send({ error: "long_range_plan_not_found" });
  if (error instanceof LongRangePlanVersionConflictError) return reply.status(409).send({ error: "long_range_plan_version_conflict", plan: error.current });
  if (error instanceof LongRangePlanStateError) return reply.status(409).send({ error: "invalid_long_range_plan_state", state: error.state, operation: error.operation });
  throw error;
}
