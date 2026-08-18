import type { AppDatabase } from "@personal-ai/db/client";
import { sql } from "drizzle-orm";

export type RecycleRetentionResult = { purgedCount: number; retentionDays: number };

/**
 * Permanently removes task records after the user-controlled recycle window.
 * The whole dependency cleanup is one transaction so a partial purge cannot
 * leave a task in a half-deleted state.
 */
export class RecycleRetentionWorker {
  constructor(private readonly db: AppDatabase) {}

  async processNext(now = new Date()): Promise<RecycleRetentionResult | "idle"> {
    return this.db.transaction(async (transaction) => {
      const retentionResult = await transaction.execute(sql`
        SELECT coalesce(
          (SELECT recycle_retention_days FROM user_profiles WHERE id = 1),
          3
        )::integer AS "retentionDays"
      `);
      const retentionDays = Number((retentionResult.rows[0] as { retentionDays?: number } | undefined)?.retentionDays ?? 3);
      const candidates = await transaction.execute(sql`
        SELECT id
        FROM tasks
        WHERE deleted_at IS NOT NULL
          AND deleted_at <= CAST(${now} AS timestamptz)
            - make_interval(days => CAST(${retentionDays} AS integer))
        ORDER BY deleted_at, id
        LIMIT 25
        FOR UPDATE SKIP LOCKED
      `);
      const taskIds = candidates.rows.map((row) => String((row as { id: string }).id));
      if (taskIds.length === 0) return "idle";
      const taskIdList = sql.join(taskIds.map((taskId) => sql`${taskId}::uuid`), sql`, `);

      await transaction.execute(sql`DELETE FROM task_conflict_acceptances WHERE task_id_low IN (${taskIdList}) OR task_id_high IN (${taskIdList})`);
      await transaction.execute(sql`DELETE FROM reminder_jobs WHERE task_id IN (${taskIdList})`);
      await transaction.execute(sql`DELETE FROM task_feedback WHERE task_id IN (${taskIdList})`);
      await transaction.execute(sql`DELETE FROM task_outcomes WHERE task_id IN (${taskIdList})`);
      await transaction.execute(sql`DELETE FROM task_lifecycle_events WHERE task_id IN (${taskIdList})`);
      await transaction.execute(sql`
        DELETE FROM focus_session_operations
        WHERE focus_session_id IN (SELECT id FROM focus_sessions WHERE task_id IN (${taskIdList}))
      `);
      await transaction.execute(sql`
        DELETE FROM focus_timer_jobs
        WHERE focus_session_id IN (SELECT id FROM focus_sessions WHERE task_id IN (${taskIdList}))
      `);
      await transaction.execute(sql`
        DELETE FROM focus_session_segment_runs
        WHERE focus_session_id IN (SELECT id FROM focus_sessions WHERE task_id IN (${taskIdList}))
      `);
      await transaction.execute(sql`DELETE FROM focus_sessions WHERE task_id IN (${taskIdList})`);
      await transaction.execute(sql`
        DELETE FROM focus_structure_segments
        WHERE focus_structure_id IN (SELECT id FROM focus_structures WHERE task_id IN (${taskIdList}))
      `);
      await transaction.execute(sql`DELETE FROM focus_structures WHERE task_id IN (${taskIdList})`);
      await transaction.execute(sql`DELETE FROM task_legacy_metadata WHERE task_id IN (${taskIdList})`);
      await transaction.execute(sql`DELETE FROM tasks WHERE id IN (${taskIdList}) AND deleted_at IS NOT NULL`);

      return { purgedCount: taskIds.length, retentionDays };
    });
  }
}
