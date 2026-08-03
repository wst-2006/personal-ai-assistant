import type { FastifyInstance } from "fastify";
import { conversationDateSchema, conversationMessageInputSchema } from "@personal-ai/domain/conversation";
import { z } from "zod";
import {
  ConversationNoPendingReplyError,
  ConversationNotFoundError,
  ConversationReplyUnavailableError,
  ConversationService,
  type ConversationResponder
} from "./conversation-service.js";

const dateParams = z.object({ localDate: conversationDateSchema });
const idParams = z.object({ id: z.string().uuid() });

export async function conversationRoutes(app: FastifyInstance, options: { conversationService: ConversationService; responder: ConversationResponder }) {
  app.get("/conversations/:localDate", async (request, reply) => {
    const params = dateParams.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: "invalid_conversation_date" });
    return options.conversationService.getOrOpen(params.data.localDate);
  });

  app.post("/conversations/:id/messages", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const input = conversationMessageInputSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ error: "invalid_conversation_message", details: input.success ? undefined : input.error.flatten() });
    try {
      return reply.status(201).send(await options.conversationService.send(params.data.id, input.data.content, options.responder));
    } catch (error) {
      if (error instanceof ConversationNotFoundError) return reply.status(404).send({ error: "conversation_not_found" });
      if (error instanceof ConversationNoPendingReplyError) return reply.status(409).send({ error: "conversation_reply_state_changed" });
      if (error instanceof ConversationReplyUnavailableError) return reply.status(502).send({ error: "ai_conversation_unavailable", conversationId: error.conversationId, userMessageId: error.userMessageId });
      throw error;
    }
  });

  app.post("/conversations/:id/reply-last", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: "invalid_conversation_id" });
    try {
      return reply.status(201).send(await options.conversationService.retryLast(params.data.id, options.responder));
    } catch (error) {
      if (error instanceof ConversationNotFoundError) return reply.status(404).send({ error: "conversation_not_found" });
      if (error instanceof ConversationNoPendingReplyError) return reply.status(409).send({ error: "conversation_has_no_pending_reply" });
      if (error instanceof ConversationReplyUnavailableError) return reply.status(502).send({ error: "ai_conversation_unavailable", conversationId: error.conversationId, userMessageId: error.userMessageId });
      throw error;
    }
  });
}
