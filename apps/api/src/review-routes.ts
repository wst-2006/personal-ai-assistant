import type { FastifyInstance } from "fastify";
import { reviewDateSchema, reviewMessageSchema, reviewRadarSchema } from "@personal-ai/domain/review";
import { z } from "zod";
import {
  ReviewNoPendingReplyError,
  ReviewNotFoundError,
  ReviewReplyUnavailableError,
  ReviewService,
  type ReviewResponder,
} from "./review-service.js";

const params = z.object({ localDate: reviewDateSchema });
const sessionParams = z.object({ id: z.string().uuid() });

export async function reviewRoutes(app: FastifyInstance, options: { reviewService: ReviewService; responder?: ReviewResponder }) {
  app.get("/reviews/:localDate", async (request, reply) => {
    const value = params.safeParse(request.params);
    if (!value.success) return reply.status(400).send({ error: "invalid_review_date" });
    return options.reviewService.getOrOpen(value.data.localDate);
  });

  app.post("/reviews/:id/messages", async (request, reply) => {
    const id = sessionParams.safeParse(request.params);
    const input = reviewMessageSchema.safeParse(request.body);
    if (!id.success || !input.success) return reply.status(400).send({ error: "invalid_review_message", details: input.success ? undefined : input.error.flatten() });
    try {
      return reply.status(201).send(await options.reviewService.addUserMessage(id.data.id, input.data.content));
    } catch (error) {
      if (error instanceof ReviewNotFoundError) return reply.status(404).send({ error: "review_session_not_found" });
      throw error;
    }
  });

  app.post("/reviews/:id/reply-last", async (request, reply) => {
    const id = sessionParams.safeParse(request.params);
    if (!id.success) return reply.status(400).send({ error: "invalid_review_session" });
    if (!options.responder) return reply.status(503).send({ error: "review_ai_unavailable" });
    try {
      return reply.status(201).send(await options.reviewService.replyLast(id.data.id, options.responder));
    } catch (error) {
      if (error instanceof ReviewNotFoundError) return reply.status(404).send({ error: "review_session_not_found" });
      if (error instanceof ReviewNoPendingReplyError) return reply.status(409).send({ error: "review_has_no_pending_reply" });
      if (error instanceof ReviewReplyUnavailableError) return reply.status(502).send({
        error: "review_ai_unavailable",
        reviewSessionId: error.reviewSessionId,
        userMessageId: error.userMessageId,
      });
      throw error;
    }
  });

  app.post("/reviews/:id/radar", async (request, reply) => {
    const id = sessionParams.safeParse(request.params);
    const input = reviewRadarSchema.safeParse(request.body);
    if (!id.success || !input.success) return reply.status(400).send({ error: "invalid_review_radar", details: input.success ? undefined : input.error.flatten() });
    try {
      return reply.status(201).send(await options.reviewService.saveRadarSnapshot(id.data.id, input.data));
    } catch (error) {
      if (error instanceof ReviewNotFoundError) return reply.status(404).send({ error: "review_session_not_found" });
      throw error;
    }
  });
}
