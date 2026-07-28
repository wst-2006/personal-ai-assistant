import type { FastifyInstance } from "fastify";
import { reviewDateSchema, reviewMessageSchema } from "@personal-ai/domain/review";
import { z } from "zod";
import { ReviewNotFoundError, ReviewService } from "./review-service.js";

const params = z.object({ localDate: reviewDateSchema });
const sessionParams = z.object({ id: z.string().uuid() });

export async function reviewRoutes(app: FastifyInstance, options: { reviewService: ReviewService }) {
  app.get("/reviews/:localDate", async (request, reply) => {
    const value = params.safeParse(request.params);
    if (!value.success) return reply.status(400).send({ error: "invalid_review_date" });
    return options.reviewService.getOrOpen(value.data.localDate);
  });
  app.post("/reviews/:id/messages", async (request, reply) => {
    const id = sessionParams.safeParse(request.params); const input = reviewMessageSchema.safeParse(request.body);
    if (!id.success || !input.success) return reply.status(400).send({ error: "invalid_review_message", details: input.success ? undefined : input.error.flatten() });
    try { return reply.status(201).send(await options.reviewService.addMessage(id.data.id, input.data.content, input.data.source)); }
    catch (error) { if (error instanceof ReviewNotFoundError) return reply.status(404).send({ error: "review_session_not_found" }); throw error; }
  });
}
