import type { FastifyInstance } from "fastify";
import { FeishuWebhookAuthError, FeishuWebhookPayloadError, type FeishuWebhookService } from "./feishu-webhook.js";

export async function feishuRoutes(app: FastifyInstance, options: { webhookService: FeishuWebhookService }) {
  app.post("/integrations/feishu/events", async (request, reply) => {
    const rawBody = request.rawBody ?? JSON.stringify(request.body ?? {});
    try {
      return await options.webhookService.handle(rawBody, request.headers, request.body);
    } catch (error) {
      if (error instanceof FeishuWebhookAuthError) return reply.status(401).send({ error: "invalid_feishu_signature" });
      if (error instanceof FeishuWebhookPayloadError) return reply.status(400).send({ error: "invalid_feishu_callback" });
      throw error;
    }
  });
}
