import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { focusSessionSegmentRuns, focusSessions, focusStructureSegments, focusStructures, focusTimerJobs, taskFeedback, taskLifecycleEvents, taskOutcomes, tasks } from "@personal-ai/db/schema";
import { calculateEffectiveFocusSeconds, type FocusSatisfaction, type FocusSessionState } from "@personal-ai/domain/focus";
import type { TaskOutcome } from "@personal-ai/domain/task";
import { syncTaskStartReminder } from "./reminder-scheduler.js";

const recoverableStates: FocusSessionState[] = ["reminded", "preparing", "running"];
const currentStates: FocusSessionState[] = [...recoverableStates, "ended", "stopped_no_response", "stopped_for_change"];
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
      const prepared = await this.materializePreparation(transaction as AppDatabase, session, now);
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

      const execution = await this.activeStructure(transaction as AppDatabase, task.id, task.scheduleRevision);

      const [created] = await transaction.insert(focusSessions).values({
        id: randomUUID(), taskId, state: mode === "remind" ? "reminded" : "preparing",
        plannedStartAt: task.startAt, plannedEndAt: task.endAt, remindedAt: mode === "remind" ? now : null,
        preparingEndsAt: mode === "remind" ? null : new Date(now.getTime() + 60_000),
        confirmationDeadlineAt: mode === "remind" ? new Date(now.getTime() + 300_000) : null,
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
        kind: mode === "remind" ? "confirmation_timeout" : "preparation_complete",
        expectedSessionVersion: created.version,
        dueAt: mode === "remind" ? created.confirmationDeadlineAt! : created.preparingEndsAt!,
        status: "pending",
        attempts: 0,
        createdAt: now,
        updatedAt: now
      });
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
      if (task.endAt && task.endAt <= now) {
        const [stopped] = await transaction.update(focusSessions).set({
          state: "stopped_no_response", endedAt: now, stoppedReason: "固定结束时间已过",
          version: current.version + 1, updatedAt: now
        }).where(and(eq(focusSessions.id, id), eq(focusSessions.version, expectedVersion))).returning();
        if (!stopped) throw new FocusVersionConflictError(await this.requireCurrent(transaction as AppDatabase, id));
        return stopped;
      }
      const execution = current.focusStructureId
        ? await this.structureById(transaction as AppDatabase, current.focusStructureId)
        : null;
      const position = execution ? locateSegment(execution.structure.totalStartAt, execution.segments, now) : null;
      const [updated] = await transaction.update(focusSessions).set({ state: "running", startedAt: now, activeSinceAt: now, version: current.version + 1, updatedAt: now })
        .where(and(eq(focusSessions.id, id), eq(focusSessions.version, expectedVersion))).returning();
      if (!updated) throw new FocusVersionConflictError(await this.requireCurrent(transaction as AppDatabase, id));
      await this.activateTask(transaction as AppDatabase, task, now);
      if (position) {
        const [positioned] = await transaction.update(focusSessions).set({
          currentSegmentPosition: position.position,
          currentSegmentStartedAt: position.startedAt,
          currentSegmentElapsedSeconds: position.elapsedSeconds,
          updatedAt: now
        }).where(and(eq(focusSessions.id, id), eq(focusSessions.version, expectedVersion + 1))).returning();
        if (positioned) {
          await transaction.update(focusSessionSegmentRuns).set({ startedAt: now, updatedAt: now })
            .where(and(eq(focusSessionSegmentRuns.focusSessionId, id), eq(focusSessionSegmentRuns.position, position.position)));
          await this.scheduleSegmentTransition(transaction as AppDatabase, positioned, execution!, position.position, now);
          return positioned;
        }
      }
      return updated;
    });
  }

  async respondToReminder(id: string, expectedVersion: number, decision: "start" | "other_arrangement"): Promise<StoredFocusSession> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      const current = await this.requireCurrent(transaction as AppDatabase, id, expectedVersion);
      if (current.state !== "reminded") throw new FocusTransitionError(current.state, "respond to reminder for");
      const changes = decision === "start"
        ? { state: "preparing", preparingEndsAt: new Date(now.getTime() + 60_000), confirmationDeadlineAt: null, version: current.version + 1, updatedAt: now }
        : { state: "stopped_for_change", endedAt: now, stoppedReason: "另有安排", version: current.version + 1, updatedAt: now };
      const [updated] = await transaction.update(focusSessions).set(changes)
        .where(and(eq(focusSessions.id, id), eq(focusSessions.version, expectedVersion))).returning();
      if (!updated) throw new FocusVersionConflictError(await this.requireCurrent(transaction as AppDatabase, id));
      if (decision === "start") {
        await transaction.insert(focusTimerJobs).values({
          id: randomUUID(),
          focusSessionId: updated.id,
          kind: "preparation_complete",
          expectedSessionVersion: updated.version,
          dueAt: updated.preparingEndsAt!,
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
      const [updated] = await transaction.update(focusSessions).set({
        state: "stopped_for_change", rawActiveSeconds: elapsedSeconds(current, now), activeSinceAt: null, endedAt: now,
        stoppedReason: reason ?? "另有安排", version: current.version + 1, updatedAt: now
      }).where(and(eq(focusSessions.id, id), eq(focusSessions.version, expectedVersion))).returning();
      if (!updated) throw new FocusVersionConflictError(await this.requireCurrent(transaction as AppDatabase, id));
      await this.awaitTaskOutcome(transaction as AppDatabase, current.taskId, now, reason);
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
    const dueAt = segmentEndAt(execution.structure.totalStartAt, execution.segments, position);
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

  private async materializePreparation(db: AppDatabase, current: StoredFocusSession, now: Date): Promise<StoredFocusSession> {
    if (current.state === "reminded" && current.remindedAt && now.getTime() - current.remindedAt.getTime() >= 300_000) {
      const [stopped] = await db.update(focusSessions).set({ state: "stopped_no_response", endedAt: now, stoppedReason: "5 分钟未响应", version: current.version + 1, updatedAt: now })
        .where(and(eq(focusSessions.id, current.id), eq(focusSessions.version, current.version))).returning();
      if (stopped) await this.awaitTaskOutcome(db, current.taskId, now, "5 分钟未响应");
      return stopped ?? current;
    }
    if (current.state !== "preparing" || !current.preparingEndsAt || current.preparingEndsAt > now) return current;
    const [task] = await db.select().from(tasks).where(and(eq(tasks.id, current.taskId), isNull(tasks.deletedAt))).limit(1);
    if (!task || task.lifecycleStatus !== "open") return current;
    if (task.endAt && task.endAt <= now) {
      const [stopped] = await db.update(focusSessions).set({
        state: "stopped_no_response", endedAt: now, stoppedReason: "固定结束时间已过",
        version: current.version + 1, updatedAt: now
      }).where(and(eq(focusSessions.id, current.id), eq(focusSessions.version, current.version))).returning();
      return stopped ?? current;
    }
    const [updated] = await db.update(focusSessions).set({ state: "running", startedAt: now, activeSinceAt: now, version: current.version + 1, updatedAt: now })
      .where(and(eq(focusSessions.id, current.id), eq(focusSessions.version, current.version))).returning();
    if (!updated) return current;
    await this.activateTask(db, task, now);
    if (updated.focusStructureId) {
      const execution = await this.structureById(db, updated.focusStructureId);
      const position = execution ? locateSegment(execution.structure.totalStartAt, execution.segments, now) : null;
      if (position) {
        const [positioned] = await db.update(focusSessions).set({
          currentSegmentPosition: position.position,
          currentSegmentStartedAt: position.startedAt,
          currentSegmentElapsedSeconds: position.elapsedSeconds,
          updatedAt: now
        }).where(and(eq(focusSessions.id, updated.id), eq(focusSessions.version, updated.version))).returning();
        if (positioned) {
          await db.update(focusSessionSegmentRuns).set({ startedAt: now, updatedAt: now })
            .where(and(eq(focusSessionSegmentRuns.focusSessionId, updated.id), eq(focusSessionSegmentRuns.position, position.position)));
          await this.scheduleSegmentTransition(db, positioned, execution!, position.position, now);
          return positioned;
        }
      }
    }
    return updated;
  }

  private async materializeFixedEnd(db: AppDatabase, current: StoredFocusSession, now: Date): Promise<StoredFocusSession> {
    if (current.state !== "running" || !current.plannedEndAt || current.plannedEndAt > now) return current;
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

function locateSegment(
  structureStartAt: Date,
  segments: Array<{ segmentType: string; durationMinutes: number }>,
  now: Date
): { position: number; startedAt: Date; elapsedSeconds: number } | null {
  let cursor = structureStartAt.getTime();
  for (let position = 0; position < segments.length; position += 1) {
    const end = cursor + segments[position]!.durationMinutes * 60_000;
    if (now.getTime() < end) {
      return {
        position,
        startedAt: new Date(cursor),
        elapsedSeconds: Math.max(0, Math.floor((now.getTime() - cursor) / 1000))
      };
    }
    cursor = end;
  }
  return null;
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
