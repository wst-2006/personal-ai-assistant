import { sql } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";

export type ReminderJob = { id: string; taskId: string | null; channel: string; kind: string; attempts: number; payload: unknown };

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
      RETURNING job.id, job.task_id AS "taskId", job.channel, job.kind, job.attempts, job.payload
    `);
    return (result.rows[0] as ReminderJob | undefined) ?? null;
  }

  async markSent(id: string, sentAt = new Date()) {
    await this.db.execute(sql`UPDATE reminder_jobs SET status = 'sent', sent_at = ${sentAt}, updated_at = ${sentAt} WHERE id = ${id} AND status = 'processing'`);
  }

  async markFailed(id: string, error: string, now = new Date()) {
    await this.db.execute(sql`UPDATE reminder_jobs SET status = CASE WHEN attempts >= ${this.maxAttempts} THEN 'failed' ELSE 'pending' END, available_at = ${now} + interval '1 minute', last_error = ${error.slice(0, 1000)}, updated_at = ${now} WHERE id = ${id} AND status = 'processing'`);
  }
}
