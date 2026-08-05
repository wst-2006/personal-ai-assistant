import { randomUUID } from "node:crypto";
import type { AppDatabase } from "@personal-ai/db/client";
import { reminderJobs, tasks } from "@personal-ai/db/schema";
import { and, eq, inArray } from "drizzle-orm";

type SchedulableTask = typeof tasks.$inferSelect;

export async function syncTaskStartReminder(db: AppDatabase, task: SchedulableTask, now = new Date()): Promise<void> {
  const channel = "feishu";
  const kinds: string[] = ["task_start", "task_follow_up"];
  const shouldSchedule = !task.deletedAt
    && task.lifecycleStatus === "open"
    && task.scheduleKind === "exact"
    && Boolean(task.startAt && task.endAt);
  if (!shouldSchedule) {
    await db.update(reminderJobs).set({ status: "cancelled", updatedAt: now })
      .where(and(
        eq(reminderJobs.taskId, task.id),
        eq(reminderJobs.channel, channel),
        inArray(reminderJobs.kind, kinds),
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
  await upsertReminder(db, task, "task_start", startAt, availableAt, payload, now);
  await upsertReminder(db, task, "task_follow_up", startAt, new Date(startAt.getTime() + 5 * 60_000), payload, now);
}

export async function cancelTaskFollowUp(db: AppDatabase, taskId: string, now = new Date()): Promise<void> {
  await db.update(reminderJobs).set({ status: "cancelled", updatedAt: now })
    .where(and(
      eq(reminderJobs.taskId, taskId),
      eq(reminderJobs.channel, "feishu"),
      eq(reminderJobs.kind, "task_follow_up"),
      inArray(reminderJobs.status, ["pending", "processing", "failed"])
    ));
}

async function upsertReminder(
  db: AppDatabase,
  task: SchedulableTask,
  kind: "task_start" | "task_follow_up",
  scheduledAt: Date,
  availableAt: Date,
  payload: Record<string, unknown>,
  now: Date
): Promise<void> {
  await db.insert(reminderJobs).values({
    id: randomUUID(), taskId: task.id, channel: "feishu", kind,
    scheduleRevision: task.scheduleRevision, status: "pending", scheduledAt, availableAt,
    attempts: 0, payload, lastError: null, sentAt: null, updatedAt: now
  }).onConflictDoUpdate({
    target: [reminderJobs.taskId, reminderJobs.channel, reminderJobs.kind],
    set: {
      scheduleRevision: task.scheduleRevision, status: "pending", scheduledAt, availableAt,
      attempts: 0, payload, lastError: null, sentAt: null, updatedAt: now
    }
  });
}
