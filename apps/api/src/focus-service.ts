import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { focusSessions, taskFeedback, taskLifecycleEvents, taskOutcomes, tasks } from "@personal-ai/db/schema";
import type { FocusSatisfaction, FocusSessionState } from "@personal-ai/domain/focus";
import type { TaskOutcome } from "@personal-ai/domain/task";

const recoverableStates: FocusSessionState[] = ["reminded", "preparing", "running", "paused"];
const currentStates: FocusSessionState[] = [...recoverableStates, "ended", "stopped_no_response", "stopped_for_change"];
const activeTimerStates: FocusSessionState[] = ["running", "paused"];

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
      return this.materializePreparation(transaction as AppDatabase, session, new Date());
    });
  }

  async create(taskId: string, expectedTaskVersion: number, mode: "remind" | "prepare" | "restart"): Promise<StoredFocusSession> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      const [task] = await transaction.select().from(tasks).where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt))).limit(1);
      if (!task) throw new FocusNotFoundError();
      if (task.version !== expectedTaskVersion) throw new Error("task_version_conflict");
      if (task.lifecycleStatus !== "open" && !(mode === "restart" && task.lifecycleStatus === "awaiting_outcome")) {
        throw new FocusTransitionError(task.lifecycleStatus, "start focus for");
      }
      const [existing] = await transaction.select({ id: focusSessions.id }).from(focusSessions)
        .where(inArray(focusSessions.state, recoverableStates)).limit(1);
      if (existing) throw new FocusBusyError();

      const startsNow = mode === "restart";
      const reminds = mode === "remind";
      const [created] = await transaction.insert(focusSessions).values({
        id: randomUUID(), taskId, state: startsNow ? "running" : reminds ? "reminded" : "preparing",
        plannedStartAt: task.startAt, remindedAt: reminds ? now : null,
        preparingEndsAt: startsNow || reminds ? null : new Date(now.getTime() + 60_000),
        startedAt: startsNow ? now : null, activeSinceAt: startsNow ? now : null,
        rawActiveSeconds: 0, effectiveFocusSeconds: 0, version: 1
      }).returning();
      if (!created) throw new Error("PostgreSQL did not return focus session.");
      if (startsNow) await this.activateTask(transaction as AppDatabase, task, now);
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
      const [updated] = await transaction.update(focusSessions).set({ state: "running", startedAt: now, activeSinceAt: now, version: current.version + 1, updatedAt: now })
        .where(and(eq(focusSessions.id, id), eq(focusSessions.version, expectedVersion))).returning();
      if (!updated) throw new FocusVersionConflictError(await this.requireCurrent(transaction as AppDatabase, id));
      await this.activateTask(transaction as AppDatabase, task, now);
      return updated;
    });
  }

  async respondToReminder(id: string, expectedVersion: number, decision: "start" | "other_arrangement"): Promise<StoredFocusSession> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      const current = await this.requireCurrent(transaction as AppDatabase, id, expectedVersion);
      if (current.state !== "reminded") throw new FocusTransitionError(current.state, "respond to reminder for");
      const changes = decision === "start"
        ? { state: "preparing", preparingEndsAt: new Date(now.getTime() + 60_000), version: current.version + 1, updatedAt: now }
        : { state: "stopped_for_change", endedAt: now, stoppedReason: "另有安排", version: current.version + 1, updatedAt: now };
      const [updated] = await transaction.update(focusSessions).set(changes)
        .where(and(eq(focusSessions.id, id), eq(focusSessions.version, expectedVersion))).returning();
      if (!updated) throw new FocusVersionConflictError(await this.requireCurrent(transaction as AppDatabase, id));
      return updated;
    });
  }

  async pause(id: string, expectedVersion: number): Promise<StoredFocusSession> {
    return this.updateTimer(id, expectedVersion, "pause", (current, now, raw) => ({
      state: "paused", rawActiveSeconds: raw, activeSinceAt: null, pausedAt: now
    }));
  }

  async resume(id: string, expectedVersion: number): Promise<StoredFocusSession> {
    return this.updateTimer(id, expectedVersion, "resume", (current, now) => ({
      state: "running", activeSinceAt: now, pausedAt: null
    }));
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
      const effective = outcome === "partial" || outcome === "complete" ? current.rawActiveSeconds : 0;
      const [updated] = await transaction.update(focusSessions).set({ state: "evaluated", effectiveFocusSeconds: effective, version: current.version + 1, updatedAt: now })
        .where(and(eq(focusSessions.id, id), eq(focusSessions.version, expectedVersion))).returning();
      if (!updated) throw new FocusVersionConflictError(await this.requireCurrent(transaction as AppDatabase, id));
      await transaction.insert(taskFeedback).values({ id: randomUUID(), taskId: task.id, focusSessionId: id, satisfaction, note: note ?? null });
      await transaction.insert(taskOutcomes).values({ id: randomUUID(), taskId: task.id, focusSessionId: id, outcome, progressPercent, source: "app", note: note ?? null });
      const [closed] = await transaction.update(tasks).set({ lifecycleStatus: "closed", currentOutcome: outcome, version: task.version + 1, scheduleRevision: task.scheduleRevision + 1, updatedAt: now })
        .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version))).returning();
      if (!closed) throw new Error("task_version_conflict");
      await transaction.insert(taskLifecycleEvents).values({ id: randomUUID(), taskId: task.id, fromStatus: "awaiting_outcome", toStatus: "closed", source: "app", reason: note ?? null });
      return updated;
    });
  }

  private async updateTimer(
    id: string, expectedVersion: number, operation: "pause" | "resume",
    changes: (current: StoredFocusSession, now: Date, raw: number) => Record<string, unknown>
  ): Promise<StoredFocusSession> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      const current = await this.requireCurrent(transaction as AppDatabase, id, expectedVersion);
      const valid = operation === "pause" ? current.state === "running" : current.state === "paused";
      if (!valid) throw new FocusTransitionError(current.state, operation);
      const [updated] = await transaction.update(focusSessions).set({ ...changes(current, now, elapsedSeconds(current, now)), version: current.version + 1, updatedAt: now })
        .where(and(eq(focusSessions.id, id), eq(focusSessions.version, expectedVersion))).returning();
      if (!updated) throw new FocusVersionConflictError(await this.requireCurrent(transaction as AppDatabase, id));
      return updated;
    });
  }

  private async requireCurrent(db: AppDatabase, id: string, expectedVersion?: number): Promise<StoredFocusSession> {
    const [current] = await db.select().from(focusSessions).where(eq(focusSessions.id, id)).limit(1);
    if (!current) throw new FocusNotFoundError();
    if (expectedVersion !== undefined && current.version !== expectedVersion) throw new FocusVersionConflictError(current);
    return current;
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
    const [updated] = await db.update(focusSessions).set({ state: "running", startedAt: now, activeSinceAt: now, version: current.version + 1, updatedAt: now })
      .where(and(eq(focusSessions.id, current.id), eq(focusSessions.version, current.version))).returning();
    if (!updated) return current;
    await this.activateTask(db, task, now);
    return updated;
  }

  private async activateTask(db: AppDatabase, task: typeof tasks.$inferSelect, now: Date): Promise<void> {
    const [updated] = await db.update(tasks).set({ lifecycleStatus: "active", version: task.version + 1, updatedAt: now })
      .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version))).returning();
    if (!updated) throw new Error("task_version_conflict");
    await db.insert(taskLifecycleEvents).values({ id: randomUUID(), taskId: task.id, fromStatus: task.lifecycleStatus, toStatus: "active", source: "app" });
  }

  private async awaitTaskOutcome(db: AppDatabase, taskId: string, now: Date, reason?: string): Promise<void> {
    const [task] = await db.select().from(tasks).where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt))).limit(1);
    if (!task || task.lifecycleStatus !== "active") return;
    const [updated] = await db.update(tasks).set({ lifecycleStatus: "awaiting_outcome", version: task.version + 1, updatedAt: now })
      .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version))).returning();
    if (!updated) throw new Error("task_version_conflict");
    await db.insert(taskLifecycleEvents).values({ id: randomUUID(), taskId: task.id, fromStatus: "active", toStatus: "awaiting_outcome", source: "app", reason: reason ?? null });
  }
}

export function elapsedSeconds(session: StoredFocusSession, now = new Date()): number {
  if (session.state !== "running" || !session.activeSinceAt) return session.rawActiveSeconds;
  return session.rawActiveSeconds + Math.max(0, Math.floor((now.getTime() - session.activeSinceAt.getTime()) / 1000));
}
