import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { LongRangeTaskTreeService, TaskTreeCandidateConflictError, TaskTreeCandidateNotFoundError, TaskTreePlanNotFoundError, TaskTreeVersionConflictError } from "./long-range-task-tree-service.js";
import type { LongRangeTaskTreePlanner } from "./ai/long-range-task-tree-planner.js";

const params = z.object({ planId: z.string().uuid() });
const candidateParams = z.object({ id: z.string().uuid() });
export async function longRangeTaskTreeRoutes(app: FastifyInstance, options: { service: LongRangeTaskTreeService; planner?: LongRangeTaskTreePlanner }) {
  app.get("/long-range-plans/:planId/task-tree-candidate", async (request, reply) => { const p = params.safeParse(request.params); if (!p.success) return reply.status(400).send({ error: "invalid_plan_id" }); try { return { candidate: await options.service.getLatest(p.data.planId) }; } catch (error) { return treeError(reply, error); } });
  if (options.planner) {
    const planner = options.planner;
    app.post("/long-range-plans/:planId/task-tree-candidates/ai", async (request, reply) => { const p = params.safeParse(request.params); if (!p.success) return reply.status(400).send({ error: "invalid_plan_id" }); try { return reply.status(201).send({ candidate: await options.service.createAiCandidate(p.data.planId, request.body, planner) }); } catch (error) { return treeError(reply, error); } });
  }
  app.put("/task-tree-candidates/:id", async (request, reply) => { const p = candidateParams.safeParse(request.params); if (!p.success) return reply.status(400).send({ error: "invalid_candidate_id" }); try { return { candidate: await options.service.updateCandidate(p.data.id, request.body) }; } catch (error) { return treeError(reply, error); } });
  app.post("/task-tree-candidates/:id/cancel", async (request, reply) => { const p = candidateParams.safeParse(request.params); if (!p.success) return reply.status(400).send({ error: "invalid_candidate_id" }); try { return { candidate: await options.service.cancelCandidate(p.data.id, request.body) }; } catch (error) { return treeError(reply, error); } });
  app.post("/task-tree-candidates/:id/confirm", async (request, reply) => { const p = candidateParams.safeParse(request.params); if (!p.success) return reply.status(400).send({ error: "invalid_candidate_id" }); try { return await options.service.confirmCandidate(p.data.id, request.body); } catch (error) { return treeError(reply, error); } });
}
function treeError(reply: FastifyReply, error: unknown) { if (error instanceof TaskTreePlanNotFoundError) return reply.status(404).send({ error: "long_range_plan_not_found" }); if (error instanceof TaskTreeCandidateNotFoundError) return reply.status(404).send({ error: "task_tree_candidate_not_found" }); if (error instanceof TaskTreeVersionConflictError) return reply.status(409).send({ error: "long_range_plan_version_conflict", plan: error.plan }); if (error instanceof TaskTreeCandidateConflictError) return reply.status(409).send({ error: "task_tree_candidate_conflict", message: error.message }); throw error; }
