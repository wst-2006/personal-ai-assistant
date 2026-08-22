import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { recordFocusNoResponseOutcome } from "@personal-ai/db/focus-no-response";
import { focusSessionOperations, focusSessionSegmentRuns, focusSessions, focusStructureSegments, focusStructures, focusTimerJobs, taskFeedback, taskLifecycleEvents, taskOutcomes, tasks } from "@personal-ai/db/schema";
import {
  calculateSegmentElapsedSeconds,
  focusSegmentEndAt,
  locateFocusSegment,
  type FocusSatisfaction,
  type FocusSessionState
} from "@personal-ai/domain/focus";
import type { TaskOutcome } from "@personal-ai/domain/task";
import { cancelTaskFollowUp, focusIntegrationSettings, queueTaskStartCardUpdate, syncTaskStartReminder } from "./reminder-scheduler.js";

const recoverableStates: FocusSessionState[] = ["scheduled", "reminded", "preparing", "armed", "awaiting_late_start", "running", "paused"];
const currentStates: FocusSessionState[] = [...recoverableStates, "ended"];
type FocusCommandOperation = "create" | "begin" | "skip_preparation" | "respond_start" | "other_arrangement" | "end" | "skip_final_break" | "evaluate";

export type StoredFocusSession = typeof focusSessions.$inferSelect;
export type FocusSnapshotPhase = "scheduled" | "reminder" | "preparation" | "armed" | "awaiting_late_start" | "focus" | "break" | "ended";
export type FocusSnapshotSegment = {
  position: number;
  segmentType: "focus" | "break";
  durationMinutes: number;
  startsAt: Date;
  endsAt: Date;
};
export type FocusSessionSnapshot = {
  serverNow: Date;
  serverNowEpochMs: number;
  session: StoredFocusSession;
  task: {
    id: string;
    title: string;
    timeZone: string;
    startAt: Date | null;
    endAt: Date | null;
  };
  phase: FocusSnapshotPhase;
  phaseStartedAt: Date | null;
  phaseEndsAt: Date | null;
  phaseEndsAtEpochMs: number | null;
  sessionEndsAt: Date | null;
  sessionEndsAtEpochMs: number | null;
  currentSegment: FocusSnapshotSegment | null;
  nextSegment: FocusSnapshotSegment | null;
  segments: FocusSnapshotSegment[];
};

export class FocusNotFoundError extends Error {}
export class FocusVersionConflictError extends Error {
  constructor(readonly current: StoredFocusSession) { super("Focus session version does not match."); }
}
export class FocusTransitionError extends Error {
  constructor(readonly state: string, readonly operation: string) { super(`Cannot ${operation} a focus session in ${state}.`); }
}
export class FocusBusyError extends Error { constructor() { super("Another focus session is already active."); } }
export class FocusDisabledError extends Error { constructor() { super("Focus integrations are disabled."); } }
export class FocusCommandConflictError extends Error { constructor() { super("Focus command id was already used for a different operation."); } }
export class FocusTaskNotScheduledError extends Error { constructor() { super("Only an exact task with fixed start and end times can start focus."); } }

export class FocusService {
  constructor(private readonly db: AppDatabase) {}

  async currentForTask(taskId: string): Promise<StoredFocusSession | null> {
    return this.db.transaction(async (transaction) => {
      const [session] = await transaction.select().from(focusSessions)
        .where(and(eq(focusSessions.taskId, taskId), inArray(focusSessions.state, currentStates)))
        .orderBy(desc(focusSessions.createdAt)).limit(1);
      if (!session) return null;
      const now = new Date();
      const scheduled = await this.materializeScheduled(transaction as AppDatabase, session, now);
      const prepared = await this.materializePreparation(transaction as AppDatabase, scheduled, now);
      return this.materializeFixedEnd(transaction as AppDatabase, prepared, now);
    });
  }

  async current(): Promise<StoredFocusSession | null> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      await this.materializeOverdueRunningSessions(transaction as AppDatabase, now);
      const [session] = await transaction.select().from(focusSessions)
        .where(inArray(focusSessions.state, currentStates))
        .orderBy(
          desc(sql`CASE WHEN ${focusSessions.state} = 'ended' THEN 0 ELSE 1 END`),
          desc(focusSessions.updatedAt)
      ).limit(1);
      if (!session) return null;
      const scheduled = await this.materializeScheduled(transaction as AppDatabase, session, now);
      const prepared = await this.materializePreparation(transaction as AppDatabase, scheduled, now);
      return this.materializeFixedEnd(transaction as AppDatabase, prepared, now);
    });
  }

  async currentExecution(): Promise<StoredFocusSession | null> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      await this.materializeOverdueRunningSessions(transaction as AppDatabase, now);
      const [session] = await transaction.select().from(focusSessions)
        .where(inArray(focusSessions.state, recoverableStates))
        .orderBy(
          desc(sql`CASE
            WHEN ${focusSessions.state} IN ('running', 'paused') THEN 3
            WHEN ${focusSessions.state} IN ('preparing', 'armed', 'awaiting_late_start') THEN 2
            WHEN ${focusSessions.state} = 'reminded' THEN 1
            ELSE 0
          END`),
          asc(focusSessions.plannedStartAt),
          desc(focusSessions.updatedAt)
        )
        .limit(1);
      if (!session) return null;
      const scheduled = await this.materializeScheduled(transaction as AppDatabase, session, now);
      const prepared = await this.materializePreparation(transaction as AppDatabase, scheduled, now);
      return this.materializeFixedEnd(transaction as AppDatabase, prepared, now);
    });
  }

  async pendingEvaluation(): Promise<StoredFocusSession | null> {
    const presentationCutoff = new Date(Date.now() - 90_000);
    const [session] = await this.db.select().from(focusSessions)
      .where(and(
        eq(focusSessions.state, "ended"),
        gt(focusSessions.endedAt, presentationCutoff),
      ))
      .orderBy(desc(focusSessions.endedAt), desc(focusSessions.updatedAt))
      .limit(1);
    return session ?? null;
  }

  async overlappingPreparation(): Promise<StoredFocusSession | null> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      await this.materializeOverdueRunningSessions(transaction as AppDatabase, now);
      const [running] = await transaction.select({ id: focusSessions.id }).from(focusSessions)
        .where(inArray(focusSessions.state, ["running", "paused"]))
        .limit(1);
      if (!running) return null;
      const [session] = await transaction.select().from(focusSessions)
        .where(inArray(focusSessions.state, ["preparing", "armed", "awaiting_late_start"]))
        .orderBy(asc(focusSessions.plannedStartAt), desc(focusSessions.updatedAt))
        .limit(1);
      if (!session) return null;
      const prepared = await this.materializePreparation(transaction as AppDatabase, session, now);
      return this.materializeFixedEnd(transaction as AppDatabase, prepared, now);
    });
  }

  async currentSnapshot(): Promise<FocusSessionSnapshot | null> {
    const session = await this.current();
    return session ? this.snapshotForSession(session) : null;
  }

  async currentExecutionSnapshot(): Promise<FocusSessionSnapshot | null> {
    const session = await this.currentExecution();
    return session ? this.snapshotForSession(session) : null;
  }

  async pendingEvaluationSnapshot(): Promise<FocusSessionSnapshot | null> {
    const session = await this.pendingEvaluation();
    return session ? this.snapshotForSession(session) : null;
  }

  async overlappingPreparationSnapshot(): Promise<FocusSessionSnapshot | null> {
    const session = await this.overlappingPreparation();
    return session ? this.snapshotForSession(session) : null;
  }

  private async snapshotForSession(session: StoredFocusSession): Promise<FocusSessionSnapshot | null> {
    const [task] = await this.db.select().from(tasks)
      .where(and(eq(tasks.id, session.taskId), isNull(tasks.deletedAt))).limit(1);
    if (!task) return null;

    const execution = session.focusStructureId
      ? await this.structureById(this.db, session.focusStructureId)
      : null;
    let cursor = execution?.structure.totalStartAt.getTime() ?? 0;
    const segments: FocusSnapshotSegment[] = execution?.segments.map((segment) => {
      const startsAt = new Date(cursor);
      cursor += segment.durationMinutes * 60_000;
      return {
        position: segment.position,
        segmentType: segment.segmentType as "focus" | "break",
        durationMinutes: segment.durationMinutes,
        startsAt,
        endsAt: new Date(cursor)
      };
    }) ?? [];
    const currentSegment = session.currentSegmentPosition === null
      ? null
      : segments[session.currentSegmentPosition] ?? null;
    const nextSegment = session.currentSegmentPosition === null
      ? segments[0] ?? null
      : segments[session.currentSegmentPosition + 1] ?? null;

    let phase: FocusSnapshotPhase = "ended";
    let phaseStartedAt: Date | null = null;
    let phaseEndsAt: Date | null = null;
    if (session.state === "scheduled") {
      phase = "scheduled";
      phaseEndsAt = session.plannedStartAt;
    } else if (session.state === "reminded") {
      phase = "reminder";
      phaseStartedAt = session.remindedAt;
      phaseEndsAt = session.confirmationDeadlineAt;
    } else if (session.state === "preparing") {
      phase = "preparation";
      phaseEndsAt = session.preparingEndsAt;
      phaseStartedAt = session.preparingEndsAt
        ? new Date(session.preparingEndsAt.getTime() - 60_000)
        : null;
    } else if (session.state === "armed") {
      phase = "armed";
      phaseEndsAt = session.plannedStartAt;
    } else if (session.state === "awaiting_late_start") {
      phase = "awaiting_late_start";
      phaseStartedAt = session.plannedStartAt;
      phaseEndsAt = session.plannedEndAt;
    } else if (session.state === "running" || session.state === "paused") {
      phase = currentSegment?.segmentType ?? "focus";
      phaseStartedAt = currentSegment?.startsAt ?? session.startedAt;
      phaseEndsAt = currentSegment?.endsAt ?? session.plannedEndAt;
    }

    return {
      serverNow: new Date(),
      serverNowEpochMs: Date.now(),
      session,
      task: {
        id: task.id,
        title: task.title,
        timeZone: task.timeZone,
        startAt: task.startAt,
        endAt: task.endAt
      },
      phase,
      phaseStartedAt,
      phaseEndsAt,
      phaseEndsAtEpochMs: phaseEndsAt?.getTime() ?? null,
      sessionEndsAt: session.plannedEndAt,
      sessionEndsAtEpochMs: session.plannedEndAt?.getTime() ?? null,
      currentSegment,
      nextSegment,
      segments
    };
  }

  async startAwaitingCurrent(): Promise<StoredFocusSession | null> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      const [current] = await transaction.select().from(focusSessions).where(and(
        inArray(focusSessions.state, ["preparing", "armed", "awaiting_late_start", "running"]),
        lte(focusSessions.plannedStartAt, now),
        gt(focusSessions.plannedEndAt, now)
      )).orderBy(desc(focusSessions.plannedStartAt)).limit(1);
      if (!current) return null;
      if (current.state === "running") return current;
      const [task] = await transaction.select().from(tasks).where(and(
        eq(tasks.id, current.taskId),
        eq(tasks.lifecycleStatus, "open"),
        isNull(tasks.deletedAt)
      )).limit(1);
      if (!task) return null;
      return this.confirmStart(transaction as AppDatabase, current, task, now);
    });
  }

  async create(taskId: string, expectedTaskVersion: number, mode: "remind" | "prepare" = "prepare", commandId?: string): Promise<StoredFocusSession> {
    return this.db.transaction(async (transaction) => {
      const replay = await this.replayCommand(transaction as AppDatabase, { commandId, operation: "create", expectedVersion: expectedTaskVersion, taskId });
      if (replay) return replay;
      const now = new Date();
      const integrationSettings = await focusIntegrationSettings(transaction as AppDatabase);
      if (!integrationSettings.desktopFocusEnabled && !integrationSettings.feishuTaskCardsEnabled) {
        throw new FocusDisabledError();
      }
      const [task] = await transaction.select().from(tasks).where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt))).limit(1);
      if (!task) throw new FocusNotFoundError();
      if (task.version !== expectedTaskVersion) throw new Error("task_version_conflict");
      if (task.recordKind !== "formal") throw new FocusTransitionError(task.lifecycleStatus, "start focus for a factual backfill");
      if (task.lifecycleStatus !== "open") {
        throw new FocusTransitionError(task.lifecycleStatus, "start focus for");
      }
      if (task.scheduleKind !== "exact" || !task.startAt || !task.endAt) {
        throw new FocusTaskNotScheduledError();
      }
      if (task.endAt && task.endAt <= now) throw new FocusTransitionError(task.lifecycleStatus, "start focus after its fixed end");
      const [existing] = await transaction.select().from(focusSessions)
        .where(and(eq(focusSessions.taskId, task.id), inArray(focusSessions.state, recoverableStates)))
        .orderBy(desc(focusSessions.createdAt)).limit(1);
      if (existing) {
        if (mode === "remind") return existing;
        const confirmed = await this.confirmStart(transaction as AppDatabase, existing, task, now);
        await this.recordCommand(transaction as AppDatabase, commandId, "create", expectedTaskVersion, confirmed);
        return confirmed;
      }

      const futureExactStart = task.startAt > now;
      if (mode === "prepare" && futureExactStart && task.startAt.getTime() - now.getTime() > 60_000) {
        throw new FocusTransitionError(task.lifecycleStatus, "confirm focus before the one-minute preparation window");
      }
      const state: FocusSessionState = mode === "remind" ? "reminded" : "preparing";
      const execution = mode === "prepare" || !futureExactStart
        ? await this.activeStructure(transaction as AppDatabase, task.id, task.scheduleRevision)
        : null;
      const confirmationDeadlineAt = state === "reminded"
        ? new Date(Math.max(now.getTime(), task.startAt?.getTime() ?? now.getTime()) + 5 * 60_000)
        : null;
      const preparingEndsAt = state === "preparing" ? task.startAt : null;

      const [created] = await transaction.insert(focusSessions).values({
        id: randomUUID(), taskId, state,
        plannedStartAt: task.startAt, plannedEndAt: task.endAt, remindedAt: mode === "remind" ? now : null,
        preparingEndsAt,
        confirmationDeadlineAt,
        startedAt: null, activeSinceAt: null,
        focusStructureId: execution?.structure.id ?? null,
        focusStructureVersion: execution?.structure.version ?? null,
        focusStructureScheduleRevision: execution?.structure.taskScheduleRevision ?? null,
        currentSegmentPosition: execution ? 0 : null,
        currentSegmentStartedAt: execution?.structure.totalStartAt ?? null,
        currentSegmentElapsedSeconds: 0,
        rawActiveSeconds: 0, effectiveFocusSeconds: 0, version: 1
      }).returning();
      if (!created) throw new Error("PostgreSQL did not return focus session.");
      if (execution) {
        await transaction.insert(focusSessionSegmentRuns).values(execution.segments.map((segment, position) => ({
          id: randomUUID(), focusSessionId: created.id, position,
          segmentType: segment.segmentType, plannedDurationSeconds: segment.durationMinutes * 60,
          elapsedSeconds: 0, startedAt: null, completedAt: null, skippedAt: null,
          createdAt: now, updatedAt: now
        })));
      }
      if (state === "reminded") await transaction.insert(focusTimerJobs).values({
        id: randomUUID(),
        focusSessionId: created.id,
        kind: "confirmation_timeout",
        expectedSessionVersion: created.version,
        dueAt: created.confirmationDeadlineAt!,
        status: "pending",
        attempts: 0,
        createdAt: now,
        updatedAt: now
      });
      const result = mode === "prepare"
        ? await this.confirmStart(transaction as AppDatabase, created, task, now)
        : created;
      await this.recordCommand(transaction as AppDatabase, commandId, "create", expectedTaskVersion, result);
      return result;
    });
  }

  async begin(id: string, expectedVersion: number, commandId?: string): Promise<StoredFocusSession> {
    return this.db.transaction(async (transaction) => {
      const replay = await this.replayCommand(transaction as AppDatabase, { commandId, operation: "begin", expectedVersion, sessionId: id });
      if (replay) return replay;
      const now = new Date();
      const current = await this.requireCurrent(transaction as AppDatabase, id, expectedVersion);
      if (!["preparing", "armed", "awaiting_late_start", "scheduled", "reminded"].includes(current.state)) throw new FocusTransitionError(current.state, "begin");
      const [task] = await transaction.select().from(tasks).where(and(eq(tasks.id, current.taskId), isNull(tasks.deletedAt))).limit(1);
      if (!task) throw new FocusNotFoundError();
      if (task.lifecycleStatus !== "open") throw new FocusTransitionError(task.lifecycleStatus, "begin focus for");
      if (task.endAt && task.endAt <= now) {
        const stopped = await this.stopExpiredSession(transaction as AppDatabase, current, now);
        await this.recordCommand(transaction as AppDatabase, commandId, "begin", expectedVersion, stopped);
        return stopped;
      }
      const started = await this.confirmStart(transaction as AppDatabase, current, task, now);
      await this.recordCommand(transaction as AppDatabase, commandId, "begin", expectedVersion, started);
      return started;
    });
  }

  async skipPreparation(id: string, expectedVersion: number, commandId?: string): Promise<StoredFocusSession> {
    return this.db.transaction(async (transaction) => {
      const replay = await this.replayCommand(transaction as AppDatabase, { commandId, operation: "skip_preparation", expectedVersion, sessionId: id });
      if (replay) return replay;
      const now = new Date();
      const current = await this.requireCurrent(transaction as AppDatabase, id, expectedVersion);
      if (!["preparing", "armed", "awaiting_late_start", "scheduled", "reminded"].includes(current.state)) throw new FocusTransitionError(current.state, "confirm start for");
      const [task] = await transaction.select().from(tasks).where(and(eq(tasks.id, current.taskId), isNull(tasks.deletedAt))).limit(1);
      if (!task) throw new FocusNotFoundError();
      if (task.lifecycleStatus !== "open") throw new FocusTransitionError(task.lifecycleStatus, "begin focus for");
      if (task.endAt && task.endAt <= now) {
        const stopped = await this.stopExpiredSession(transaction as AppDatabase, current, now);
        await this.recordCommand(transaction as AppDatabase, commandId, "skip_preparation", expectedVersion, stopped);
        return stopped;
      }
      const started = await this.confirmStart(transaction as AppDatabase, current, task, now);
      await this.recordCommand(transaction as AppDatabase, commandId, "skip_preparation", expectedVersion, started);
      return started;
    });
  }

  async respondToReminder(id: string, expectedVersion: number, decision: "start" | "other_arrangement", commandId?: string): Promise<StoredFocusSession> {
    return this.db.transaction(async (transaction) => {
      const operation: FocusCommandOperation = decision === "start" ? "respond_start" : "other_arrangement";
      const replay = await this.replayCommand(transaction as AppDatabase, { commandId, operation, expectedVersion, sessionId: id });
      if (replay) return replay;
      const now = new Date();
      const current = await this.requireCurrent(transaction as AppDatabase, id, expectedVersion);
      if (!["reminded", "preparing", "armed", "awaiting_late_start", "scheduled"].includes(current.state)) throw new FocusTransitionError(current.state, "respond to reminder for");
      const [task] = await transaction.select().from(tasks).where(and(eq(tasks.id, current.taskId), isNull(tasks.deletedAt))).limit(1);
      if (!task) throw new FocusNotFoundError();
      if (task.lifecycleStatus !== "open") throw new FocusTransitionError(task.lifecycleStatus, "respond to reminder for");
      if (task.endAt && task.endAt <= now) {
        const stopped = await this.stopExpiredSession(transaction as AppDatabase, current, now);
        await this.recordCommand(transaction as AppDatabase, commandId, operation, expectedVersion, stopped);
        return stopped;
      }
      if (decision === "start") {
        const started = await this.confirmStart(transaction as AppDatabase, current, task, now);
        await this.recordCommand(transaction as AppDatabase, commandId, operation, expectedVersion, started);
        return started;
      }
      await this.cancelSessionTimerJobs(transaction as AppDatabase, current.id, now);
      const [updated] = await transaction.update(focusSessions).set({
        state: "stopped_for_change",
        endedAt: now,
        stoppedReason: "另有安排",
        confirmationDeadlineAt: null,
        version: current.version + 1,
        updatedAt: now
      }).where(and(eq(focusSessions.id, id), eq(focusSessions.version, expectedVersion))).returning();
      if (!updated) throw new FocusVersionConflictError(await this.requireCurrent(transaction as AppDatabase, id));
      await this.recordCommand(transaction as AppDatabase, commandId, operation, expectedVersion, updated);
      return updated;
    });
  }

  async end(id: string, expectedVersion: number, reason?: string, commandId?: string): Promise<StoredFocusSession> {
    const current = await this.requireCurrent(this.db, id, expectedVersion);
    throw new FocusTransitionError(current.state, "end before the fixed task boundary");
  }

  async pause(id: string, expectedVersion: number): Promise<StoredFocusSession> {
    const current = await this.requireCurrent(this.db, id, expectedVersion);
    throw new FocusTransitionError(current.state, "pause");
  }

  async resume(id: string, expectedVersion: number): Promise<StoredFocusSession> {
    const current = await this.requireCurrent(this.db, id, expectedVersion);
    throw new FocusTransitionError(current.state, "resume");
  }

  async otherArrangement(id: string, expectedVersion: number, reason?: string, commandId?: string): Promise<StoredFocusSession> {
    return this.db.transaction(async (transaction) => {
      const replay = await this.replayCommand(transaction as AppDatabase, { commandId, operation: "other_arrangement", expectedVersion, sessionId: id });
      if (replay) return replay;
      const now = new Date();
      const current = await this.requireCurrent(transaction as AppDatabase, id, expectedVersion);
      if (!["scheduled", "reminded", "preparing", "armed", "awaiting_late_start"].includes(current.state)) throw new FocusTransitionError(current.state, "change arrangement for");
      await this.cancelSessionTimerJobs(transaction as AppDatabase, current.id, now);
      await cancelTaskFollowUp(transaction as AppDatabase, current.taskId, now);
      const [updated] = await transaction.update(focusSessions).set({
        state: "stopped_for_change", rawActiveSeconds: elapsedSeconds(current, now), activeSinceAt: null, endedAt: now,
        stoppedReason: reason ?? "另有安排", version: current.version + 1, updatedAt: now
      }).where(and(eq(focusSessions.id, id), eq(focusSessions.version, expectedVersion))).returning();
      if (!updated) throw new FocusVersionConflictError(await this.requireCurrent(transaction as AppDatabase, id));
      await this.recordCommand(transaction as AppDatabase, commandId, "other_arrangement", expectedVersion, updated);
      return updated;
    });
  }

  async resolvePreparationDecision(
    id: string,
    expectedVersion: number,
    decision: "other_arrangement" | "cancel_task",
    reason?: string,
    commandId?: string,
  ): Promise<StoredFocusSession> {
    return this.db.transaction(async (transaction) => {
      const replay = await this.replayCommand(transaction as AppDatabase, {
        commandId,
        operation: "other_arrangement",
        expectedVersion,
        sessionId: id,
      });
      if (replay) return replay;

      const now = new Date();
      const current = await this.requireCurrent(transaction as AppDatabase, id, expectedVersion);
      if (!["scheduled", "reminded", "preparing", "armed", "awaiting_late_start"].includes(current.state)) {
        throw new FocusTransitionError(current.state, "resolve preparation for");
      }
      const [task] = await transaction.select().from(tasks)
        .where(and(eq(tasks.id, current.taskId), isNull(tasks.deletedAt)))
        .limit(1);
      if (!task) throw new FocusNotFoundError();
      if (task.lifecycleStatus !== "open" || task.recordKind !== "formal" || task.scheduleKind !== "exact") {
        throw new FocusTransitionError(task.lifecycleStatus, "change preparation task");
      }

      await this.cancelSessionTimerJobs(transaction as AppDatabase, current.id, now);
      await cancelTaskFollowUp(transaction as AppDatabase, current.taskId, now);
      const stoppedReason = reason ?? (decision === "cancel_task" ? "用户从准备窗口取消任务" : "用户从准备窗口选择另有安排");
      const [updated] = await transaction.update(focusSessions).set({
        state: "stopped_for_change",
        rawActiveSeconds: elapsedSeconds(current, now),
        activeSinceAt: null,
        endedAt: now,
        stoppedReason,
        version: current.version + 1,
        updatedAt: now,
      }).where(and(eq(focusSessions.id, id), eq(focusSessions.version, expectedVersion))).returning();
      if (!updated) throw new FocusVersionConflictError(await this.requireCurrent(transaction as AppDatabase, id));

      const [changedTask] = decision === "cancel_task"
        ? await transaction.update(tasks).set({
            lifecycleStatus: "cancelled",
            currentOutcome: null,
            deletedAt: now,
            version: task.version + 1,
            scheduleRevision: task.scheduleRevision + 1,
            updatedAt: now,
          }).where(and(eq(tasks.id, task.id), eq(tasks.version, task.version))).returning()
        : await transaction.update(tasks).set({
            scheduleKind: "none",
            daypart: null,
            startAt: null,
            endAt: null,
            version: task.version + 1,
            scheduleRevision: task.scheduleRevision + 1,
            updatedAt: now,
          }).where(and(eq(tasks.id, task.id), eq(tasks.version, task.version))).returning();
      if (!changedTask) throw new Error("task_version_conflict");
      await syncTaskStartReminder(transaction as AppDatabase, changedTask, now);
      if (decision === "cancel_task") {
        await transaction.insert(taskLifecycleEvents).values({
          id: randomUUID(),
          taskId: task.id,
          fromStatus: "open",
          toStatus: "cancelled",
          source: "app",
          reason: stoppedReason,
        });
        await transaction.insert(taskLifecycleEvents).values({
          id: randomUUID(),
          taskId: task.id,
          fromStatus: "cancelled",
          toStatus: "deleted",
          source: "app",
          reason: "取消任务后默认移入回收站",
        });
      }
      await this.recordCommand(transaction as AppDatabase, commandId, "other_arrangement", expectedVersion, updated);
      return updated;
    });
  }

  async skipFinalBreak(id: string, expectedVersion: number, commandId?: string): Promise<StoredFocusSession> {
    return this.db.transaction(async (transaction) => {
      const replay = await this.replayCommand(transaction as AppDatabase, { commandId, operation: "skip_final_break", expectedVersion, sessionId: id });
      if (replay) return replay;
      const now = new Date();
      const current = await this.requireCurrent(transaction as AppDatabase, id, expectedVersion);
      if (current.state !== "running" || !current.focusStructureId || current.currentSegmentPosition === null) {
        throw new FocusTransitionError(current.state, "skip final break for");
      }
      const execution = await this.structureById(transaction as AppDatabase, current.focusStructureId);
      const currentSegment = execution?.segments[current.currentSegmentPosition];
      if (!execution || current.currentSegmentPosition !== execution.segments.length - 1 || currentSegment?.segmentType !== "break") {
        throw new FocusTransitionError(current.state, "skip a non-final break for");
      }
      await this.finalizeCurrentSegmentRun(transaction as AppDatabase, current, now, true);
      await this.reconcileSegmentRuns(transaction as AppDatabase, current, now);
      const raw = elapsedSeconds(current, now);
      const effective = await this.recordedFocusSeconds(transaction as AppDatabase, current, raw);
      await this.cancelSessionTimerJobs(transaction as AppDatabase, current.id, now);
      const [updated] = await transaction.update(focusSessions).set({
        state: "ended",
        rawActiveSeconds: raw,
        effectiveFocusSeconds: effective,
        activeSinceAt: null,
        endedAt: now,
        stoppedReason: "用户跳过最后休息",
        version: current.version + 1,
        updatedAt: now
      }).where(and(eq(focusSessions.id, id), eq(focusSessions.version, expectedVersion))).returning();
      if (!updated) throw new FocusVersionConflictError(await this.requireCurrent(transaction as AppDatabase, id));
      await this.awaitTaskOutcome(transaction as AppDatabase, current.taskId, now, "用户跳过最后休息");
      await this.recordCommand(transaction as AppDatabase, commandId, "skip_final_break", expectedVersion, updated);
      return updated;
    });
  }

  async evaluate(
    id: string,
    expectedVersion: number,
    outcome: TaskOutcome,
    progressPercent: number,
    satisfaction: FocusSatisfaction,
    note?: string | null,
    commandId?: string
  ): Promise<StoredFocusSession> {
    return this.db.transaction(async (transaction) => {
      const replay = await this.replayCommand(transaction as AppDatabase, { commandId, operation: "evaluate", expectedVersion, sessionId: id });
      if (replay) return replay;
      const now = new Date();
      const current = await this.requireCurrent(transaction as AppDatabase, id, expectedVersion);
      if (current.state !== "ended") throw new FocusTransitionError(current.state, "evaluate");
      const [task] = await transaction.select().from(tasks).where(and(eq(tasks.id, current.taskId), isNull(tasks.deletedAt))).limit(1);
      if (!task) throw new FocusNotFoundError();
      if (task.lifecycleStatus !== "awaiting_outcome") throw new FocusTransitionError(task.lifecycleStatus, "record focus outcome for");
      const effective = await this.recordedFocusSeconds(transaction as AppDatabase, current, current.rawActiveSeconds);
      const [updated] = await transaction.update(focusSessions).set({ state: "evaluated", effectiveFocusSeconds: effective, version: current.version + 1, updatedAt: now })
        .where(and(eq(focusSessions.id, id), eq(focusSessions.version, expectedVersion))).returning();
      if (!updated) throw new FocusVersionConflictError(await this.requireCurrent(transaction as AppDatabase, id));
      await transaction.insert(taskFeedback).values({ id: randomUUID(), taskId: task.id, focusSessionId: id, satisfaction, note: note ?? null });
      await transaction.insert(taskOutcomes).values({ id: randomUUID(), taskId: task.id, focusSessionId: id, outcome, progressPercent, source: "app", note: note ?? null });
      const [closed] = await transaction.update(tasks).set({ lifecycleStatus: "closed", currentOutcome: outcome, version: task.version + 1, scheduleRevision: task.scheduleRevision + 1, updatedAt: now })
        .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version))).returning();
      if (!closed) throw new Error("task_version_conflict");
      await syncTaskStartReminder(transaction as AppDatabase, closed, now);
      await transaction.insert(taskLifecycleEvents).values({ id: randomUUID(), taskId: task.id, fromStatus: "awaiting_outcome", toStatus: "closed", source: "app", reason: note ?? null });
      await this.recordCommand(transaction as AppDatabase, commandId, "evaluate", expectedVersion, updated);
      return updated;
    });
  }

  private async replayCommand(db: AppDatabase, input: {
    commandId?: string;
    operation: FocusCommandOperation;
    expectedVersion: number;
    sessionId?: string;
    taskId?: string;
  }): Promise<StoredFocusSession | null> {
    if (!input.commandId) return null;
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.commandId}, 0))`);
    const [operation] = await db.select().from(focusSessionOperations)
      .where(eq(focusSessionOperations.commandId, input.commandId)).limit(1);
    if (!operation) return null;
    if (operation.operation !== input.operation || operation.expectedVersion !== input.expectedVersion
      || (input.sessionId && operation.focusSessionId !== input.sessionId)) {
      throw new FocusCommandConflictError();
    }
    const session = await this.requireCurrent(db, operation.focusSessionId);
    if (input.taskId && session.taskId !== input.taskId) throw new FocusCommandConflictError();
    return session;
  }

  private async recordCommand(
    db: AppDatabase,
    commandId: string | undefined,
    operation: FocusCommandOperation,
    expectedVersion: number,
    session: StoredFocusSession
  ): Promise<void> {
    if (!commandId) return;
    await db.insert(focusSessionOperations).values({
      commandId,
      focusSessionId: session.id,
      operation,
      expectedVersion,
      resultingVersion: session.version,
      resultingState: session.state,
      resultPayload: { taskId: session.taskId }
    });
  }

  private async requireCurrent(db: AppDatabase, id: string, expectedVersion?: number): Promise<StoredFocusSession> {
    const [current] = await db.select().from(focusSessions).where(eq(focusSessions.id, id)).limit(1);
    if (!current) throw new FocusNotFoundError();
    if (expectedVersion !== undefined && current.version !== expectedVersion) throw new FocusVersionConflictError(current);
    return current;
  }

  private async activeStructure(db: AppDatabase, taskId: string, scheduleRevision: number) {
    const [structure] = await db.select().from(focusStructures).where(and(
      eq(focusStructures.taskId, taskId),
      eq(focusStructures.taskScheduleRevision, scheduleRevision),
      eq(focusStructures.state, "active")
    )).limit(1);
    if (!structure) return null;
    return { structure, segments: await this.listStructureSegments(db, structure.id) };
  }

  private async structureById(db: AppDatabase, id: string) {
    const [structure] = await db.select().from(focusStructures).where(eq(focusStructures.id, id)).limit(1);
    if (!structure) return null;
    return { structure, segments: await this.listStructureSegments(db, id) };
  }

  private listStructureSegments(db: AppDatabase, id: string) {
    return db.select().from(focusStructureSegments)
      .where(eq(focusStructureSegments.focusStructureId, id))
      .orderBy(asc(focusStructureSegments.position));
  }

  private async scheduleSegmentTransition(
    db: AppDatabase,
    session: StoredFocusSession,
    execution: { structure: typeof focusStructures.$inferSelect; segments: Array<{ position: number; durationMinutes: number }> },
    position: number,
    now: Date
  ): Promise<void> {
    const dueAt = focusSegmentEndAt({
      structureStartAt: execution.structure.totalStartAt,
      segments: execution.segments,
      position
    });
    if (!dueAt || dueAt <= now) return;
    await db.insert(focusTimerJobs).values({
      id: randomUUID(),
      focusSessionId: session.id,
      kind: "segment_transition",
      expectedSessionVersion: session.version,
      dueAt,
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now
    }).onConflictDoNothing();
  }

  private async replaceSegmentRuns(
    db: AppDatabase,
    sessionId: string,
    execution: Awaited<ReturnType<FocusService["activeStructure"]>>,
    now: Date
  ): Promise<void> {
    await db.delete(focusSessionSegmentRuns).where(eq(focusSessionSegmentRuns.focusSessionId, sessionId));
    if (!execution) return;
    await db.insert(focusSessionSegmentRuns).values(execution.segments.map((segment, position) => ({
      id: randomUUID(),
      focusSessionId: sessionId,
      position,
      segmentType: segment.segmentType,
      plannedDurationSeconds: segment.durationMinutes * 60,
      elapsedSeconds: 0,
      startedAt: null,
      completedAt: null,
      skippedAt: null,
      createdAt: now,
      updatedAt: now
    })));
  }

  private async markSegmentStart(
    db: AppDatabase,
    sessionId: string,
    position: number,
    now: Date
  ): Promise<void> {
    if (position > 0) {
      await db.update(focusSessionSegmentRuns).set({
        elapsedSeconds: 0,
        startedAt: null,
        completedAt: null,
        skippedAt: now,
        updatedAt: now
      }).where(and(
        eq(focusSessionSegmentRuns.focusSessionId, sessionId),
        lt(focusSessionSegmentRuns.position, position)
      ));
    }
    await db.update(focusSessionSegmentRuns).set({
      elapsedSeconds: 0,
      startedAt: now,
      completedAt: null,
      skippedAt: null,
      updatedAt: now
    }).where(and(
      eq(focusSessionSegmentRuns.focusSessionId, sessionId),
      eq(focusSessionSegmentRuns.position, position)
    ));
  }

  private async startRunning(
    db: AppDatabase,
    current: StoredFocusSession,
    task: typeof tasks.$inferSelect,
    now: Date
  ): Promise<StoredFocusSession> {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('personal-ai-focus-running', 0))`);
    await this.materializeOverdueRunningSessions(db, now);
    const [blockingSession] = await db.select({ id: focusSessions.id }).from(focusSessions).where(and(
      ne(focusSessions.id, current.id),
      inArray(focusSessions.state, ["running", "paused"]),
    )).limit(1);
    if (blockingSession) throw new FocusBusyError();

    const execution = current.focusStructureId ? await this.structureById(db, current.focusStructureId) : null;
    const position = execution ? locateFocusSegment({
      structureStartAt: execution.structure.totalStartAt,
      segments: execution.segments,
      now
    }) : null;
    if (!execution || !position || execution.segments[position.position]?.segmentType !== "focus") {
      throw new FocusTransitionError(current.state, "start when no planned focus time remains");
    }
    const [updated] = await db.update(focusSessions).set({
      state: "running",
      startedAt: now,
      activeSinceAt: now,
      preparingEndsAt: null,
      version: current.version + 1,
      updatedAt: now
    }).where(and(eq(focusSessions.id, current.id), eq(focusSessions.version, current.version))).returning();
    if (!updated) throw new FocusVersionConflictError(await this.requireCurrent(db, current.id));
    const activeTask = await this.activateTask(db, task, now);
    await cancelTaskFollowUp(db, task.id, now);
    await queueTaskStartCardUpdate(db, activeTask, "started", now);
    const [positioned] = await db.update(focusSessions).set({
      currentSegmentPosition: position.position,
      currentSegmentStartedAt: position.plannedStartedAt,
      currentSegmentElapsedSeconds: position.elapsedSeconds,
      updatedAt: now
    }).where(and(eq(focusSessions.id, current.id), eq(focusSessions.version, updated.version))).returning();
    if (!positioned) throw new FocusVersionConflictError(await this.requireCurrent(db, current.id));
    await this.markSegmentStart(db, current.id, position.position, now);
    await this.scheduleSegmentTransition(db, positioned, execution, position.position, now);
    return positioned;
  }

  private async confirmStart(
    db: AppDatabase,
    current: StoredFocusSession,
    task: typeof tasks.$inferSelect,
    now: Date
  ): Promise<StoredFocusSession> {
    if (current.state === "running") return current;
    if (!task.startAt || !task.endAt || task.endAt <= now) return this.stopExpiredSession(db, current, now);
    let prepared = current;
    let execution = current.focusStructureId ? await this.structureById(db, current.focusStructureId) : null;
    if (!execution) {
      execution = await this.activeStructure(db, task.id, task.scheduleRevision);
      if (!execution) throw new FocusTransitionError(current.state, "start without a confirmed focus structure");
      const [attached] = await db.update(focusSessions).set({
        focusStructureId: execution.structure.id,
        focusStructureVersion: execution.structure.version,
        focusStructureScheduleRevision: execution.structure.taskScheduleRevision,
        currentSegmentPosition: 0,
        currentSegmentStartedAt: execution.structure.totalStartAt,
        currentSegmentElapsedSeconds: 0,
        version: current.version + 1,
        updatedAt: now
      }).where(and(eq(focusSessions.id, current.id), eq(focusSessions.version, current.version))).returning();
      if (!attached) throw new FocusVersionConflictError(await this.requireCurrent(db, current.id));
      await this.replaceSegmentRuns(db, current.id, execution, now);
      prepared = attached;
    }
    if (now < task.startAt) {
      if (task.startAt.getTime() - now.getTime() > 60_000) {
        throw new FocusTransitionError(prepared.state, "confirm focus before the one-minute preparation window");
      }
      const [armed] = await db.update(focusSessions).set({
        state: "armed",
        preparingEndsAt: task.startAt,
        confirmationDeadlineAt: null,
        version: prepared.version + 1,
        updatedAt: now
      }).where(and(eq(focusSessions.id, prepared.id), eq(focusSessions.version, prepared.version))).returning();
      if (!armed) throw new FocusVersionConflictError(await this.requireCurrent(db, prepared.id));
      await queueTaskStartCardUpdate(db, task, "started", now);
      await db.insert(focusTimerJobs).values({
        id: randomUUID(),
        focusSessionId: armed.id,
        kind: "confirmation_timeout",
        expectedSessionVersion: armed.version,
        dueAt: task.startAt,
        status: "pending",
        attempts: 0,
        createdAt: now,
        updatedAt: now
      }).onConflictDoNothing();
      await this.rebindSessionTimerJobs(db, armed, now);
      return armed;
    }
    await this.cancelSessionTimerJobs(db, prepared.id, now);
    return this.startRunning(db, prepared, task, now);
  }

  private async finalizeCurrentSegmentRun(
    db: AppDatabase,
    current: StoredFocusSession,
    endedAt: Date,
    skipped: boolean
  ): Promise<void> {
    if (current.currentSegmentPosition === null) return;
    const [run] = await db.select().from(focusSessionSegmentRuns).where(and(
      eq(focusSessionSegmentRuns.focusSessionId, current.id),
      eq(focusSessionSegmentRuns.position, current.currentSegmentPosition)
    )).limit(1);
    if (!run) return;
    const elapsed = Math.min(run.plannedDurationSeconds, run.elapsedSeconds + calculateSegmentElapsedSeconds({
      actualStartedAt: run.startedAt,
      endedAt,
      plannedDurationSeconds: run.plannedDurationSeconds
    }));
    await db.update(focusSessionSegmentRuns).set({
      elapsedSeconds: elapsed,
      completedAt: skipped ? null : endedAt,
      skippedAt: skipped ? endedAt : run.skippedAt,
      updatedAt: endedAt
    }).where(eq(focusSessionSegmentRuns.id, run.id));
  }

  /** Reconcile every segment at the fixed boundary so missed worker ticks do
   * not drop focus time from earlier segments. */
  private async reconcileSegmentRuns(
    db: AppDatabase,
    current: StoredFocusSession,
    endedAt: Date,
  ): Promise<void> {
    if (!current.focusStructureId || !current.startedAt) return;
    const execution = await this.structureById(db, current.focusStructureId);
    if (!execution) return;
    const runs = await db.select().from(focusSessionSegmentRuns)
      .where(eq(focusSessionSegmentRuns.focusSessionId, current.id));
    const actualStart = current.startedAt.getTime();
    const structureStart = execution.structure.totalStartAt.getTime();
    if (actualStart < structureStart) return;
    const finalTime = Math.min(endedAt.getTime(), current.plannedEndAt?.getTime() ?? endedAt.getTime());
    let cursor = execution.structure.totalStartAt.getTime();
    for (const segment of execution.segments) {
      const segmentStart = cursor;
      const segmentEnd = cursor + segment.durationMinutes * 60_000;
      cursor = segmentEnd;
      const run = runs.find((item) => item.position === segment.position);
      if (!run) continue;
      const overlapStart = Math.max(actualStart, segmentStart);
      const overlapEnd = Math.min(finalTime, segmentEnd);
      const calculatedElapsedSeconds = overlapEnd > overlapStart
        ? Math.floor((overlapEnd - overlapStart) / 1000)
        : 0;
      const elapsedSeconds = Math.min(
        run.plannedDurationSeconds,
        Math.max(run.elapsedSeconds, calculatedElapsedSeconds),
      );
      const skipped = segmentEnd <= actualStart;
      await db.update(focusSessionSegmentRuns).set({
        elapsedSeconds,
        startedAt: run.startedAt && !skipped && segmentEnd > finalTime ? run.startedAt : null,
        completedAt: run.completedAt ?? (!skipped && segmentEnd <= finalTime ? new Date(segmentEnd) : null),
        skippedAt: run.skippedAt ?? (skipped ? current.startedAt : null),
        updatedAt: endedAt,
      }).where(eq(focusSessionSegmentRuns.id, run.id));
    }
  }

  private async recordedFocusSeconds(
    db: AppDatabase,
    current: StoredFocusSession,
    rawActiveSeconds: number
  ): Promise<number> {
    if (!current.focusStructureId) return rawActiveSeconds;
    const runs = await db.select({
      segmentType: focusSessionSegmentRuns.segmentType,
      elapsedSeconds: focusSessionSegmentRuns.elapsedSeconds
    }).from(focusSessionSegmentRuns)
      .where(eq(focusSessionSegmentRuns.focusSessionId, current.id));
    if (runs.length === 0) {
      return current.effectiveFocusSeconds > 0
        ? current.effectiveFocusSeconds
        : rawActiveSeconds;
    }
    return runs
      .filter((run) => run.segmentType === "focus")
      .reduce((sum, run) => sum + run.elapsedSeconds, 0);
  }

  private async freezeCurrentSegmentRun(
    db: AppDatabase,
    current: StoredFocusSession,
    pausedAt: Date
  ): Promise<void> {
    if (current.currentSegmentPosition === null) return;
    const [run] = await db.select().from(focusSessionSegmentRuns).where(and(
      eq(focusSessionSegmentRuns.focusSessionId, current.id),
      eq(focusSessionSegmentRuns.position, current.currentSegmentPosition)
    )).limit(1);
    if (!run) return;
    const elapsed = Math.min(run.plannedDurationSeconds, run.elapsedSeconds + calculateSegmentElapsedSeconds({
      actualStartedAt: run.startedAt,
      endedAt: pausedAt,
      plannedDurationSeconds: run.plannedDurationSeconds
    }));
    await db.update(focusSessionSegmentRuns).set({
      elapsedSeconds: elapsed,
      startedAt: null,
      updatedAt: pausedAt
    }).where(eq(focusSessionSegmentRuns.id, run.id));
  }

  private async resumeCurrentSegmentRun(
    db: AppDatabase,
    current: StoredFocusSession,
    resumedAt: Date
  ): Promise<void> {
    if (current.currentSegmentPosition === null) return;
    await db.update(focusSessionSegmentRuns).set({
      startedAt: resumedAt,
      updatedAt: resumedAt
    }).where(and(
      eq(focusSessionSegmentRuns.focusSessionId, current.id),
      eq(focusSessionSegmentRuns.position, current.currentSegmentPosition),
      isNull(focusSessionSegmentRuns.completedAt),
      isNull(focusSessionSegmentRuns.skippedAt)
    ));
  }

  private async rebindSessionTimerJobs(
    db: AppDatabase,
    session: StoredFocusSession,
    now: Date
  ): Promise<void> {
    await db.update(focusTimerJobs).set({
      expectedSessionVersion: session.version,
      updatedAt: now
    }).where(and(
      eq(focusTimerJobs.focusSessionId, session.id),
      inArray(focusTimerJobs.status, ["pending", "processing", "failed"])
    ));
  }

  private async cancelSessionTimerJobs(db: AppDatabase, sessionId: string, now: Date): Promise<void> {
    await db.update(focusTimerJobs).set({ status: "cancelled", updatedAt: now })
      .where(and(
        eq(focusTimerJobs.focusSessionId, sessionId),
        inArray(focusTimerJobs.status, ["pending", "processing", "failed"])
      ));
  }

  private async stopExpiredSession(db: AppDatabase, current: StoredFocusSession, now: Date): Promise<StoredFocusSession> {
    await this.cancelSessionTimerJobs(db, current.id, now);
    const [stopped] = await db.update(focusSessions).set({
      state: "stopped_no_response",
      activeSinceAt: null,
      endedAt: now,
      stoppedReason: "固定结束时间已过，未进入专注",
      version: current.version + 1,
      updatedAt: now
    }).where(and(eq(focusSessions.id, current.id), eq(focusSessions.version, current.version))).returning();
    if (!stopped) throw new FocusVersionConflictError(await this.requireCurrent(db, current.id));
    await recordFocusNoResponseOutcome(db, {
      taskId: current.taskId,
      focusSessionId: current.id,
      now,
      reason: "固定结束时间已过，未进入专注"
    });
    return stopped;
  }

  private async materializeScheduled(db: AppDatabase, current: StoredFocusSession, now: Date): Promise<StoredFocusSession> {
    if (current.state !== "scheduled" || !current.plannedStartAt || new Date(current.plannedStartAt.getTime() - 60_000) > now) return current;
    const [task] = await db.select().from(tasks).where(and(eq(tasks.id, current.taskId), isNull(tasks.deletedAt))).limit(1);
    if (!task || task.lifecycleStatus !== "open") return current;
    if (task.endAt && task.endAt <= now) return this.stopExpiredSession(db, current, now);
    const execution = await this.activeStructure(db, task.id, task.scheduleRevision);
    await this.cancelSessionTimerJobs(db, current.id, now);
    const [preparing] = await db.update(focusSessions).set({
      state: "preparing",
      preparingEndsAt: current.plannedStartAt,
      focusStructureId: execution?.structure.id ?? null,
      focusStructureVersion: execution?.structure.version ?? null,
      focusStructureScheduleRevision: execution?.structure.taskScheduleRevision ?? null,
      currentSegmentPosition: execution ? 0 : null,
      currentSegmentStartedAt: execution?.structure.totalStartAt ?? null,
      currentSegmentElapsedSeconds: 0,
      version: current.version + 1,
      updatedAt: now
    }).where(and(eq(focusSessions.id, current.id), eq(focusSessions.version, current.version))).returning();
    if (!preparing) return this.requireCurrent(db, current.id);
    await this.replaceSegmentRuns(db, current.id, execution, now);
    await db.insert(focusTimerJobs).values({
      id: randomUUID(),
      focusSessionId: current.id,
      kind: "confirmation_timeout",
      expectedSessionVersion: preparing.version,
      dueAt: preparing.preparingEndsAt!,
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now
    }).onConflictDoNothing();
    return preparing;
  }

  private async materializePreparation(db: AppDatabase, current: StoredFocusSession, now: Date): Promise<StoredFocusSession> {
    if (current.state === "reminded" && current.confirmationDeadlineAt && current.confirmationDeadlineAt <= now) {
      const [late] = await db.update(focusSessions).set({ state: "awaiting_late_start", confirmationDeadlineAt: null, version: current.version + 1, updatedAt: now })
        .where(and(eq(focusSessions.id, current.id), eq(focusSessions.version, current.version))).returning();
      return late ?? current;
    }
    if (!["preparing", "armed"].includes(current.state) || !current.preparingEndsAt || current.preparingEndsAt > now) return current;
    const [task] = await db.select().from(tasks).where(and(eq(tasks.id, current.taskId), isNull(tasks.deletedAt))).limit(1);
    if (!task || task.lifecycleStatus !== "open") return current;
    if (task.endAt && task.endAt <= now) return this.stopExpiredSession(db, current, now);
    if (current.state === "armed") {
      await this.cancelSessionTimerJobs(db, current.id, now);
      return this.startRunning(db, current, task, now);
    }
    const [late] = await db.update(focusSessions).set({
      state: "awaiting_late_start",
      preparingEndsAt: null,
      version: current.version + 1,
      updatedAt: now
    }).where(and(eq(focusSessions.id, current.id), eq(focusSessions.version, current.version))).returning();
    return late ?? current;
  }

  private async materializeFixedEnd(db: AppDatabase, current: StoredFocusSession, now: Date): Promise<StoredFocusSession> {
    if (["scheduled", "reminded", "preparing", "armed", "awaiting_late_start"].includes(current.state)
      && current.plannedEndAt && current.plannedEndAt <= now) {
      return this.stopExpiredSession(db, current, now);
    }
    if ((current.state !== "running" && current.state !== "paused") || !current.plannedEndAt || current.plannedEndAt > now) return current;
    await this.finalizeCurrentSegmentRun(db, current, current.plannedEndAt, false);
    await this.reconcileSegmentRuns(db, current, current.plannedEndAt);
    const raw = elapsedSeconds(current, now);
    const effective = await this.recordedFocusSeconds(db, current, raw);
    await this.cancelSessionTimerJobs(db, current.id, now);
    const [ended] = await db.update(focusSessions).set({
      state: "ended", rawActiveSeconds: raw, effectiveFocusSeconds: effective, activeSinceAt: null, pausedAt: null,
      endedAt: current.plannedEndAt, version: current.version + 1, updatedAt: now
    }).where(and(eq(focusSessions.id, current.id), eq(focusSessions.version, current.version))).returning();
    if (!ended) return current;
    await this.awaitTaskOutcome(db, current.taskId, now, "固定结束时间到达");
    return ended;
  }

  private async materializeOverdueRunningSessions(db: AppDatabase, now: Date): Promise<void> {
    const overdue = await db.select().from(focusSessions).where(and(
      inArray(focusSessions.state, ["running", "paused"]),
      lte(focusSessions.plannedEndAt, now),
    )).orderBy(asc(focusSessions.plannedEndAt));
    for (const session of overdue) {
      await this.materializeFixedEnd(db, session, now);
    }
  }

  private async activateTask(db: AppDatabase, task: typeof tasks.$inferSelect, now: Date): Promise<typeof tasks.$inferSelect> {
    const [updated] = await db.update(tasks).set({ lifecycleStatus: "active", version: task.version + 1, updatedAt: now })
      .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version))).returning();
    if (!updated) throw new Error("task_version_conflict");
    await syncTaskStartReminder(db, updated, now);
    await db.insert(taskLifecycleEvents).values({ id: randomUUID(), taskId: task.id, fromStatus: task.lifecycleStatus, toStatus: "active", source: "app" });
    return updated;
  }

  private async awaitTaskOutcome(db: AppDatabase, taskId: string, now: Date, reason?: string): Promise<void> {
    const [task] = await db.select().from(tasks).where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt))).limit(1);
    if (!task || task.lifecycleStatus !== "active") return;
    const [updated] = await db.update(tasks).set({ lifecycleStatus: "awaiting_outcome", version: task.version + 1, updatedAt: now })
      .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version))).returning();
    if (!updated) throw new Error("task_version_conflict");
    await syncTaskStartReminder(db, updated, now);
    await db.insert(taskLifecycleEvents).values({ id: randomUUID(), taskId: task.id, fromStatus: "active", toStatus: "awaiting_outcome", source: "app", reason: reason ?? null });
  }
}

export function elapsedSeconds(session: StoredFocusSession, now = new Date()): number {
  if (session.state !== "running" || !session.activeSinceAt) return session.rawActiveSeconds;
  const cappedNow = session.plannedEndAt && session.plannedEndAt < now ? session.plannedEndAt : now;
  return session.rawActiveSeconds + Math.max(0, Math.floor((cappedNow.getTime() - session.activeSinceAt.getTime()) / 1000));
}
