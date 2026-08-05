import { sql } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";

export type ReminderJob = { id: string; taskId: string | null; channel: string; kind: string; attempts: number; scheduleRevision: number; scheduledAt: Date; payload: unknown };
export type ReminderDeliveryContext = { now: Date; timing: "upcoming" | "in_progress" };
export type ReminderDeliveryProvider = { deliver(job: ReminderJob, context: ReminderDeliveryContext): Promise<void> };

export class ReminderWorker {
  constructor(private readonly db: AppDatabase, private readonly maxAttempts = 3) {}

  async claimDueJob(now = new Date()): Promise<ReminderJob | null> {
    const result = await this.db.execute(sql`
      WITH next_job AS (
        SELECT id FROM reminder_jobs WHERE status = 'pending' AND available_at <= ${now}
        ORDER BY available_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE reminder_jobs AS job
      SET status = 'processing', attempts = job.attempts + 1, updated_at = ${now}
      FROM next_job WHERE job.id = next_job.id
      RETURNING job.id, job.task_id AS "taskId", job.channel, job.kind, job.attempts,
        job.schedule_revision AS "scheduleRevision", job.scheduled_at AS "scheduledAt", job.payload
    `);
    return (result.rows[0] as ReminderJob | undefined) ?? null;
  }

  async markSent(id: string, sentAt = new Date()) {
    await this.db.execute(sql`UPDATE reminder_jobs SET status = 'sent', sent_at = ${sentAt}, updated_at = ${sentAt} WHERE id = ${id} AND status = 'processing'`);
  }

  async markFailed(id: string, error: string, now = new Date()) {
    await this.db.execute(sql`UPDATE reminder_jobs SET status = CASE WHEN attempts >= ${this.maxAttempts} THEN 'failed' ELSE 'pending' END, available_at = ${now} + interval '1 minute', last_error = ${error.slice(0, 1000)}, updated_at = ${now} WHERE id = ${id} AND status = 'processing'`);
  }

  async markCancelled(id: string, reason: string, now = new Date()) {
    await this.db.execute(sql`UPDATE reminder_jobs SET status = 'cancelled', last_error = ${reason.slice(0, 1000)}, updated_at = ${now} WHERE id = ${id} AND status = 'processing'`);
  }

  async deliveryEligibility(job: ReminderJob, now = new Date()): Promise<{ eligible: boolean; reason?: string }> {
    if (!job.taskId) return { eligible: false, reason: "reminder has no task" };
    const result = await this.db.execute(sql`
      SELECT schedule_revision AS "scheduleRevision", lifecycle_status AS "lifecycleStatus",
        schedule_kind AS "scheduleKind", start_at AS "startAt", end_at AS "endAt", deleted_at AS "deletedAt"
      FROM tasks WHERE id = ${job.taskId} LIMIT 1
    `);
    const task = result.rows[0] as {
      scheduleRevision: number;
      lifecycleStatus: string;
      scheduleKind: string;
      startAt: Date | string | null;
      endAt: Date | string | null;
      deletedAt: Date | string | null;
    } | undefined;
    if (!task) return { eligible: false, reason: "task no longer exists" };
    if (task.deletedAt) return { eligible: false, reason: "task was deleted" };
    if (task.lifecycleStatus !== "open" || task.scheduleKind !== "exact") return { eligible: false, reason: "task is no longer an open exact task" };
    if (task.scheduleRevision !== job.scheduleRevision) return { eligible: false, reason: "task schedule revision changed" };
    if (!task.startAt || !task.endAt) return { eligible: false, reason: "task exact interval is missing" };
    if (new Date(task.startAt).getTime() !== new Date(job.scheduledAt).getTime()) return { eligible: false, reason: "task start time changed" };
    if (new Date(task.endAt).getTime() <= now.getTime()) return { eligible: false, reason: "task has already ended" };
    return { eligible: true };
  }

  async processNext(provider: ReminderDeliveryProvider, now = new Date()): Promise<"idle" | "sent" | "cancelled" | "retry"> {
    const job = await this.claimDueJob(now);
    if (!job) return "idle";
    const eligibility = await this.deliveryEligibility(job, now);
    if (!eligibility.eligible) {
      await this.markCancelled(job.id, eligibility.reason ?? "reminder is stale", now);
      return "cancelled";
    }
    try {
      await provider.deliver(job, {
        now,
        timing: now.getTime() < job.scheduledAt.getTime() ? "upcoming" : "in_progress"
      });
      await this.markSent(job.id, now);
      return "sent";
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown reminder delivery error";
      await this.markFailed(job.id, message, now);
      return "retry";
    }
  }
}
