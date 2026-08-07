import type { FastifyInstance } from "fastify";
import { generateDailyBriefSchema, generateStandaloneBriefSchema, updateDailyBriefSchema } from "@personal-ai/domain/brief";
import { reviewDateSchema } from "@personal-ai/domain/review";
import { z } from "zod";
import { BriefGenerationUnavailableError, BriefNotFoundError, BriefReviewRequiredError, BriefService, BriefSourcesUnavailableError } from "./brief-service.js";

const idParams = z.object({ id: z.string().uuid() });
const standaloneQuery = z.object({ date: reviewDateSchema });

export async function briefRoutes(app: FastifyInstance, options: { briefService: BriefService }) {
  app.post("/reviews/:id/briefs", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const input = generateDailyBriefSchema.safeParse(request.body ?? {});
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_review_session", details: input.success ? undefined : input.error.flatten() });
    try { return reply.status(201).send({ brief: await options.briefService.generateFromReview(params.data.id, input.data.locationName) }); }
    catch (error) {
      if (error instanceof BriefReviewRequiredError) return reply.status(409).send({ error: "review_message_required" });
      if (error instanceof BriefNotFoundError) return reply.status(404).send({ error: "review_session_not_found" });
      if (error instanceof BriefSourcesUnavailableError) return reply.status(503).send({ error: "brief_sources_unavailable" });
      if (error instanceof BriefGenerationUnavailableError) return reply.status(503).send({ error: "brief_generation_unavailable" });
      throw error;
    }
  });
  app.post("/briefs/standalone", async (request, reply) => {
    const input = generateStandaloneBriefSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: "invalid_standalone_brief", details: input.error.flatten() });
    try {
      const brief = await options.briefService.generateFromConversation(input.data.conversation, input.data.localDate, input.data.locationName);
      return reply.status(201).send({ brief });
    } catch (error) {
      if (error instanceof BriefSourcesUnavailableError) return reply.status(503).send({ error: "brief_sources_unavailable" });
      if (error instanceof BriefGenerationUnavailableError) return reply.status(503).send({ error: "brief_generation_unavailable" });
      throw error;
    }
  });
  app.get("/briefs/standalone", async (request, reply) => {
    const query = standaloneQuery.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: "invalid_standalone_brief_date" });
    return { briefs: await options.briefService.listStandalone(query.data.date) };
  });
  app.patch("/briefs/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params); const input = updateDailyBriefSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_daily_brief", details: input.success ? undefined : input.error.flatten() });
    try { return { brief: await options.briefService.update(params.data.id, input.data.content, input.data.state) }; }
    catch (error) { if (error instanceof BriefNotFoundError) return reply.status(404).send({ error: "daily_brief_not_found" }); throw error; }
  });
}
