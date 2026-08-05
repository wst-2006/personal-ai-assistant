import { sql } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { recordFocusNoResponseOutcome } from "@personal-ai/db/focus-no-response";

export type ReminderJob = { id: string; taskId: string | null; channel: string; kind: string; attempts: number; scheduleRevision: number; scheduledAt: Date; payload: unknown };
export type ReminderDeliveryContext = { now: Date; timing: "upcoming" | "in_progress" };
export type ReminderDeliveryProvider = { deliver(job: ReminderJob, context: ReminderDeliveryContext): Promise<void> };

export function reminderRetryAt(now: Date): Date {
  return new Date(now.getTime() + 60_000);
}

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
    const row = result.rows[0] as (Omit<ReminderJob, "scheduledAt"> & { scheduledAt: Date | string }) | undefined;
    return row ? { ...row, scheduledAt: new Date(row.scheduledAt) } : null;
  }

  async markSent(id: string, sentAt = new Date()) {
    await this.db.execute(sql`UPDATE reminder_jobs SET status = 'sent', sent_at = ${sentAt}, updated_at = ${sentAt} WHERE id = ${id} AND status = 'processing'`);
  }

  async markFailed(id: string, error: string, now = new Date()) {
    const retryAt = reminderRetryAt(now);
    await this.db.execute(sql`UPDATE reminder_jobs SET status = CASE WHEN attempts >= ${this.maxAttempts} THEN 'failed' ELSE 'pending' END, available_at = ${retryAt}, last_error = ${error.slice(0, 1000)}, updated_at = ${now} WHERE id = ${id} AND status = 'processing'`);
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
    if (job.kind !== "task_follow_up" && new Date(task.endAt).getTime() <= now.getTime()) {
      return { eligible: false, reason: "task has already ended" };
    }
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
      if (job.kind === "task_follow_up") {
        await this.processTaskFollowUp(job, now);
        await this.markSent(job.id, now);
        return "sent";
      }
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

  private async processTaskFollowUp(job: ReminderJob, now: Date): Promise<void> {
    if (!job.taskId) throw new Error("task follow-up has no task");
    await this.db.transaction(async (transaction) => {
      const db = transaction as unknown as AppDatabase;
      const taskResult = await db.execute(sql`
        SELECT id, start_at AS "startAt", end_at AS "endAt"
        FROM tasks
        WHERE id = ${job.taskId} AND deleted_at IS NULL AND lifecycle_status = 'open'
          AND schedule_kind = 'exact' AND schedule_revision = ${job.scheduleRevision}
        LIMIT 1
      `);
      const task = taskResult.rows[0] as { id: string; startAt: Date; endAt: Date } | undefined;
      if (!task || new Date(task.startAt).getTime() !== job.scheduledAt.getTime()) return;

      const sessionResult = await db.execute(sql`
        SELECT id, state, version
        FROM focus_sessions
        WHERE task_id = ${task.id}
          AND planned_start_at = ${task.startAt}
          AND planned_end_at = ${task.endAt}
        ORDER BY created_at DESC
        LIMIT 1
      `);
      const session = sessionResult.rows[0] as { id: string; state: string; version: number } | undefined;
      if (session && session.state !== "reminded" && session.state !== "stopped_no_response") return;

      let focusSessionId = session?.id;
      if (session?.state === "reminded") {
        const stopped = await db.execute(sql`
          UPDATE focus_sessions
          SET state = 'stopped_no_response', ended_at = ${now},
            stopped_reason = '任务开始 5 分钟未响应', version = version + 1, updated_at = ${now}
          WHERE id = ${session.id} AND version = ${session.version} AND state = 'reminded'
          RETURNING id
        `);
        if (stopped.rows.length === 0) return;
      } else if (!session) {
        const created = await db.execute(sql`
          INSERT INTO focus_sessions (
            id, task_id, state, planned_start_at, planned_end_at, ended_at,
            stopped_reason, raw_active_seconds, effective_focus_seconds, version,
            created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${task.id}, 'stopped_no_response', ${task.startAt}, ${task.endAt}, ${now},
            '任务开始 5 分钟未响应', 0, 0, 1, ${now}, ${now}
          )
          RETURNING id
        `);
        focusSessionId = (created.rows[0] as { id: string } | undefined)?.id;
      }
      if (!focusSessionId) return;
      await recordFocusNoResponseOutcome(db, {
        taskId: task.id,
        focusSessionId,
        now,
        reason: "任务开始 5 分钟未响应"
      });
    });
  }
}
