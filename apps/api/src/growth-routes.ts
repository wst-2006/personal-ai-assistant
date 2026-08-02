import type { FastifyInstance } from "fastify";
import { reviewDateSchema } from "@personal-ai/domain/review";
import { z } from "zod";
import { GrowthService } from "./growth-service.js";

const query = z.object({
  endDate: reviewDateSchema,
  days: z.coerce.number().int().refine((value): value is 7 | 30 => value === 7 || value === 30).default(7)
});

export async function growthRoutes(app: FastifyInstance, options: { growthService: GrowthService }) {
  app.get("/growth/summary", async (request, reply) => {
    const input = query.safeParse(request.query);
    if (!input.success) return reply.status(400).send({ error: "invalid_growth_date" });
    return { summary: await options.growthService.getSummary(input.data.endDate, input.data.days) };
  });
}
