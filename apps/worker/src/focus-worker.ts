import { sql } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";

export type FocusTimerJob = {
  id: string;
  focusSessionId: string;
  kind: "preparation_complete" | "confirmation_timeout" | "segment_transition";
  expectedSessionVersion: number;
  dueAt: Date;
  attempts: number;
};

export class FocusTimerWorker {
  constructor(private readonly db: AppDatabase, private readonly maxAttempts = 3) {}

  async claimDueJob(now = new Date()): Promise<FocusTimerJob | null> {
    const result = await this.db.execute(sql`
      WITH next_job AS (
        SELECT id FROM focus_timer_jobs
        WHERE status = 'pending' AND due_at <= ${now}
        ORDER BY due_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE focus_timer_jobs AS job
      SET status = 'processing', attempts = job.attempts + 1, updated_at = ${now}
      FROM next_job
      WHERE job.id = next_job.id
      RETURNING job.id, job.focus_session_id AS "focusSessionId", job.kind,
        job.expected_session_version AS "expectedSessionVersion", job.due_at AS "dueAt", job.attempts
    `);
    return (result.rows[0] as FocusTimerJob | undefined) ?? null;
  }

  async processNext(now = new Date()): Promise<"idle" | "completed" | "cancelled" | "retry"> {
    const job = await this.claimDueJob(now);
    if (!job) return "idle";
    try {
      const sessionResult = await this.db.execute(sql`
        SELECT id, task_id AS "taskId", state, version,
          started_at AS "startedAt", active_since_at AS "activeSinceAt"
        FROM focus_sessions WHERE id = ${job.focusSessionId} LIMIT 1
      `);
      const session = sessionResult.rows[0] as {
        id: string; taskId: string; state: string; version: number;
        startedAt: Date | null; activeSinceAt: Date | null;
      } | undefined;
      if (!session || session.version !== job.expectedSessionVersion) {
        await this.cancelJob(job.id, "focus session version changed", now);
        return "cancelled";
      }

      if (job.kind === "confirmation_timeout") {
        if (session.state !== "reminded") {
          await this.cancelJob(job.id, "focus session is no longer awaiting confirmation", now);
          return "cancelled";
        }
        await this.db.execute(sql`
          UPDATE focus_sessions
          SET state = 'stopped_no_response', ended_at = ${now}, stopped_reason = '5 分钟未响应',
            version = version + 1, updated_at = ${now}
          WHERE id = ${session.id} AND version = ${job.expectedSessionVersion} AND state = 'reminded'
        `);
        await this.completeJob(job.id, now);
        return "completed";
      }

      if (job.kind === "preparation_complete") {
        if (session.state !== "preparing") {
          await this.cancelJob(job.id, "focus session is no longer preparing", now);
          return "cancelled";
        }
        const taskResult = await this.db.execute(sql`
          SELECT id, lifecycle_status AS "lifecycleStatus", end_at AS "endAt"
          FROM tasks WHERE id = ${session.taskId} AND deleted_at IS NULL LIMIT 1
        `);
        const task = taskResult.rows[0] as { id: string; lifecycleStatus: string; endAt: Date | null } | undefined;
        if (!task || task.lifecycleStatus !== "open" || (task.endAt && new Date(task.endAt).getTime() <= now.getTime())) {
          await this.cancelJob(job.id, "task cannot start focus anymore", now);
          return "cancelled";
        }
        await this.db.execute(sql`
          UPDATE focus_sessions
          SET state = 'running', started_at = ${now}, active_since_at = ${now},
            version = version + 1, updated_at = ${now}
          WHERE id = ${session.id} AND version = ${job.expectedSessionVersion} AND state = 'preparing'
        `);
        await this.db.execute(sql`
          UPDATE tasks
          SET lifecycle_status = 'active', version = version + 1, updated_at = ${now}
          WHERE id = ${task.id} AND lifecycle_status = 'open'
        `);
        await this.completeJob(job.id, now);
        return "completed";
      }

      await this.cancelJob(job.id, "segment transitions are handled by the session executor", now);
      return "cancelled";
    } catch (error) {
      await this.failJob(job.id, error instanceof Error ? error.message : "unknown focus timer error", job.attempts, now);
      return "retry";
    }
  }

  private async completeJob(id: string, now: Date): Promise<void> {
    await this.db.execute(sql`UPDATE focus_timer_jobs SET status = 'completed', updated_at = ${now} WHERE id = ${id} AND status = 'processing'`);
  }

  private async cancelJob(id: string, reason: string, now: Date): Promise<void> {
    await this.db.execute(sql`UPDATE focus_timer_jobs SET status = 'cancelled', last_error = ${reason.slice(0, 1000)}, updated_at = ${now} WHERE id = ${id} AND status = 'processing'`);
  }

  private async failJob(id: string, reason: string, attempts: number, now: Date): Promise<void> {
    const status = attempts >= this.maxAttempts ? "failed" : "pending";
    await this.db.execute(sql`
      UPDATE focus_timer_jobs
      SET status = ${status}, due_at = ${now} + interval '1 minute', last_error = ${reason.slice(0, 1000)}, updated_at = ${now}
      WHERE id = ${id} AND status = 'processing'
    `);
  }
}
