import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  createLongRangePlanSchema,
  deleteLongRangePlanSchema,
  longRangePlanScopeSchema,
  organizeLongRangePlanInputSchema,
  setLongRangePlanStatusSchema,
  updateLongRangePlanSchema
} from "@personal-ai/domain/long-range-plan";
import {
  LongRangePlanNotFoundError,
  LongRangePlanService,
  LongRangePlanStateError,
  LongRangePlanScopeLimitError,
  LongRangePlanVersionConflictError
} from "./long-range-plan-service.js";
import type { LongRangePlanOrganizer } from "./ai/long-range-plan-organizer.js";

const paramsSchema = z.object({ id: z.string().uuid() });
const listQuerySchema = z.object({ scope: longRangePlanScopeSchema.optional(), includeArchived: z.coerce.boolean().optional().default(false) });

export async function longRangePlanRoutes(app: FastifyInstance, options: { longRangePlanService: LongRangePlanService; organizer?: LongRangePlanOrganizer }) {
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
    try { return reply.status(201).send({ plan: await longRangePlanService.create(input.data) }); }
    catch (error) { return planError(reply, error); }
  });

  app.post("/long-range-plans/organize-ai", async (request, reply) => {
    if (!options.organizer) return reply.status(503).send({ error: "long_range_plan_organizer_unavailable" });
    const input = organizeLongRangePlanInputSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: "invalid_long_range_plan_organization", details: input.error.flatten() });
    try { return { candidate: await options.organizer.organize(input.data) }; }
    catch { return reply.status(502).send({ error: "long_range_plan_organization_failed" }); }
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

  app.delete("/long-range-plans/:id", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const input = deleteLongRangePlanSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_long_range_plan_delete" });
    try { await longRangePlanService.delete(params.data.id, input.data.expectedVersion); return reply.status(204).send(); }
    catch (error) { return planError(reply, error); }
  });
}

function planError(reply: FastifyReply, error: unknown) {
  if (error instanceof LongRangePlanNotFoundError) return reply.status(404).send({ error: "long_range_plan_not_found" });
  if (error instanceof LongRangePlanVersionConflictError) return reply.status(409).send({ error: "long_range_plan_version_conflict", plan: error.current });
  if (error instanceof LongRangePlanStateError) return reply.status(409).send({ error: "invalid_long_range_plan_state", state: error.state, operation: error.operation });
  if (error instanceof LongRangePlanScopeLimitError) return reply.status(409).send({ error: "long_range_plan_scope_limit", scope: error.scope, limit: 3 });
  throw error;
}
