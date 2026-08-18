import { randomUUID } from "node:crypto";
import type { AppDatabase } from "@personal-ai/db/client";
import { reminderJobs, tasks, userProfiles } from "@personal-ai/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";

type SchedulableTask = typeof tasks.$inferSelect;
type TaskStartCardState = "started";

export async function syncTaskStartReminder(db: AppDatabase, task: SchedulableTask, now = new Date()): Promise<void> {
  const channel = "feishu";
  const kinds: string[] = ["task_start", "task_start_ready", "task_start_lapsed", "task_start_expire"];
  const settings = await focusIntegrationSettings(db);
  const shouldSchedule = !task.deletedAt
    && task.recordKind === "formal"
    && task.lifecycleStatus === "open"
    && task.scheduleKind === "exact"
    && Boolean(task.startAt && task.endAt)
    && (settings.desktopFocusEnabled || settings.feishuTaskCardsEnabled);
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
  await syncReminderKind(db, task, "task_start", settings.feishuTaskCardsEnabled && settings.feishuT15Enabled, startAt, availableAt, payload, now);
  await syncReminderKind(db, task, "task_start_ready", true, startAt, new Date(startAt.getTime() - 60_000), payload, now);
  await syncReminderKind(db, task, "task_start_lapsed", settings.feishuTaskCardsEnabled, startAt, startAt, payload, now);
  await syncReminderKind(db, task, "task_start_expire", true, startAt, task.endAt!, payload, now);
}

export async function cancelTaskFollowUp(db: AppDatabase, taskId: string, now = new Date()): Promise<void> {
  await db.update(reminderJobs).set({ status: "cancelled", updatedAt: now })
    .where(and(
      eq(reminderJobs.taskId, taskId),
      eq(reminderJobs.channel, "feishu"),
      inArray(reminderJobs.kind, ["task_start_lapsed", "task_start_expire"]),
      inArray(reminderJobs.status, ["pending", "processing", "failed"])
    ));
}

export async function queueTaskStartCardUpdate(
  db: AppDatabase,
  task: SchedulableTask,
  cardState: TaskStartCardState,
  now = new Date()
): Promise<void> {
  const settings = await focusIntegrationSettings(db);
  if (!settings.feishuTaskCardsEnabled) return;
  if (!task.startAt || !task.endAt || task.scheduleKind !== "exact") return;
  const payload = {
    taskId: task.id,
    title: task.title,
    startAt: task.startAt.toISOString(),
    endAt: task.endAt.toISOString(),
    timeZone: task.timeZone,
    scheduleRevision: task.scheduleRevision,
    cardState
  };
  await db.insert(reminderJobs).values({
    id: randomUUID(),
    taskId: task.id,
    channel: "feishu",
    kind: "task_start_lapsed",
    scheduleRevision: task.scheduleRevision,
    status: "pending",
    scheduledAt: task.startAt,
    availableAt: now,
    attempts: 0,
    payload,
    lastError: null,
    sentAt: null,
    updatedAt: now
  }).onConflictDoUpdate({
    target: [reminderJobs.taskId, reminderJobs.channel, reminderJobs.kind],
    set: {
      scheduleRevision: task.scheduleRevision,
      status: "pending",
      scheduledAt: task.startAt,
      availableAt: now,
      attempts: 0,
      payload,
      lastError: null,
      sentAt: null,
      updatedAt: now
    }
  });
}

async function syncReminderKind(
  db: AppDatabase,
  task: SchedulableTask,
  kind: "task_start" | "task_start_ready" | "task_start_lapsed" | "task_start_expire",
  enabled: boolean,
  scheduledAt: Date,
  availableAt: Date,
  payload: Record<string, unknown>,
  now: Date,
) {
  if (enabled) {
    await upsertReminder(db, task, kind, scheduledAt, availableAt, payload, now);
    return;
  }
  await db.update(reminderJobs).set({ status: "cancelled", updatedAt: now })
    .where(and(
      eq(reminderJobs.taskId, task.id),
      eq(reminderJobs.channel, "feishu"),
      eq(reminderJobs.kind, kind),
      inArray(reminderJobs.status, ["pending", "processing", "failed"]),
    ));
}

export async function focusIntegrationSettings(db: AppDatabase) {
  const [profile] = await db.select({
    desktopFocusEnabled: userProfiles.desktopFocusEnabled,
    feishuTaskCardsEnabled: userProfiles.feishuTaskCardsEnabled,
    feishuT15Enabled: userProfiles.feishuT15Enabled,
    focusEvaluationEnabled: userProfiles.focusEvaluationEnabled,
  }).from(userProfiles).where(eq(userProfiles.id, 1)).limit(1);
  return profile ?? {
    desktopFocusEnabled: true,
    feishuTaskCardsEnabled: true,
    feishuT15Enabled: true,
    focusEvaluationEnabled: true,
  };
}

async function upsertReminder(
  db: AppDatabase,
  task: SchedulableTask,
  kind: "task_start" | "task_start_ready" | "task_start_lapsed" | "task_start_expire",
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
      scheduleRevision: task.scheduleRevision,
      status: sql`CASE WHEN ${reminderJobs.scheduleRevision} <> EXCLUDED.schedule_revision THEN 'pending' ELSE ${reminderJobs.status} END`,
      scheduledAt,
      availableAt,
      attempts: sql`CASE WHEN ${reminderJobs.scheduleRevision} <> EXCLUDED.schedule_revision THEN 0 ELSE ${reminderJobs.attempts} END`,
      payload,
      remoteMessageId: sql`CASE WHEN ${reminderJobs.scheduleRevision} <> EXCLUDED.schedule_revision THEN NULL ELSE ${reminderJobs.remoteMessageId} END`,
      lastError: sql`CASE WHEN ${reminderJobs.scheduleRevision} <> EXCLUDED.schedule_revision THEN NULL ELSE ${reminderJobs.lastError} END`,
      sentAt: sql`CASE WHEN ${reminderJobs.scheduleRevision} <> EXCLUDED.schedule_revision THEN NULL ELSE ${reminderJobs.sentAt} END`,
      updatedAt: now
    }
  });
}
