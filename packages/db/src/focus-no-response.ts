import { sql } from "drizzle-orm";
import type { AppDatabase } from "./client.js";

type FocusNoResponseInput = {
  taskId: string;
  focusSessionId: string;
  now: Date;
  reason: string;
};

/**
 * Persists the task-side consequence of an unanswered focus reminder. Both
 * the API fallback and the timer worker use this command inside their own
 * transaction, so a stopped reminder cannot leave the task silently open.
 */
export async function recordFocusNoResponseOutcome(db: AppDatabase, input: FocusNoResponseInput): Promise<boolean> {
  const taskResult = await db.execute(sql`
    SELECT id, lifecycle_status AS "lifecycleStatus", version
    FROM tasks
    WHERE id = ${input.taskId} AND deleted_at IS NULL
    LIMIT 1
  `);
  const task = taskResult.rows[0] as { id: string; lifecycleStatus: string; version: number } | undefined;
  if (!task || !["open", "active"].includes(task.lifecycleStatus)) return false;

  const closedResult = await db.execute(sql`
    UPDATE tasks
    SET lifecycle_status = 'closed', current_outcome = 'not_completed',
      version = version + 1, schedule_revision = schedule_revision + 1,
      updated_at = ${input.now}
    WHERE id = ${task.id} AND version = ${task.version}
      AND lifecycle_status IN ('open', 'active')
    RETURNING id
  `);
  if (closedResult.rows.length === 0) return false;

  await db.execute(sql`
    INSERT INTO task_outcomes (id, task_id, focus_session_id, outcome, progress_percent, source, note, recorded_at)
    VALUES (gen_random_uuid(), ${task.id}, ${input.focusSessionId}, 'not_completed', 0, 'system', ${input.reason}, ${input.now})
  `);
  await db.execute(sql`
    INSERT INTO task_lifecycle_events (id, task_id, from_status, to_status, source, reason, created_at)
    VALUES (gen_random_uuid(), ${task.id}, ${task.lifecycleStatus}, 'closed', 'system', ${input.reason}, ${input.now})
  `);
  return true;
}
