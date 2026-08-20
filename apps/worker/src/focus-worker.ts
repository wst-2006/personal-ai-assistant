import { sql } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { recordFocusNoResponseOutcome } from "@personal-ai/db/focus-no-response";
import { calculateSegmentElapsedSeconds, focusSegmentEndAt, locateFocusSegment } from "@personal-ai/domain/focus";

export type FocusTimerJob = {
  id: string;
  focusSessionId: string;
  kind: "preparation_start" | "preparation_complete" | "confirmation_timeout" | "segment_transition";
  expectedSessionVersion: number;
  dueAt: Date;
  attempts: number;
};

export function focusTimerLeaseExpiredBefore(now: Date): Date {
  return new Date(now.getTime() - 5 * 60_000);
}

export class FocusTimerWorker {
  constructor(private readonly db: AppDatabase, private readonly maxAttempts = 3) {}

  async reconcileOverdueSession(now = new Date()): Promise<boolean> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as AppDatabase;
      const result = await db.execute(sql`
        SELECT id, task_id AS "taskId", state, version,
          started_at AS "startedAt", active_since_at AS "activeSinceAt",
          paused_at AS "pausedAt", planned_end_at AS "plannedEndAt",
          raw_active_seconds AS "rawActiveSeconds",
          focus_structure_id AS "focusStructureId",
          current_segment_position AS "currentSegmentPosition"
        FROM focus_sessions
        WHERE state IN ('running', 'paused') AND planned_end_at <= ${now}
        ORDER BY planned_end_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
      const session = result.rows[0] as WorkerFocusSession | undefined;
      if (!session) return false;
      await this.finalizeRunningSession(db, session, new Date(session.plannedEndAt!), now, "fixed end reconciliation");
      await db.execute(sql`
        UPDATE focus_timer_jobs
        SET status = 'cancelled', last_error = 'session reconciled at fixed end', updated_at = ${now}
        WHERE focus_session_id = ${session.id} AND status IN ('pending', 'processing', 'failed')
      `);
      return true;
    });
  }

  async claimDueJob(now = new Date()): Promise<FocusTimerJob | null> {
    const leaseExpiredBefore = focusTimerLeaseExpiredBefore(now);
    const result = await this.db.execute(sql`
      WITH next_job AS (
        SELECT id FROM focus_timer_jobs
        WHERE (status = 'pending' AND due_at <= ${now})
          OR (status = 'processing' AND updated_at <= ${leaseExpiredBefore})
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
          paused_at AS "pausedAt",
          planned_end_at AS "plannedEndAt", raw_active_seconds AS "rawActiveSeconds",
          focus_structure_id AS "focusStructureId", current_segment_position AS "currentSegmentPosition"
        FROM focus_sessions WHERE id = ${job.focusSessionId} LIMIT 1
      `);
      const session = sessionResult.rows[0] as WorkerFocusSession | undefined;
      if (!session || session.version !== job.expectedSessionVersion) {
        await this.cancelJob(db, job.id, "focus session version changed", now);
        return "cancelled";
      }

      if (job.kind === "preparation_start") {
        if (session.state !== "scheduled") {
          await this.cancelJob(db, job.id, "focus session is no longer scheduled", now);
          return "cancelled";
        }
        const taskResult = await db.execute(sql`
          SELECT id, lifecycle_status AS "lifecycleStatus", start_at AS "startAt", end_at AS "endAt",
            schedule_revision AS "scheduleRevision", record_kind AS "recordKind"
          FROM tasks WHERE id = ${session.taskId} AND deleted_at IS NULL LIMIT 1
        `);
        const task = taskResult.rows[0] as {
          id: string;
          lifecycleStatus: string;
          startAt: Date | null;
          endAt: Date | null;
          scheduleRevision: number;
          recordKind: string;
        } | undefined;
        if (!task || task.recordKind !== "formal" || task.lifecycleStatus !== "open") {
          await this.cancelJob(db, job.id, "task cannot enter preparation anymore", now);
          return "cancelled";
        }
        if (task.endAt && new Date(task.endAt).getTime() <= now.getTime()) {
          const stopped = await db.execute(sql`
            UPDATE focus_sessions
            SET state = 'stopped_no_response', ended_at = ${now}, active_since_at = NULL,
              stopped_reason = '固定结束时间已过，未进入专注', version = version + 1, updated_at = ${now}
            WHERE id = ${session.id} AND version = ${job.expectedSessionVersion} AND state = 'scheduled'
            RETURNING id
          `);
          if (stopped.rows.length > 0) {
            await recordFocusNoResponseOutcome(db, {
              taskId: session.taskId,
              focusSessionId: session.id,
              now,
              reason: "固定结束时间已过，未进入专注"
            });
          }
          await this.completeJob(db, job.id, now);
          return "completed";
        }
        const structureResult = await db.execute(sql`
          SELECT id, version, task_schedule_revision AS "taskScheduleRevision",
            total_start_at AS "totalStartAt"
          FROM focus_structures
          WHERE task_id = ${task.id} AND task_schedule_revision = ${task.scheduleRevision} AND state = 'active'
          LIMIT 1
        `);
        const structure = structureResult.rows[0] as {
          id: string;
          version: number;
          taskScheduleRevision: number;
          totalStartAt: Date;
        } | undefined;
        const segmentsResult = structure
          ? await db.execute(sql`
              SELECT position, segment_type AS "segmentType", duration_minutes AS "durationMinutes"
              FROM focus_structure_segments WHERE focus_structure_id = ${structure.id} ORDER BY position
            `)
          : { rows: [] };
        const segments = segmentsResult.rows as Array<{ position: number; segmentType: string; durationMinutes: number }>;
        if (!task.startAt) {
          await this.cancelJob(db, job.id, "task start time is missing", now);
          return "cancelled";
        }
        const preparingEndsAt = new Date(task.startAt);
        const preparationState = preparingEndsAt.getTime() > now.getTime() ? "preparing" : "awaiting_late_start";
        const preparing = await db.execute(sql`
          UPDATE focus_sessions
          SET state = ${preparationState}, preparing_ends_at = ${preparationState === "preparing" ? preparingEndsAt : null},
            focus_structure_id = ${structure?.id ?? null},
            focus_structure_version = ${structure?.version ?? null},
            focus_structure_schedule_revision = ${structure?.taskScheduleRevision ?? null},
            current_segment_position = ${structure ? 0 : null},
            current_segment_started_at = ${structure?.totalStartAt ?? null},
            current_segment_elapsed_seconds = 0,
            version = version + 1, updated_at = ${now}
          WHERE id = ${session.id} AND version = ${job.expectedSessionVersion} AND state = 'scheduled'
          RETURNING id
        `);
        if (preparing.rows.length === 0) throw new Error("focus session version changed while entering preparation");
        await db.execute(sql`DELETE FROM focus_session_segment_runs WHERE focus_session_id = ${session.id}`);
        for (const segment of segments) {
          await db.execute(sql`
            INSERT INTO focus_session_segment_runs (
              id, focus_session_id, position, segment_type, planned_duration_seconds,
              elapsed_seconds, created_at, updated_at
            ) VALUES (
              gen_random_uuid(), ${session.id}, ${segment.position}, ${segment.segmentType},
              ${segment.durationMinutes * 60}, 0, ${now}, ${now}
            )
          `);
        }
        if (preparationState === "preparing") {
          await db.execute(sql`
            INSERT INTO focus_timer_jobs (
              id, focus_session_id, kind, expected_session_version, due_at,
              status, attempts, created_at, updated_at
            ) VALUES (
              gen_random_uuid(), ${session.id}, 'confirmation_timeout',
              ${job.expectedSessionVersion + 1}, ${preparingEndsAt}, 'pending', 0, ${now}, ${now}
            )
            ON CONFLICT (focus_session_id, kind) WHERE status IN ('pending', 'processing') DO NOTHING
          `);
        }
        await this.completeJob(db, job.id, now);
        return "completed";
      }

      if (job.kind === "confirmation_timeout" || job.kind === "preparation_complete") {
        if (session.state === "preparing" || session.state === "reminded") {
          const lateResult = await db.execute(sql`
            UPDATE focus_sessions
            SET state = 'awaiting_late_start', preparing_ends_at = NULL, confirmation_deadline_at = NULL,
              version = version + 1, updated_at = ${now}
            WHERE id = ${session.id} AND version = ${job.expectedSessionVersion}
              AND state IN ('preparing', 'reminded')
            RETURNING id
          `);
          if (lateResult.rows.length === 0) throw new Error("focus session version changed while waiting for late start");
          await this.completeJob(db, job.id, now);
          return "completed";
        }
        if (session.state !== "armed") {
          await this.cancelJob(db, job.id, "focus session is no longer awaiting confirmation", now);
          return "cancelled";
        }
      }

      if (job.kind === "preparation_complete" || job.kind === "confirmation_timeout") {
        if (session.state !== "armed") {
          await this.cancelJob(db, job.id, "focus session is no longer preparing", now);
          return "cancelled";
        }
        const taskResult = await db.execute(sql`
          SELECT id, lifecycle_status AS "lifecycleStatus", record_kind AS "recordKind", start_at AS "startAt", end_at AS "endAt"
          FROM tasks WHERE id = ${session.taskId} AND deleted_at IS NULL LIMIT 1
        `);
        const task = taskResult.rows[0] as { id: string; lifecycleStatus: string; recordKind: string; startAt: Date | null; endAt: Date | null } | undefined;
        if (!task || task.recordKind !== "formal" || task.lifecycleStatus !== "open" || (task.endAt && new Date(task.endAt).getTime() <= now.getTime())) {
          await this.cancelJob(db, job.id, "task cannot start focus anymore", now);
          return "cancelled";
        }
        await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('personal-ai-focus-running', 0))`);
        const blockingResult = await db.execute(sql`
          SELECT id FROM focus_sessions
          WHERE id <> ${session.id} AND state IN ('running', 'paused')
          LIMIT 1
        `);
        if (blockingResult.rows.length > 0) throw new Error("another focus session is already running");
        const startedResult = await db.execute(sql`
          UPDATE focus_sessions
          SET state = 'running', started_at = ${task.startAt ?? now}, active_since_at = ${task.startAt ?? now},
            version = version + 1, updated_at = ${now}
          WHERE id = ${session.id} AND version = ${job.expectedSessionVersion} AND state = 'armed'
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
            FROM focus_structures WHERE id = ${session.focusStructureId} LIMIT 1
          `);
          const segmentsResult = await db.execute(sql`
            SELECT position, segment_type AS "segmentType", duration_minutes AS "durationMinutes"
            FROM focus_structure_segments WHERE focus_structure_id = ${session.focusStructureId}
            ORDER BY position
          `);
          const structure = structureResult.rows[0] as { totalStartAt: Date } | undefined;
          const segments = segmentsResult.rows as Array<{ position: number; segmentType: string; durationMinutes: number }>;
          const position = structure ? locateFocusSegment({
            structureStartAt: new Date(structure.totalStartAt),
            segments,
            now
          }) : null;
          if (position) {
            const positionedResult = await db.execute(sql`
              UPDATE focus_sessions
              SET current_segment_position = ${position.position}, current_segment_started_at = ${position.plannedStartedAt},
                current_segment_elapsed_seconds = ${position.elapsedSeconds}, updated_at = ${now}
              WHERE id = ${session.id} AND version = ${job.expectedSessionVersion + 1} AND state = 'running'
              RETURNING id
            `);
            if (positionedResult.rows.length === 0) throw new Error("focus session version changed while positioning segment");
            if (position.position > 0) {
              await db.execute(sql`
                UPDATE focus_session_segment_runs
                SET elapsed_seconds = 0, started_at = NULL, completed_at = NULL,
                  skipped_at = ${now}, updated_at = ${now}
                WHERE focus_session_id = ${session.id} AND position < ${position.position}
              `);
            }
            await db.execute(sql`
              UPDATE focus_session_segment_runs
              SET elapsed_seconds = 0, started_at = ${now}, completed_at = NULL,
                skipped_at = NULL, updated_at = ${now}
              WHERE focus_session_id = ${session.id} AND position = ${position.position}
            `);
            const dueAt = focusSegmentEndAt({
              structureStartAt: new Date(structure!.totalStartAt),
              segments,
              position: position.position
            });
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
          FROM focus_structures WHERE id = ${session.focusStructureId} LIMIT 1
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
        const boundary = focusSegmentEndAt({
          structureStartAt: new Date(structure.totalStartAt),
          segments,
          position: currentPosition
        });
        const nextPosition = currentPosition + 1;
        if (!boundary || nextPosition >= segments.length) {
          await this.finalizeRunningSession(db, session, boundary ?? now, now, "focus structure completed");
          await this.completeJob(db, job.id, now);
          return "completed";
        }

        const runResult = await db.execute(sql`
          SELECT started_at AS "startedAt", elapsed_seconds AS "elapsedSeconds",
            planned_duration_seconds AS "plannedDurationSeconds"
          FROM focus_session_segment_runs
          WHERE focus_session_id = ${session.id} AND position = ${currentPosition}
          LIMIT 1
        `);
        const run = runResult.rows[0] as { startedAt: Date | null; elapsedSeconds: number; plannedDurationSeconds: number } | undefined;
        const actualElapsedSeconds = run
          ? Math.min(run.plannedDurationSeconds, run.elapsedSeconds + calculateSegmentElapsedSeconds({
              actualStartedAt: run.startedAt,
              endedAt: boundary,
              plannedDurationSeconds: run.plannedDurationSeconds
            }))
          : 0;
        const nextDueAt = focusSegmentEndAt({
          structureStartAt: new Date(structure.totalStartAt),
          segments,
          position: nextPosition
        });
        await db.execute(sql`
          UPDATE focus_session_segment_runs
          SET completed_at = ${boundary}, elapsed_seconds = ${actualElapsedSeconds}, updated_at = ${now}
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
        if (!nextDueAt) throw new Error("next focus segment boundary is missing");
        const rescheduled = await db.execute(sql`
          UPDATE focus_timer_jobs
          SET expected_session_version = ${job.expectedSessionVersion + 1}, due_at = ${nextDueAt},
            status = 'pending', attempts = 0, last_error = NULL, updated_at = ${now}
          WHERE id = ${job.id} AND status = 'processing'
          RETURNING id
        `);
        if (rescheduled.rows.length === 0) throw new Error("focus segment timer could not be rescheduled");
        return "completed";
      }

      await this.cancelJob(db, job.id, "unsupported focus timer job", now);
      return "cancelled";
  }

  private async completeJob(db: AppDatabase, id: string, now: Date): Promise<void> {
    await db.execute(sql`UPDATE focus_timer_jobs SET status = 'completed', updated_at = ${now} WHERE id = ${id} AND status = 'processing'`);
  }

  private async finalizeRunningSession(
    db: AppDatabase,
    session: WorkerFocusSession,
    endedAt: Date,
    observedAt: Date,
    reason: string
  ): Promise<void> {
    if (session.currentSegmentPosition !== null) {
      const runResult = await db.execute(sql`
        SELECT started_at AS "startedAt", elapsed_seconds AS "elapsedSeconds",
          planned_duration_seconds AS "plannedDurationSeconds"
        FROM focus_session_segment_runs
        WHERE focus_session_id = ${session.id} AND position = ${session.currentSegmentPosition}
        LIMIT 1
      `);
      const run = runResult.rows[0] as { startedAt: Date | null; elapsedSeconds: number; plannedDurationSeconds: number } | undefined;
      if (run) {
        const elapsed = Math.min(run.plannedDurationSeconds, run.elapsedSeconds + calculateSegmentElapsedSeconds({
          actualStartedAt: run.startedAt,
          endedAt,
          plannedDurationSeconds: run.plannedDurationSeconds
        }));
        await db.execute(sql`
          UPDATE focus_session_segment_runs
          SET completed_at = ${endedAt}, elapsed_seconds = ${elapsed}, updated_at = ${observedAt}
          WHERE focus_session_id = ${session.id} AND position = ${session.currentSegmentPosition}
        `);
      }
    }
    const focusSecondsResult = await db.execute(sql`
      SELECT COALESCE(SUM(elapsed_seconds), 0)::integer AS "focusSeconds"
      FROM focus_session_segment_runs
      WHERE focus_session_id = ${session.id} AND segment_type = 'focus'
    `);
    const focusSeconds = Number((focusSecondsResult.rows[0] as { focusSeconds?: number } | undefined)?.focusSeconds ?? 0);
    const raw = session.activeSinceAt && session.plannedEndAt
      ? session.rawActiveSeconds + Math.max(0, Math.floor((Math.min(observedAt.getTime(), new Date(session.plannedEndAt).getTime()) - new Date(session.activeSinceAt).getTime()) / 1000))
      : session.rawActiveSeconds;
    const endedResult = await db.execute(sql`
      UPDATE focus_sessions
      SET state = 'ended', raw_active_seconds = ${raw}, effective_focus_seconds = ${focusSeconds},
        active_since_at = NULL, paused_at = NULL, ended_at = ${endedAt}, version = version + 1, updated_at = ${observedAt}
      WHERE id = ${session.id} AND version = ${session.version} AND state IN ('running', 'paused')
      RETURNING id, version
    `);
    if (endedResult.rows.length === 0) throw new Error("focus session version changed while ending");
    const awaitingOutcomeResult = await db.execute(sql`
      UPDATE tasks SET lifecycle_status = 'awaiting_outcome', version = version + 1, updated_at = ${observedAt}
      WHERE id = ${session.taskId} AND lifecycle_status = 'active'
      RETURNING id
    `);
    if (awaitingOutcomeResult.rows.length > 0) {
      await db.execute(sql`
        INSERT INTO task_lifecycle_events (id, task_id, from_status, to_status, source, reason)
        VALUES (gen_random_uuid(), ${session.taskId}, 'active', 'awaiting_outcome', 'system', ${reason})
      `);
    }
  }

  private async cancelJob(db: AppDatabase, id: string, reason: string, now: Date): Promise<void> {
    await db.execute(sql`UPDATE focus_timer_jobs SET status = 'cancelled', last_error = ${reason.slice(0, 1000)}, updated_at = ${now} WHERE id = ${id} AND status = 'processing'`);
  }

  private async failJob(db: AppDatabase, id: string, reason: string, attempts: number, now: Date): Promise<void> {
    const status = attempts >= this.maxAttempts ? "failed" : "pending";
    const retryAt = new Date(now.getTime() + 60_000);
    await db.execute(sql`
      UPDATE focus_timer_jobs
      SET status = ${status}, due_at = ${retryAt}::timestamptz, last_error = ${reason.slice(0, 1000)}, updated_at = ${now}::timestamptz
      WHERE id = ${id} AND status = 'processing'
    `);
  }
}

type WorkerFocusSession = {
  id: string;
  taskId: string;
  state: string;
  version: number;
  startedAt: Date | null;
  activeSinceAt: Date | null;
  pausedAt: Date | null;
  plannedEndAt: Date | null;
  rawActiveSeconds: number;
  focusStructureId: string | null;
  currentSegmentPosition: number | null;
};
