import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DesktopCommandService, type StoredDesktopCommand } from "./desktop-command-service.js";

const clientSchema = z.object({ clientId: z.string().trim().min(1).max(128) });
const paramsSchema = z.object({ id: z.string().uuid() });

export async function desktopCommandRoutes(app: FastifyInstance, options: { desktopCommandService: DesktopCommandService }) {
  app.get("/desktop-commands/pending", async (request, reply) => {
    const query = clientSchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: "invalid_desktop_command_client" });
    const command = await options.desktopCommandService.claimNext(query.data.clientId);
    return { command: command ? serialize(command) : null };
  });

  app.post("/desktop-commands/:id/complete", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = clientSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: "invalid_desktop_command_completion" });
    const completed = await options.desktopCommandService.complete(params.data.id, body.data.clientId);
    if (!completed) return reply.status(409).send({ error: "desktop_command_claim_conflict" });
    return { completed: true };
  });
}

function serialize(command: StoredDesktopCommand) {
  return {
    ...command,
    claimedAt: command.claimedAt?.toISOString() ?? null,
    expiresAt: command.expiresAt.toISOString(),
    completedAt: command.completedAt?.toISOString() ?? null,
    createdAt: command.createdAt.toISOString(),
    updatedAt: command.updatedAt.toISOString()
  };
}
