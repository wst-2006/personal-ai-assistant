import type { FastifyInstance } from "fastify";
import { generateDailyBriefSchema, updateDailyBriefSchema } from "@personal-ai/domain/brief";
import { z } from "zod";
import { BriefNotFoundError, BriefReviewRequiredError, BriefService } from "./brief-service.js";

const idParams = z.object({ id: z.string().uuid() });

export async function briefRoutes(app: FastifyInstance, options: { briefService: BriefService }) {
  app.post("/reviews/:id/briefs", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const input = generateDailyBriefSchema.safeParse(request.body ?? {});
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_review_session", details: input.success ? undefined : input.error.flatten() });
    try { return reply.status(201).send({ brief: await options.briefService.generateFromReview(params.data.id, input.data.locationName) }); }
    catch (error) {
      if (error instanceof BriefReviewRequiredError) return reply.status(409).send({ error: "review_message_required" });
      if (error instanceof BriefNotFoundError) return reply.status(404).send({ error: "review_session_not_found" });
      throw error;
    }
  });
  app.patch("/briefs/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params); const input = updateDailyBriefSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_daily_brief", details: input.success ? undefined : input.error.flatten() });
    try { return { brief: await options.briefService.update(params.data.id, input.data.content, input.data.state) }; }
    catch (error) { if (error instanceof BriefNotFoundError) return reply.status(404).send({ error: "daily_brief_not_found" }); throw error; }
  });
}
