import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { recordFocusNoResponseOutcome } from "@personal-ai/db/focus-no-response";
import { focusSessionSegmentRuns, focusSessions, focusStructureSegments, focusStructures, focusTimerJobs, taskFeedback, taskLifecycleEvents, taskOutcomes, tasks } from "@personal-ai/db/schema";
import {
  calculateEffectiveFocusSeconds,
  calculateSegmentElapsedSeconds,
  focusSegmentEndAt,
  locateFocusSegment,
  type FocusSatisfaction,
  type FocusSessionState
} from "@personal-ai/domain/focus";
import type { TaskOutcome } from "@personal-ai/domain/task";
import { cancelTaskFollowUp, syncTaskStartReminder } from "./reminder-scheduler.js";

const recoverableStates: FocusSessionState[] = ["scheduled", "reminded", "preparing", "running"];
const currentStates: FocusSessionState[] = [...recoverableStates, "ended"];
const activeTimerStates: FocusSessionState[] = ["running"];

export type StoredFocusSession = typeof focusSessions.$inferSelect;

export class FocusNotFoundError extends Error {}
export class FocusVersionConflictError extends Error {
  constructor(readonly current: StoredFocusSession) { super("Focus session version does not match."); }
}
export class FocusTransitionError extends Error {
  constructor(readonly state: string, readonly operation: string) { super(`Cannot ${operation} a focus session in ${state}.`); }
}
export class FocusBusyError extends Error { constructor() { super("Another focus session is already active."); } }

export class FocusService {
  constructor(private readonly db: AppDatabase) {}

  async current(): Promise<StoredFocusSession | null> {
    return this.db.transaction(async (transaction) => {
      const [session] = await transaction.select().from(focusSessions)
        .where(inArray(focusSessions.state, currentStates)).orderBy(desc(focusSessions.updatedAt)).limit(1);
      if (!session) return null;
      const now = new Date();
      const scheduled = await this.materializeScheduled(transaction as AppDatabase, session, now);
      const prepared = await this.materializePreparation(transaction as AppDatabase, scheduled, now);
      return this.materializeFixedEnd(transaction as AppDatabase, prepared, now);
    });
  }

  async create(taskId: string, expectedTaskVersion: number, mode: "remind" | "prepare" = "prepare"): Promise<StoredFocusSession> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      const [task] = await transaction.select().from(tasks).where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt))).limit(1);
      if (!task) throw new FocusNotFoundError();
      if (task.version !== expectedTaskVersion) throw new Error("task_version_conflict");
      if (task.lifecycleStatus !== "open") {
        throw new FocusTransitionError(task.lifecycleStatus, "start focus for");
      }
      if (task.endAt && task.endAt <= now) throw new FocusTransitionError(task.lifecycleStatus, "start focus after its fixed end");
      const [existing] = await transaction.select({ id: focusSessions.id }).from(focusSessions)
        .where(inArray(focusSessions.state, recoverableStates)).limit(1);
      if (existing) throw new FocusBusyError();

      const futureExactStart = task.scheduleKind === "exact" && task.startAt && task.startAt > now;
      const state: FocusSessionState = mode === "remind"
        ? "reminded"
        : futureExactStart
          ? "scheduled"
          : "preparing";
      const execution = state === "preparing"
        ? await this.activeStructure(transaction as AppDatabase, task.id, task.scheduleRevision)
        : null;
      const confirmationDeadlineAt = state === "reminded"
        ? new Date(Math.max(now.getTime(), task.startAt?.getTime() ?? now.getTime()) + 5 * 60_000)
        : null;
      const preparingEndsAt = state === "preparing" ? new Date(now.getTime() + 60_000) : null;

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
      await transaction.insert(focusTimerJobs).values({
        id: randomUUID(),
        focusSessionId: created.id,
        kind: state === "reminded"
          ? "confirmation_timeout"
          : state === "scheduled"
            ? "preparation_start"
            : "preparation_complete",
        expectedSessionVersion: created.version,
        dueAt: state === "reminded"
          ? created.confirmationDeadlineAt!
          : state === "scheduled"
            ? created.plannedStartAt!
            : created.preparingEndsAt!,
        status: "pending",
        attempts: 0,
        createdAt: now,
        updatedAt: now
      });
      if (mode === "prepare") await cancelTaskFollowUp(transaction as AppDatabase, task.id, now);
      return created;
    });
  }

  async begin(id: string, expectedVersion: number): Promise<StoredFocusSession> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      const current = await this.requireCurrent(transaction as AppDatabase, id, expectedVersion);
      if (current.state !== "preparing") throw new FocusTransitionError(current.state, "begin");
      if (current.preparingEndsAt && current.preparingEndsAt > now) throw new FocusTransitionError(current.state, "begin before preparation ends");
      const [task] = await transaction.select().from(tasks).where(and(eq(tasks.id, current.taskId), isNull(tasks.deletedAt))).limit(1);
      if (!task) throw new FocusNotFoundError();
      if (task.lifecycleStatus !== "open") throw new FocusTransitionError(task.lifecycleStatus, "begin focus for");
      if (task.endAt && task.endAt <= now) return this.stopExpiredSession(transaction as AppDatabase, current, now);
      await this.cancelSessionTimerJobs(transaction as AppDatabase, current.id, now);
      return this.startRunning(transaction as AppDatabase, current, task, now);
    });
  }

  async skipPreparation(id: string, expectedVersion: number): Promise<StoredFocusSession> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      const current = await this.requireCurrent(transaction as AppDatabase, id, expectedVersion);
      if (current.state !== "preparing") throw new FocusTransitionError(current.state, "skip preparation for");
      const [task] = await transaction.select().from(tasks).where(and(eq(tasks.id, current.taskId), isNull(tasks.deletedAt))).limit(1);
      if (!task) throw new FocusNotFoundError();
      if (task.lifecycleStatus !== "open") throw new FocusTransitionError(task.lifecycleStatus, "begin focus for");
      if (task.endAt && task.endAt <= now) return this.stopExpiredSession(transaction as AppDatabase, current, now);
      await this.cancelSessionTimerJobs(transaction as AppDatabase, current.id, now);
      return this.startRunning(transaction as AppDatabase, current, task, now);
    });
  }

  async respondToReminder(id: string, expectedVersion: number, decision: "start" | "other_arrangement"): Promise<StoredFocusSession> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      const current = await this.requireCurrent(transaction as AppDatabase, id, expectedVersion);
      if (current.state !== "reminded") throw new FocusTransitionError(current.state, "respond to reminder for");
      const [task] = await transaction.select().from(tasks).where(and(eq(tasks.id, current.taskId), isNull(tasks.deletedAt))).limit(1);
      if (!task) throw new FocusNotFoundError();
      if (task.lifecycleStatus !== "open") throw new FocusTransitionError(task.lifecycleStatus, "respond to reminder for");
      if (task.endAt && task.endAt <= now) return this.stopExpiredSession(transaction as AppDatabase, current, now);
      await this.cancelSessionTimerJobs(transaction as AppDatabase, current.id, now);
      await cancelTaskFollowUp(transaction as AppDatabase, task.id, now);
      const futureExactStart = task.scheduleKind === "exact" && task.startAt && task.startAt > now;
      const execution = decision === "start" && !futureExactStart
        ? await this.activeStructure(transaction as AppDatabase, task.id, task.scheduleRevision)
        : null;
      const changes = decision === "start"
        ? {
            state: futureExactStart ? "scheduled" : "preparing",
            preparingEndsAt: futureExactStart ? null : new Date(now.getTime() + 60_000),
            confirmationDeadlineAt: null,
            focusStructureId: execution?.structure.id ?? null,
            focusStructureVersion: execution?.structure.version ?? null,
            focusStructureScheduleRevision: execution?.structure.taskScheduleRevision ?? null,
            currentSegmentPosition: execution ? 0 : null,
            currentSegmentStartedAt: execution?.structure.totalStartAt ?? null,
            currentSegmentElapsedSeconds: 0,
            version: current.version + 1,
            updatedAt: now
          }
        : {
            state: "stopped_for_change",
            endedAt: now,
            stoppedReason: "另有安排",
            confirmationDeadlineAt: null,
            version: current.version + 1,
            updatedAt: now
          };
      const [updated] = await transaction.update(focusSessions).set(changes)
        .where(and(eq(focusSessions.id, id), eq(focusSessions.version, expectedVersion))).returning();
      if (!updated) throw new FocusVersionConflictError(await this.requireCurrent(transaction as AppDatabase, id));
      if (decision === "start") {
        await this.replaceSegmentRuns(transaction as AppDatabase, updated.id, execution, now);
        await transaction.insert(focusTimerJobs).values({
          id: randomUUID(),
          focusSessionId: updated.id,
          kind: updated.state === "scheduled" ? "preparation_start" : "preparation_complete",
          expectedSessionVersion: updated.version,
          dueAt: updated.state === "scheduled" ? updated.plannedStartAt! : updated.preparingEndsAt!,
          status: "pending",
          attempts: 0,
          createdAt: now,
          updatedAt: now
        });
      }
      return updated;
    });
  }

  async end(id: string, expectedVersion: number, reason?: string): Promise<StoredFocusSession> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      const current = await this.requireCurrent(transaction as AppDatabase, id, expectedVersion);
      if (!activeTimerStates.includes(current.state as FocusSessionState)) throw new FocusTransitionError(current.state, "end");
      const raw = elapsedSeconds(current, now);
      await this.finalizeCurrentSegmentRun(transaction as AppDatabase, current, now, false);
      await this.cancelSessionTimerJobs(transaction as AppDatabase, current.id, now);
      const [updated] = await transaction.update(focusSessions).set({
        state: "ended", rawActiveSeconds: raw, activeSinceAt: null, endedAt: now, stoppedReason: reason ?? null,
        version: current.version + 1, updatedAt: now
      }).where(and(eq(focusSessions.id, id), eq(focusSessions.version, expectedVersion))).returning();
      if (!updated) throw new FocusVersionConflictError(await this.requireCurrent(transaction as AppDatabase, id));
      await this.awaitTaskOutcome(transaction as AppDatabase, current.taskId, now, reason);
      return updated;
    });
  }

  async otherArrangement(id: string, expectedVersion: number, reason?: string): Promise<StoredFocusSession> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      const current = await this.requireCurrent(transaction as AppDatabase, id, expectedVersion);
      if (!recoverableStates.includes(current.state as FocusSessionState)) throw new FocusTransitionError(current.state, "change arrangement for");
      await this.cancelSessionTimerJobs(transaction as AppDatabase, current.id, now);
      await cancelTaskFollowUp(transaction as AppDatabase, current.taskId, now);
      const [updated] = await transaction.update(focusSessions).set({
        state: "stopped_for_change", rawActiveSeconds: elapsedSeconds(current, now), activeSinceAt: null, endedAt: now,
        stoppedReason: reason ?? "另有安排", version: current.version + 1, updatedAt: now
      }).where(and(eq(focusSessions.id, id), eq(focusSessions.version, expectedVersion))).returning();
      if (!updated) throw new FocusVersionConflictError(await this.requireCurrent(transaction as AppDatabase, id));
      await this.awaitTaskOutcome(transaction as AppDatabase, current.taskId, now, reason);
      return updated;
    });
  }

  async skipFinalBreak(id: string, expectedVersion: number): Promise<StoredFocusSession> {
    return this.db.transaction(async (transaction) => {
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
      await this.cancelSessionTimerJobs(transaction as AppDatabase, current.id, now);
      const [updated] = await transaction.update(focusSessions).set({
        state: "ended",
        rawActiveSeconds: elapsedSeconds(current, now),
        activeSinceAt: null,
        endedAt: now,
        stoppedReason: "用户跳过最后休息",
        version: current.version + 1,
        updatedAt: now
      }).where(and(eq(focusSessions.id, id), eq(focusSessions.version, expectedVersion))).returning();
      if (!updated) throw new FocusVersionConflictError(await this.requireCurrent(transaction as AppDatabase, id));
      await this.awaitTaskOutcome(transaction as AppDatabase, current.taskId, now, "用户跳过最后休息");
      return updated;
    });
  }

  async evaluate(
    id: string,
    expectedVersion: number,
    outcome: TaskOutcome,
    progressPercent: number,
    satisfaction: FocusSatisfaction,
    note?: string | null
  ): Promise<StoredFocusSession> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      const current = await this.requireCurrent(transaction as AppDatabase, id, expectedVersion);
      if (current.state !== "ended") throw new FocusTransitionError(current.state, "evaluate");
      const [task] = await transaction.select().from(tasks).where(and(eq(tasks.id, current.taskId), isNull(tasks.deletedAt))).limit(1);
      if (!task) throw new FocusNotFoundError();
      if (task.lifecycleStatus !== "awaiting_outcome") throw new FocusTransitionError(task.lifecycleStatus, "record focus outcome for");
      const execution = current.focusStructureId
        ? await this.structureById(transaction as AppDatabase, current.focusStructureId)
        : null;
      const effective = outcome === "partial" || outcome === "complete"
        ? execution && current.startedAt && current.plannedEndAt
          ? calculateEffectiveFocusSeconds({
              structureStartAt: execution.structure.totalStartAt,
              actualStartAt: current.startedAt,
              fixedEndAt: current.plannedEndAt,
              now: current.endedAt ?? now,
              segments: execution.segments.map((segment) => ({
                segmentType: segment.segmentType as "focus" | "break",
                durationMinutes: segment.durationMinutes
              }))
            })
          : current.rawActiveSeconds
        : 0;
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
      return updated;
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
    const execution = current.focusStructureId ? await this.structureById(db, current.focusStructureId) : null;
    const position = execution ? locateFocusSegment({
      structureStartAt: execution.structure.totalStartAt,
      segments: execution.segments,
      now
    }) : null;
    const [updated] = await db.update(focusSessions).set({
      state: "running",
      startedAt: now,
      activeSinceAt: now,
      preparingEndsAt: null,
      version: current.version + 1,
      updatedAt: now
    }).where(and(eq(focusSessions.id, current.id), eq(focusSessions.version, current.version))).returning();
    if (!updated) throw new FocusVersionConflictError(await this.requireCurrent(db, current.id));
    await this.activateTask(db, task, now);
    await cancelTaskFollowUp(db, task.id, now);
    if (!position || !execution) return updated;
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
    const elapsed = calculateSegmentElapsedSeconds({
      actualStartedAt: run.startedAt,
      endedAt,
      plannedDurationSeconds: run.plannedDurationSeconds
    });
    await db.update(focusSessionSegmentRuns).set({
      elapsedSeconds: elapsed,
      completedAt: skipped ? null : endedAt,
      skippedAt: skipped ? endedAt : run.skippedAt,
      updatedAt: endedAt
    }).where(eq(focusSessionSegmentRuns.id, run.id));
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
    if (current.state !== "scheduled" || !current.plannedStartAt || current.plannedStartAt > now) return current;
    const [task] = await db.select().from(tasks).where(and(eq(tasks.id, current.taskId), isNull(tasks.deletedAt))).limit(1);
    if (!task || task.lifecycleStatus !== "open") return current;
    if (task.endAt && task.endAt <= now) return this.stopExpiredSession(db, current, now);
    const execution = await this.activeStructure(db, task.id, task.scheduleRevision);
    await this.cancelSessionTimerJobs(db, current.id, now);
    const [preparing] = await db.update(focusSessions).set({
      state: "preparing",
      preparingEndsAt: new Date(now.getTime() + 60_000),
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
      kind: "preparation_complete",
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
      const [stopped] = await db.update(focusSessions).set({ state: "stopped_no_response", endedAt: now, stoppedReason: "5 分钟未响应", version: current.version + 1, updatedAt: now })
        .where(and(eq(focusSessions.id, current.id), eq(focusSessions.version, current.version))).returning();
      if (stopped) await recordFocusNoResponseOutcome(db, { taskId: current.taskId, focusSessionId: current.id, now, reason: "5 分钟未响应" });
      return stopped ?? current;
    }
    if (current.state !== "preparing" || !current.preparingEndsAt || current.preparingEndsAt > now) return current;
    const [task] = await db.select().from(tasks).where(and(eq(tasks.id, current.taskId), isNull(tasks.deletedAt))).limit(1);
    if (!task || task.lifecycleStatus !== "open") return current;
    if (task.endAt && task.endAt <= now) return this.stopExpiredSession(db, current, now);
    await this.cancelSessionTimerJobs(db, current.id, now);
    return this.startRunning(db, current, task, now);
  }

  private async materializeFixedEnd(db: AppDatabase, current: StoredFocusSession, now: Date): Promise<StoredFocusSession> {
    if (current.state !== "running" || !current.plannedEndAt || current.plannedEndAt > now) return current;
    await this.finalizeCurrentSegmentRun(db, current, current.plannedEndAt, false);
    await this.cancelSessionTimerJobs(db, current.id, now);
    const [ended] = await db.update(focusSessions).set({
      state: "ended", rawActiveSeconds: elapsedSeconds(current, now), activeSinceAt: null,
      endedAt: current.plannedEndAt, version: current.version + 1, updatedAt: now
    }).where(and(eq(focusSessions.id, current.id), eq(focusSessions.version, current.version))).returning();
    if (!ended) return current;
    await this.awaitTaskOutcome(db, current.taskId, now, "固定结束时间到达");
    return ended;
  }

  private async activateTask(db: AppDatabase, task: typeof tasks.$inferSelect, now: Date): Promise<void> {
    const [updated] = await db.update(tasks).set({ lifecycleStatus: "active", version: task.version + 1, updatedAt: now })
      .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version))).returning();
    if (!updated) throw new Error("task_version_conflict");
    await syncTaskStartReminder(db, updated, now);
    await db.insert(taskLifecycleEvents).values({ id: randomUUID(), taskId: task.id, fromStatus: task.lifecycleStatus, toStatus: "active", source: "app" });
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
