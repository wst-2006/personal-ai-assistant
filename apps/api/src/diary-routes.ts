import type { FastifyInstance } from "fastify";
import { cyberDiaryContentSchema, saveCyberDiarySchema } from "@personal-ai/domain/diary";
import { reviewDateSchema } from "@personal-ai/domain/review";
import { z } from "zod";
import { DiaryPrerequisiteError, DiaryService } from "./diary-service.js";

const params = z.object({ localDate: reviewDateSchema });

export async function diaryRoutes(app: FastifyInstance, options: { diaryService: DiaryService }) {
  app.get("/diaries/:localDate", async (request, reply) => {
    const value = params.safeParse(request.params);
    if (!value.success) return reply.status(400).send({ error: "invalid_diary_date" });
    return options.diaryService.getByLocalDate(value.data.localDate);
  });

  app.put("/diaries/:localDate", async (request, reply) => {
    const value = params.safeParse(request.params);
    const input = saveCyberDiarySchema.safeParse(request.body);
    if (!value.success || !input.success) return reply.status(400).send({ error: "invalid_cyber_diary", details: input.success ? undefined : input.error.flatten() });
    try {
      const diary = await options.diaryService.save(value.data.localDate, input.data.reviewSessionId, input.data.briefId, input.data.content);
      return reply.status(200).send({ diary });
    } catch (error) {
      if (error instanceof DiaryPrerequisiteError) return reply.status(409).send({ error: error.code });
      throw error;
    }
  });
}
