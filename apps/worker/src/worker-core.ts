import { sql } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { recordFocusNoResponseOutcome } from "@personal-ai/db/focus-no-response";

export type ReminderJob = { id: string; taskId: string | null; channel: string; kind: string; attempts: number; scheduleRevision: number; scheduledAt: Date; payload: unknown };
export type ReminderDeliveryContext = { now: Date; timing: "upcoming" | "in_progress"; remoteMessageId?: string };
export type ReminderDeliveryResult = { remoteMessageId?: string };
export type ReminderDeliveryProvider = { deliver(job: ReminderJob, context: ReminderDeliveryContext): Promise<ReminderDeliveryResult> };
type FocusIntegrationSettings = {
  desktopFocusEnabled: boolean;
  feishuTaskCardsEnabled: boolean;
  feishuT15Enabled: boolean;
};

export function reminderRetryAt(now: Date): Date {
  return new Date(now.getTime() + 60_000);
}

export function reminderLeaseExpiredBefore(now: Date): Date {
  return new Date(now.getTime() - 5 * 60_000);
}

export class ReminderWorker {
  constructor(private readonly db: AppDatabase, private readonly maxAttempts = 3) {}

  async claimDueJob(now = new Date()): Promise<ReminderJob | null> {
    const leaseExpiredBefore = reminderLeaseExpiredBefore(now);
    const result = await this.db.execute(sql`
      WITH next_job AS (
        SELECT id FROM reminder_jobs
        WHERE (status = 'pending' AND available_at <= ${now})
          OR (status = 'processing' AND updated_at <= ${leaseExpiredBefore})
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

  async markSent(id: string, sentAt = new Date(), remoteMessageId?: string) {
    await this.db.execute(sql`UPDATE reminder_jobs SET status = 'sent', sent_at = ${sentAt}, remote_message_id = COALESCE(${remoteMessageId ?? null}, remote_message_id), updated_at = ${sentAt} WHERE id = ${id} AND status = 'processing'`);
  }

  async markFailed(id: string, error: string, now = new Date()) {
    const retryAt = reminderRetryAt(now);
    await this.db.execute(sql`UPDATE reminder_jobs SET status = CASE WHEN attempts >= ${this.maxAttempts} THEN 'failed' ELSE 'pending' END, available_at = ${retryAt}::timestamptz, last_error = ${error.slice(0, 1000)}, updated_at = ${now}::timestamptz WHERE id = ${id} AND status = 'processing'`);
  }

  async markCancelled(id: string, reason: string, now = new Date()) {
    await this.db.execute(sql`UPDATE reminder_jobs SET status = 'cancelled', last_error = ${reason.slice(0, 1000)}, updated_at = ${now} WHERE id = ${id} AND status = 'processing'`);
  }

  async deliveryEligibility(job: ReminderJob, now = new Date()): Promise<{ eligible: boolean; reason?: string }> {
    if (!job.taskId) return { eligible: false, reason: "reminder has no task" };
    const result = await this.db.execute(sql`
      SELECT schedule_revision AS "scheduleRevision", lifecycle_status AS "lifecycleStatus",
        schedule_kind AS "scheduleKind", record_kind AS "recordKind", start_at AS "startAt", end_at AS "endAt", deleted_at AS "deletedAt"
      FROM tasks WHERE id = ${job.taskId} LIMIT 1
    `);
    const task = result.rows[0] as {
      scheduleRevision: number;
      lifecycleStatus: string;
      scheduleKind: string;
      recordKind: string;
      startAt: Date | string | null;
      endAt: Date | string | null;
      deletedAt: Date | string | null;
    } | undefined;
    if (!task) return { eligible: false, reason: "task no longer exists" };
    if (task.deletedAt) return { eligible: false, reason: "task was deleted" };
    if (task.recordKind !== "formal") return { eligible: false, reason: "factual backfill cannot receive reminders" };
    const cardState = reminderCardState(job.payload);
    const startedCardUpdate = job.kind === "task_start_lapsed" && cardState === "started";
    if (task.scheduleKind !== "exact") return { eligible: false, reason: "task is no longer an exact task" };
    if (startedCardUpdate) {
      if (!["open", "active", "awaiting_outcome", "closed"].includes(task.lifecycleStatus)) {
        return { eligible: false, reason: "started task card is no longer applicable" };
      }
    } else if (task.lifecycleStatus !== "open") {
      return { eligible: false, reason: "task is no longer open" };
    }
    if (task.scheduleRevision !== job.scheduleRevision) return { eligible: false, reason: "task schedule revision changed" };
    if (!task.startAt || !task.endAt) return { eligible: false, reason: "task exact interval is missing" };
    if (new Date(task.startAt).getTime() !== new Date(job.scheduledAt).getTime()) return { eligible: false, reason: "task start time changed" };
    if (!startedCardUpdate && job.kind !== "task_start_expire" && new Date(task.endAt).getTime() <= now.getTime()) {
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
      const settings = await this.focusIntegrationSettings();
      const memoMode = !settings.desktopFocusEnabled && !settings.feishuTaskCardsEnabled;
      const disabledKind = memoMode
        || (job.kind === "task_start" && (!settings.feishuTaskCardsEnabled || !settings.feishuT15Enabled))
        || (job.kind === "task_start_lapsed" && !settings.feishuTaskCardsEnabled)
        || (job.kind === "task_start_ready" && !settings.desktopFocusEnabled && !settings.feishuTaskCardsEnabled)
        || (job.kind === "task_start_expire" && !settings.desktopFocusEnabled && !settings.feishuTaskCardsEnabled);
      if (disabledKind) {
        await this.markCancelled(job.id, "focus integration disabled by user settings", now);
        return "cancelled";
      }
      if (job.kind === "task_start_ready") await this.ensurePreparationSession(job, now);
      if (job.kind === "task_start_expire") await this.finalizeMissedTask(job, now);
      if (!settings.feishuTaskCardsEnabled) {
        await this.markSent(job.id, now);
        return "sent";
      }
      const result = await provider.deliver(job, {
        now,
        timing: now.getTime() < job.scheduledAt.getTime() ? "upcoming" : "in_progress",
        remoteMessageId: await this.originalReminderMessageId(job)
      });
      await this.markSent(job.id, now, result.remoteMessageId);
      return "sent";
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown reminder delivery error";
      await this.markFailed(job.id, message, now);
      return "retry";
    }
  }

  private async originalReminderMessageId(job: ReminderJob): Promise<string | undefined> {
    if (job.kind === "task_start") return undefined;
    if (!job.taskId) throw new Error("task reminder has no task");
    const result = await this.db.execute(sql`
      SELECT remote_message_id AS "remoteMessageId"
      FROM reminder_jobs
      WHERE task_id = ${job.taskId} AND channel = ${job.channel}
        AND kind IN ('task_start', 'task_start_ready')
        AND schedule_revision = ${job.scheduleRevision} AND remote_message_id IS NOT NULL
      ORDER BY CASE WHEN kind = 'task_start_ready' THEN 0 ELSE 1 END
      LIMIT 1
    `);
    const messageId = (result.rows[0] as { remoteMessageId?: string | null } | undefined)?.remoteMessageId;
    return messageId ?? undefined;
  }

  private async focusIntegrationSettings(): Promise<FocusIntegrationSettings> {
    const result = await this.db.execute(sql`
      SELECT desktop_focus_enabled AS "desktopFocusEnabled",
        feishu_task_cards_enabled AS "feishuTaskCardsEnabled",
        feishu_t15_enabled AS "feishuT15Enabled"
      FROM user_profiles WHERE id = 1 LIMIT 1
    `);
    return (result.rows[0] as FocusIntegrationSettings | undefined) ?? {
      desktopFocusEnabled: true,
      feishuTaskCardsEnabled: true,
      feishuT15Enabled: true,
    };
  }

  private async ensurePreparationSession(job: ReminderJob, now: Date): Promise<void> {
    if (!job.taskId) throw new Error("task preparation reminder has no task");
    await this.db.transaction(async (transaction) => {
      const db = transaction as unknown as AppDatabase;
      const taskResult = await db.execute(sql`
        SELECT id, start_at AS "startAt", end_at AS "endAt", schedule_revision AS "scheduleRevision"
        FROM tasks
        WHERE id = ${job.taskId} AND deleted_at IS NULL AND lifecycle_status = 'open'
          AND record_kind = 'formal' AND schedule_kind = 'exact' AND schedule_revision = ${job.scheduleRevision}
        LIMIT 1
      `);
      const task = taskResult.rows[0] as { id: string; startAt: Date; endAt: Date; scheduleRevision: number } | undefined;
      if (!task || new Date(task.endAt).getTime() <= now.getTime()) return;

      const existingResult = await db.execute(sql`
        SELECT id FROM focus_sessions
        WHERE task_id = ${task.id}
          AND state IN ('scheduled', 'reminded', 'preparing', 'armed', 'awaiting_late_start', 'awaiting_start', 'running', 'paused')
        ORDER BY created_at DESC LIMIT 1
      `);
      if (existingResult.rows.length > 0) return;

      let structureResult = await db.execute(sql`
        SELECT id, version, task_schedule_revision AS "taskScheduleRevision", total_start_at AS "totalStartAt"
        FROM focus_structures
        WHERE task_id = ${task.id} AND task_schedule_revision = ${task.scheduleRevision} AND state = 'active'
        LIMIT 1
      `);
      if (structureResult.rows.length === 0) {
        const totalMinutes = Math.floor((new Date(task.endAt).getTime() - new Date(task.startAt).getTime()) / 60_000);
        const breakMinutes = totalMinutes >= 120 ? 15 : totalMinutes >= 90 ? 10 : 5;
        const focusMinutes = totalMinutes - breakMinutes;
        const createdStructure = await db.execute(sql`
          INSERT INTO focus_structures (
            id, task_id, task_schedule_revision, state, source, mode, version,
            total_start_at, total_end_at, confirmed_at, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${task.id}, ${task.scheduleRevision}, 'active', 'template', 'continuous', 1,
            ${task.startAt}, ${task.endAt}, ${now}, ${now}, ${now}
          )
          ON CONFLICT DO NOTHING
          RETURNING id, version, task_schedule_revision AS "taskScheduleRevision", total_start_at AS "totalStartAt"
        `);
        structureResult = createdStructure.rows.length > 0 ? createdStructure : await db.execute(sql`
          SELECT id, version, task_schedule_revision AS "taskScheduleRevision", total_start_at AS "totalStartAt"
          FROM focus_structures WHERE task_id = ${task.id} AND state = 'active' LIMIT 1
        `);
        const structureId = (structureResult.rows[0] as { id?: string } | undefined)?.id;
        if (structureId && createdStructure.rows.length > 0) {
          await db.execute(sql`
            INSERT INTO focus_structure_segments (id, focus_structure_id, position, segment_type, duration_minutes, created_at)
            VALUES
              (gen_random_uuid(), ${structureId}, 0, 'focus', ${focusMinutes}, ${now}),
              (gen_random_uuid(), ${structureId}, 1, 'break', ${breakMinutes}, ${now})
          `);
        }
      }
      const structure = structureResult.rows[0] as { id: string; version: number; taskScheduleRevision: number; totalStartAt: Date } | undefined;
      if (!structure) throw new Error("focus structure is unavailable for preparation");
      const segmentsResult = await db.execute(sql`
        SELECT position, segment_type AS "segmentType", duration_minutes AS "durationMinutes"
        FROM focus_structure_segments WHERE focus_structure_id = ${structure.id} ORDER BY position
      `);
      const state = now.getTime() < new Date(task.startAt).getTime() ? "preparing" : "awaiting_late_start";
      const createdSession = await db.execute(sql`
        INSERT INTO focus_sessions (
          id, task_id, focus_structure_id, focus_structure_version, focus_structure_schedule_revision,
          state, planned_start_at, planned_end_at, preparing_ends_at,
          current_segment_position, current_segment_started_at, current_segment_elapsed_seconds,
          raw_active_seconds, effective_focus_seconds, version, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${task.id}, ${structure.id}, ${structure.version}, ${structure.taskScheduleRevision},
          ${state}, ${task.startAt}, ${task.endAt}, ${task.startAt},
          0, ${structure.totalStartAt}, 0, 0, 0, 1, ${now}, ${now}
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `);
      const sessionId = (createdSession.rows[0] as { id?: string } | undefined)?.id;
      if (!sessionId) return;
      const segments = segmentsResult.rows as Array<{ position: number; segmentType: string; durationMinutes: number }>;
      for (const segment of segments) {
        await db.execute(sql`
          INSERT INTO focus_session_segment_runs (
            id, focus_session_id, position, segment_type, planned_duration_seconds,
            elapsed_seconds, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${sessionId}, ${segment.position}, ${segment.segmentType},
            ${segment.durationMinutes * 60}, 0, ${now}, ${now}
          )
        `);
      }
      if (state === "preparing") {
        await db.execute(sql`
          INSERT INTO focus_timer_jobs (
            id, focus_session_id, kind, expected_session_version, due_at,
            status, attempts, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${sessionId}, 'confirmation_timeout', 1, ${task.startAt},
            'pending', 0, ${now}, ${now}
          )
          ON CONFLICT DO NOTHING
        `);
      }
    });
  }

  private async finalizeMissedTask(job: ReminderJob, now: Date): Promise<void> {
    if (!job.taskId) throw new Error("task expiry reminder has no task");
    await this.db.transaction(async (transaction) => {
      const db = transaction as unknown as AppDatabase;
      const taskResult = await db.execute(sql`
        SELECT id, start_at AS "startAt", end_at AS "endAt"
        FROM tasks
        WHERE id = ${job.taskId} AND deleted_at IS NULL AND lifecycle_status = 'open'
          AND record_kind = 'formal' AND schedule_kind = 'exact' AND schedule_revision = ${job.scheduleRevision}
        LIMIT 1
      `);
      const task = taskResult.rows[0] as { id: string; startAt: Date; endAt: Date } | undefined;
      if (!task || new Date(task.endAt).getTime() > now.getTime()) return;
      const sessionResult = await db.execute(sql`
        SELECT id, state, version FROM focus_sessions
        WHERE task_id = ${task.id} AND planned_start_at = ${task.startAt} AND planned_end_at = ${task.endAt}
        ORDER BY created_at DESC LIMIT 1
      `);
      const session = sessionResult.rows[0] as { id: string; state: string; version: number } | undefined;
      if (session && !['scheduled', 'reminded', 'preparing', 'armed', 'awaiting_late_start', 'awaiting_start'].includes(session.state)) return;
      let sessionId = session?.id;
      if (session) {
        const stopped = await db.execute(sql`
          UPDATE focus_sessions
          SET state = 'stopped_no_response', ended_at = ${now}, stopped_reason = '固定截止前未确认开始',
            version = version + 1, updated_at = ${now}
          WHERE id = ${session.id} AND version = ${session.version}
            AND state IN ('scheduled', 'reminded', 'preparing', 'armed', 'awaiting_late_start', 'awaiting_start')
          RETURNING id
        `);
        if (stopped.rows.length === 0) return;
      } else {
        const created = await db.execute(sql`
          INSERT INTO focus_sessions (
            id, task_id, state, planned_start_at, planned_end_at, ended_at,
            stopped_reason, raw_active_seconds, effective_focus_seconds, version, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${task.id}, 'stopped_no_response', ${task.startAt}, ${task.endAt}, ${now},
            '固定截止前未确认开始', 0, 0, 1, ${now}, ${now}
          ) RETURNING id
        `);
        sessionId = (created.rows[0] as { id?: string } | undefined)?.id;
      }
      if (!sessionId) return;
      await recordFocusNoResponseOutcome(db, {
        taskId: task.id,
        focusSessionId: sessionId,
        now,
        reason: "固定截止前未确认开始"
      });
    });
  }
}

function reminderCardState(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  return typeof (payload as { cardState?: unknown }).cardState === "string"
    ? (payload as { cardState: string }).cardState
    : null;
}
