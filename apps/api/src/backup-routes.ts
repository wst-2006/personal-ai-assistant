import type { FastifyInstance } from "fastify";
import type { BackupExporter } from "./backup-service.js";

function backupFilename(exportedAt: string): string {
  return `personal-ai-assistant-backup-${exportedAt.replace(/[-:.]/g, "")}.json`;
}

export async function backupRoutes(app: FastifyInstance, options: { backupService: BackupExporter }) {
  app.get("/backups/export", async (_request, reply) => {
    const backup = await options.backupService.export();
    reply
      .header("cache-control", "no-store")
      .header("content-disposition", `attachment; filename="${backupFilename(backup.exportedAt)}"`)
      .type("application/json; charset=utf-8");
    return reply.send(backup);
  });
}
