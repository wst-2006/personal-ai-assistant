import type { FastifyInstance } from "fastify";
import { reviewDateSchema } from "@personal-ai/domain/review";
import { z } from "zod";
import { GrowthService } from "./growth-service.js";

const query = z.object({ endDate: reviewDateSchema.optional() });

export async function growthRoutes(app: FastifyInstance, options: { growthService: GrowthService }) {
  app.get("/growth/summary", async (request, reply) => {
    const input = query.safeParse(request.query);
    if (!input.success || !input.data.endDate) return reply.status(400).send({ error: "invalid_growth_date" });
    return { summary: await options.growthService.getSummary(input.data.endDate) };
  });
}
