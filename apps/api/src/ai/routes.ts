import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { TaskParser } from "./task-parser.js";

const parseRequestSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  referenceDate: z.string().date(),
  timeZone: z.literal("Asia/Shanghai")
});

type AiRoutesOptions = {
  taskParser: TaskParser;
};

export const aiRoutes: FastifyPluginAsync<AiRoutesOptions> = async (app, options) => {
  app.post("/tasks/parse", async (request, reply) => {
    const parsed = parseRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_parse_request",
        issues: parsed.error.issues
      });
    }

    try {
      const candidate = await options.taskParser.parse(parsed.data);
      return { candidate };
    } catch (error) {
      app.log.warn(
        {
          reason: error instanceof Error ? error.message : "Unknown AI parser failure"
        },
        "DeepSeek task parsing failed"
      );
      return reply.status(502).send({
        error: "ai_unavailable",
        message: "AI 暂时无法整理这条内容，原始输入没有丢失。",
        ...(process.env.NODE_ENV === "production" || !(error instanceof Error)
          ? {}
          : { detail: error.message })
      });
    }
  });
};
