import { inboxEntries } from "@personal-ai/db/schema";
import type { AppDatabase } from "@personal-ai/db/client";
import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, asc, eq, isNull } from "drizzle-orm";

const createSchema = z.object({
  entryKind: z.enum(["idea", "question"]),
  content: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(4000).nullable().optional()
}).strict();

type InboxRoutesOptions = { database: AppDatabase };

export const inboxRoutes: FastifyPluginAsync<InboxRoutesOptions> = async (app, options) => {
  app.get("/inbox-entries", async () => options.database
    .select()
    .from(inboxEntries)
    .where(and(isNull(inboxEntries.deletedAt), isNull(inboxEntries.convertedAt)))
    .orderBy(asc(inboxEntries.createdAt)));

  app.post("/inbox-entries", async (request, reply) => {
    const input = createSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: "invalid_inbox_entry", issues: input.error.issues });
    const [entry] = await options.database.insert(inboxEntries).values({
      id: randomUUID(),
      entryKind: input.data.entryKind,
      content: input.data.content,
      notes: input.data.notes ?? null
    }).returning();
    return reply.status(201).send({ entry });
  });
};
