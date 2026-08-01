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
      return await this.db.transaction(async (transaction) => this.processClaimedJob(
        transaction as unknown as AppDatabase,
        job,
        now
      ));
    } catch (error) {
      // The claimed job is outside the transaction, so record the retry after
      // the business transaction rolls back. The next poll can safely reclaim it.
      await this.failJob(this.db, job.id, error instanceof Error ? error.message : "unknown focus timer error", job.attempts, now);
      return "retry";
    }
  }

  private async processClaimedJob(
    db: AppDatabase,
    job: FocusTimerJob,
    now: Date
  ): Promise<"completed" | "cancelled"> {
      const sessionResult = await db.execute(sql`
        SELECT id, task_id AS "taskId", state, version,
          started_at AS "startedAt", active_since_at AS "activeSinceAt",
          planned_end_at AS "plannedEndAt", raw_active_seconds AS "rawActiveSeconds",
          focus_structure_id AS "focusStructureId", current_segment_position AS "currentSegmentPosition"
        FROM focus_sessions WHERE id = ${job.focusSessionId} LIMIT 1
      `);
      const session = sessionResult.rows[0] as {
        id: string; taskId: string; state: string; version: number;
        startedAt: Date | null; activeSinceAt: Date | null; plannedEndAt: Date | null;
        rawActiveSeconds: number; focusStructureId: string | null; currentSegmentPosition: number | null;
      } | undefined;
      if (!session || session.version !== job.expectedSessionVersion) {
        await this.cancelJob(db, job.id, "focus session version changed", now);
        return "cancelled";
      }

      if (job.kind === "confirmation_timeout") {
        if (session.state !== "reminded") {
          await this.cancelJob(db, job.id, "focus session is no longer awaiting confirmation", now);
          return "cancelled";
        }
        await db.execute(sql`
          UPDATE focus_sessions
          SET state = 'stopped_no_response', ended_at = ${now}, stopped_reason = '5 分钟未响应',
            version = version + 1, updated_at = ${now}
          WHERE id = ${session.id} AND version = ${job.expectedSessionVersion} AND state = 'reminded'
        `);
        await this.completeJob(db, job.id, now);
        return "completed";
      }

      if (job.kind === "preparation_complete") {
        if (session.state !== "preparing") {
          await this.cancelJob(db, job.id, "focus session is no longer preparing", now);
          return "cancelled";
        }
        const taskResult = await db.execute(sql`
          SELECT id, lifecycle_status AS "lifecycleStatus", end_at AS "endAt"
          FROM tasks WHERE id = ${session.taskId} AND deleted_at IS NULL LIMIT 1
        `);
        const task = taskResult.rows[0] as { id: string; lifecycleStatus: string; endAt: Date | null } | undefined;
        if (!task || task.lifecycleStatus !== "open" || (task.endAt && new Date(task.endAt).getTime() <= now.getTime())) {
          await this.cancelJob(db, job.id, "task cannot start focus anymore", now);
          return "cancelled";
        }
        const startedResult = await db.execute(sql`
          UPDATE focus_sessions
          SET state = 'running', started_at = ${now}, active_since_at = ${now},
            version = version + 1, updated_at = ${now}
          WHERE id = ${session.id} AND version = ${job.expectedSessionVersion} AND state = 'preparing'
          RETURNING id
        `);
        if (startedResult.rows.length === 0) throw new Error("focus session version changed while starting");
        const activationResult = await db.execute(sql`
          UPDATE tasks
          SET lifecycle_status = 'active', version = version + 1, updated_at = ${now}
          WHERE id = ${task.id} AND lifecycle_status = 'open'
          RETURNING id
        `);
        if (activationResult.rows.length > 0) {
          await db.execute(sql`
            INSERT INTO task_lifecycle_events (id, task_id, from_status, to_status, source, reason)
            VALUES (gen_random_uuid(), ${task.id}, 'open', 'active', 'system', 'focus preparation completed')
          `);
        }
        if (session.focusStructureId) {
          const structureResult = await db.execute(sql`
            SELECT total_start_at AS "totalStartAt"
            FROM focus_structures WHERE id = ${session.focusStructureId} AND state = 'active' LIMIT 1
          `);
          const segmentsResult = await db.execute(sql`
            SELECT position, segment_type AS "segmentType", duration_minutes AS "durationMinutes"
            FROM focus_structure_segments WHERE focus_structure_id = ${session.focusStructureId}
            ORDER BY position
          `);
          const structure = structureResult.rows[0] as { totalStartAt: Date } | undefined;
          const segments = segmentsResult.rows as Array<{ position: number; segmentType: string; durationMinutes: number }>;
          const position = structure ? locateSegment(new Date(structure.totalStartAt), segments, now) : null;
          if (position) {
            const positionedResult = await db.execute(sql`
              UPDATE focus_sessions
              SET current_segment_position = ${position.position}, current_segment_started_at = ${position.startedAt},
                current_segment_elapsed_seconds = ${position.elapsedSeconds}, updated_at = ${now}
              WHERE id = ${session.id} AND version = ${job.expectedSessionVersion + 1} AND state = 'running'
              RETURNING id
            `);
            if (positionedResult.rows.length === 0) throw new Error("focus session version changed while positioning segment");
            await db.execute(sql`
              UPDATE focus_session_segment_runs SET started_at = ${now}, updated_at = ${now}
              WHERE focus_session_id = ${session.id} AND position = ${position.position}
            `);
            const dueAt = segmentEndAt(new Date(structure!.totalStartAt), segments, position.position);
            if (dueAt && dueAt > now) {
              await db.execute(sql`
                INSERT INTO focus_timer_jobs (id, focus_session_id, kind, expected_session_version, due_at, status, attempts, created_at, updated_at)
                VALUES (gen_random_uuid(), ${session.id}, 'segment_transition', ${job.expectedSessionVersion + 1}, ${dueAt}, 'pending', 0, ${now}, ${now})
                ON CONFLICT (focus_session_id, kind) WHERE status IN ('pending', 'processing') DO NOTHING
              `);
            }
          }
        }
        await this.completeJob(db, job.id, now);
        return "completed";
      }

      if (job.kind === "segment_transition") {
        if (session.state !== "running" || !session.focusStructureId || session.currentSegmentPosition === null) {
          await this.cancelJob(db, job.id, "focus session is no longer running a structure", now);
          return "cancelled";
        }
        const structureResult = await db.execute(sql`
          SELECT total_start_at AS "totalStartAt"
          FROM focus_structures WHERE id = ${session.focusStructureId} AND state = 'active' LIMIT 1
        `);
        const structure = structureResult.rows[0] as { totalStartAt: Date } | undefined;
        const segmentsResult = await db.execute(sql`
          SELECT position, segment_type AS "segmentType", duration_minutes AS "durationMinutes"
          FROM focus_structure_segments WHERE focus_structure_id = ${session.focusStructureId}
          ORDER BY position
        `);
        const segments = segmentsResult.rows as Array<{ position: number; segmentType: string; durationMinutes: number }>;
        if (!structure || segments.length === 0) {
          await this.cancelJob(db, job.id, "focus structure is missing", now);
          return "cancelled";
        }
        const currentPosition = session.currentSegmentPosition;
        const boundary = segmentEndAt(new Date(structure.totalStartAt), segments, currentPosition);
        const nextPosition = currentPosition + 1;
        if (!boundary || nextPosition >= segments.length) {
          await db.execute(sql`
            UPDATE focus_session_segment_runs
            SET completed_at = ${boundary ?? now}, elapsed_seconds = planned_duration_seconds, updated_at = ${now}
            WHERE focus_session_id = ${session.id} AND position = ${currentPosition}
          `);
          const raw = session.activeSinceAt && session.plannedEndAt
            ? session.rawActiveSeconds + Math.max(0, Math.floor((Math.min(now.getTime(), new Date(session.plannedEndAt).getTime()) - new Date(session.activeSinceAt).getTime()) / 1000))
            : session.rawActiveSeconds;
          const endedResult = await db.execute(sql`
            UPDATE focus_sessions
            SET state = 'ended', raw_active_seconds = ${raw}, active_since_at = NULL,
              ended_at = ${boundary ?? now}, version = version + 1, updated_at = ${now}
            WHERE id = ${session.id} AND version = ${job.expectedSessionVersion} AND state = 'running'
            RETURNING id
          `);
          if (endedResult.rows.length === 0) throw new Error("focus session version changed while ending");
          await db.execute(sql`
            UPDATE tasks SET lifecycle_status = 'awaiting_outcome', version = version + 1, updated_at = ${now}
            WHERE id = ${session.taskId} AND lifecycle_status = 'active'
          `);
          await db.execute(sql`
            INSERT INTO task_lifecycle_events (id, task_id, from_status, to_status, source, reason)
            SELECT gen_random_uuid(), ${session.taskId}, 'active', 'awaiting_outcome', 'system', 'focus structure completed'
            WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ${session.taskId} AND lifecycle_status = 'awaiting_outcome')
          `);
          await this.completeJob(db, job.id, now);
          return "completed";
        }

        const nextDueAt = segmentEndAt(new Date(structure.totalStartAt), segments, nextPosition);
        await db.execute(sql`
          UPDATE focus_session_segment_runs
          SET completed_at = ${boundary}, elapsed_seconds = planned_duration_seconds, updated_at = ${now}
          WHERE focus_session_id = ${session.id} AND position = ${currentPosition}
        `);
        await db.execute(sql`
          UPDATE focus_session_segment_runs
          SET started_at = ${boundary}, updated_at = ${now}
          WHERE focus_session_id = ${session.id} AND position = ${nextPosition}
        `);
        const advancedResult = await db.execute(sql`
          UPDATE focus_sessions
          SET current_segment_position = ${nextPosition}, current_segment_started_at = ${boundary},
            current_segment_elapsed_seconds = 0, version = version + 1, updated_at = ${now}
          WHERE id = ${session.id} AND version = ${job.expectedSessionVersion} AND state = 'running'
          RETURNING id
        `);
        if (advancedResult.rows.length === 0) throw new Error("focus session version changed while advancing segment");
        if (nextDueAt) {
          await db.execute(sql`
            INSERT INTO focus_timer_jobs (id, focus_session_id, kind, expected_session_version, due_at, status, attempts, created_at, updated_at)
            VALUES (gen_random_uuid(), ${session.id}, 'segment_transition', ${job.expectedSessionVersion + 1}, ${nextDueAt}, 'pending', 0, ${now}, ${now})
            ON CONFLICT (focus_session_id, kind) WHERE status IN ('pending', 'processing') DO NOTHING
          `);
        }
        await this.completeJob(db, job.id, now);
        return "completed";
      }

      await this.cancelJob(db, job.id, "unsupported focus timer job", now);
      return "cancelled";
  }

  private async completeJob(db: AppDatabase, id: string, now: Date): Promise<void> {
    await db.execute(sql`UPDATE focus_timer_jobs SET status = 'completed', updated_at = ${now} WHERE id = ${id} AND status = 'processing'`);
  }

  private async cancelJob(db: AppDatabase, id: string, reason: string, now: Date): Promise<void> {
    await db.execute(sql`UPDATE focus_timer_jobs SET status = 'cancelled', last_error = ${reason.slice(0, 1000)}, updated_at = ${now} WHERE id = ${id} AND status = 'processing'`);
  }

  private async failJob(db: AppDatabase, id: string, reason: string, attempts: number, now: Date): Promise<void> {
    const status = attempts >= this.maxAttempts ? "failed" : "pending";
    await db.execute(sql`
      UPDATE focus_timer_jobs
      SET status = ${status}, due_at = ${now} + interval '1 minute', last_error = ${reason.slice(0, 1000)}, updated_at = ${now}
      WHERE id = ${id} AND status = 'processing'
    `);
  }
}

function segmentEndAt(
  structureStartAt: Date,
  segments: Array<{ durationMinutes: number }>,
  position: number
): Date | null {
  if (position < 0 || position >= segments.length) return null;
  const minutes = segments.slice(0, position + 1).reduce((sum, segment) => sum + segment.durationMinutes, 0);
  return new Date(structureStartAt.getTime() + minutes * 60_000);
}

function locateSegment(
  structureStartAt: Date,
  segments: Array<{ position: number; durationMinutes: number }>,
  now: Date
): { position: number; startedAt: Date; elapsedSeconds: number } | null {
  let cursor = structureStartAt.getTime();
  for (const segment of segments) {
    const end = cursor + segment.durationMinutes * 60_000;
    if (now.getTime() < end) {
      return { position: segment.position, startedAt: new Date(cursor), elapsedSeconds: Math.max(0, Math.floor((now.getTime() - cursor) / 1000)) };
    }
    cursor = end;
  }
  return null;
}
