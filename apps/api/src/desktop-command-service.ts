import { and, asc, eq, gt, inArray, lte, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AppDatabase } from "@personal-ai/db/client";
import { desktopCommandRequests, tasks } from "@personal-ai/db/schema";

const commandTtlMs = 10 * 60 * 1000;

export type StoredDesktopCommand = typeof desktopCommandRequests.$inferSelect;

export class DesktopCommandService {
  constructor(private readonly db: AppDatabase) {}

  async requestOpenTask(taskId: string, scheduleRevision: number): Promise<StoredDesktopCommand> {
    const now = new Date();
    const [command] = await this.db.insert(desktopCommandRequests).values({
      id: randomUUID(),
      kind: "open_task",
      taskId,
      scheduleRevision,
      status: "pending",
      expiresAt: new Date(now.getTime() + commandTtlMs),
      createdAt: now,
      updatedAt: now
    }).returning();
    if (!command) throw new Error("desktop_command_create_failed");
    return command;
  }

  async claimNext(clientId: string): Promise<StoredDesktopCommand | null> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      await transaction.update(desktopCommandRequests).set({
        status: "expired",
        updatedAt: now
      }).where(and(
        inArray(desktopCommandRequests.status, ["pending", "claimed"]),
        lte(desktopCommandRequests.expiresAt, now)
      ));

      const [candidate] = await transaction.select().from(desktopCommandRequests)
        .where(and(
          or(
            eq(desktopCommandRequests.status, "pending"),
            and(eq(desktopCommandRequests.status, "claimed"), eq(desktopCommandRequests.claimedBy, clientId))
          ),
          gt(desktopCommandRequests.expiresAt, now)
        ))
        .orderBy(asc(desktopCommandRequests.createdAt), asc(desktopCommandRequests.id))
        .limit(1);
      if (!candidate) return null;

      const [task] = await transaction.select({ id: tasks.id, scheduleRevision: tasks.scheduleRevision, deletedAt: tasks.deletedAt })
        .from(tasks).where(eq(tasks.id, candidate.taskId)).limit(1);
      if (!task || task.deletedAt || task.scheduleRevision !== candidate.scheduleRevision) {
        await transaction.update(desktopCommandRequests).set({ status: "expired", updatedAt: now })
          .where(eq(desktopCommandRequests.id, candidate.id));
        return null;
      }

      if (candidate.status === "claimed") return candidate;
      const [claimed] = await transaction.update(desktopCommandRequests).set({
        status: "claimed",
        claimedBy: clientId,
        claimedAt: now,
        updatedAt: now
      }).where(and(eq(desktopCommandRequests.id, candidate.id), eq(desktopCommandRequests.status, "pending"))).returning();
      return claimed ?? null;
    });
  }

  async complete(id: string, clientId: string): Promise<boolean> {
    const [completed] = await this.db.update(desktopCommandRequests).set({
      status: "completed",
      completedAt: new Date(),
      updatedAt: new Date()
    }).where(and(
      eq(desktopCommandRequests.id, id),
      eq(desktopCommandRequests.status, "claimed"),
      eq(desktopCommandRequests.claimedBy, clientId)
    )).returning({ id: desktopCommandRequests.id });
    if (completed) return true;

    const [existing] = await this.db.select({ status: desktopCommandRequests.status, claimedBy: desktopCommandRequests.claimedBy })
      .from(desktopCommandRequests).where(eq(desktopCommandRequests.id, id)).limit(1);
    return existing?.status === "completed" && existing.claimedBy === clientId;
  }
}
