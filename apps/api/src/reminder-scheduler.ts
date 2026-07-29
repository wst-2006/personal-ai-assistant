import { randomUUID } from "node:crypto";
import type { AppDatabase } from "@personal-ai/db/client";
import { reminderJobs, tasks } from "@personal-ai/db/schema";
import { and, eq, inArray } from "drizzle-orm";

type SchedulableTask = typeof tasks.$inferSelect;

export async function syncTaskStartReminder(db: AppDatabase, task: SchedulableTask, now = new Date()): Promise<void> {
  const channel = "feishu";
  const kind = "task_start";
  const shouldSchedule = !task.deletedAt
    && task.lifecycleStatus === "open"
    && task.scheduleKind === "exact"
    && Boolean(task.startAt && task.endAt);
  if (!shouldSchedule) {
    await db.update(reminderJobs).set({ status: "cancelled", updatedAt: now })
      .where(and(
        eq(reminderJobs.taskId, task.id),
        eq(reminderJobs.channel, channel),
        eq(reminderJobs.kind, kind),
        inArray(reminderJobs.status, ["pending", "processing", "failed"])
      ));
    return;
  }
  const startAt = task.startAt!;
  const availableAt = new Date(startAt.getTime() - 15 * 60 * 1000);
  const payload = {
    taskId: task.id,
    title: task.title,
    startAt: startAt.toISOString(),
    endAt: task.endAt!.toISOString(),
    timeZone: task.timeZone,
    scheduleRevision: task.scheduleRevision
  };
  await db.insert(reminderJobs).values({
    id: randomUUID(), taskId: task.id, channel, kind,
    scheduleRevision: task.scheduleRevision, status: "pending", scheduledAt: startAt, availableAt,
    attempts: 0, payload, lastError: null, sentAt: null, updatedAt: now
  }).onConflictDoUpdate({
    target: [reminderJobs.taskId, reminderJobs.channel, reminderJobs.kind],
    set: {
      scheduleRevision: task.scheduleRevision, status: "pending", scheduledAt: startAt, availableAt,
      attempts: 0, payload, lastError: null, sentAt: null, updatedAt: now
    }
  });
}
