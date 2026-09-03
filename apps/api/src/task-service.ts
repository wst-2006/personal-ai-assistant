import {
  isWithinProductScheduleWindow,
  localDateAtTimeZone,
  PRODUCT_SCHEDULE_END_MINUTE,
  PRODUCT_SCHEDULE_START_MINUTE,
  taskInputSchema,
  type TaskBackfillInput,
  type TaskEventSource,
  type TaskInput,
  type TaskLifecycle,
  type TaskOutcome,
  type TaskSatisfaction,
  type TaskPatch
} from "@personal-ai/domain/task";
import { createHash, randomUUID } from "node:crypto";
import type {
  ConflictAcceptanceRecord,
  NewTaskRecord,
  StoredInboxEntry,
  StoredTask,
  StoredTaskFeedback,
  StoredTaskOutcome,
  TaskStore,
  TaskStoreTransaction
} from "./task-repository.js";

const blockingStatuses: TaskLifecycle[] = ["open", "active", "awaiting_outcome"];

export type TaskConflict = {
  taskId: string;
  title: string;
  startAt: Date;
  endAt: Date;
  lifecycleStatus: TaskLifecycle;
  scheduleRevision: number;
  accepted: boolean;
};

export type TaskConflictPair = {
  taskIdA: string;
  taskIdB: string;
  accepted: boolean;
};

export type TaskListResult = {
  tasks: StoredTask[];
  blockingConflicts: TaskConflictPair[];
  historicalOverlaps: TaskConflictPair[];
};

export type BulkShiftAdjustment = {
  taskId: string;
  title: string;
  expectedVersion: number;
  expectedScheduleRevision: number;
  currentStartAt: string;
  currentEndAt: string;
  nextStartAt: string;
  nextEndAt: string;
};

export type BulkShiftPreview = {
  localDate: string | null;
  offsetMinutes: number;
  adjustments: BulkShiftAdjustment[];
  skipped: Array<{ taskId: string; title: string; reason: string }>;
};

export class BulkShiftValidationError extends Error {
  constructor(readonly skipped: Array<{ taskId: string; title: string; reason: string }>) {
    super("Bulk task shift cannot be applied.");
  }
}

export class TaskNotFoundError extends Error {}

export class TaskVersionConflictError extends Error {
  constructor(readonly currentTask: StoredTask) {
    super("Task version does not match the current database record.");
  }
}

export class TaskScheduleRevisionConflictError extends Error {
  constructor(readonly currentTask: StoredTask) {
    super("Task schedule revision does not match the current database record.");
  }
}

export class InboxEntryConflictError extends Error {
  constructor(readonly currentEntry: StoredInboxEntry | null) {
    super("Inbox entry is missing, stale, or already converted.");
  }
}

export class InvalidTaskTransitionError extends Error {
  constructor(readonly currentStatus: string, readonly operation: string) {
    super(`Cannot ${operation} a task in ${currentStatus} state.`);
  }
}

export class TaskTimeConflictError extends Error {
  constructor(readonly conflicts: TaskConflict[], readonly conflictSetFingerprint: string) {
    super("Exact task time overlaps another blocking task.");
  }
}

export class TaskScheduleWindowError extends Error {
  constructor(readonly earliestStartAt: Date) {
    super("Today's current half-hour window is no longer available for scheduling.");
  }
}

export class TaskBackfillWindowError extends Error {
  constructor(readonly latestEndAt: Date) {
    super("A same-day backfill must stay within the elapsed/current half-hour window.");
  }
}

export class TaskScheduleBoundsError extends Error {
  constructor(
    readonly minimumMinute = PRODUCT_SCHEDULE_START_MINUTE,
    readonly maximumMinute = PRODUCT_SCHEDULE_END_MINUTE
  ) {
    super("Exact tasks must stay within the 07:00-23:00 scheduling window.");
  }
}

export class ConflictSetChangedError extends Error {
  constructor(readonly conflicts: TaskConflict[], readonly conflictSetFingerprint: string) {
    super("The blocking conflict set changed before confirmation.");
  }
}

export class TaskService {
  constructor(private readonly store: TaskStore) {}

  async create(input: TaskInput): Promise<{ task: StoredTask; historicalOverlaps: TaskConflict[] }> {
    return this.createWithId(input, randomUUID(), "app");
  }

  async createBackfill(input: TaskBackfillInput): Promise<{ task: StoredTask; historicalOverlaps: TaskConflict[] }> {
    return this.store.runSerializable(async (transaction) => {
      const record: NewTaskRecord = { ...toNewTaskRecord(input), recordKind: "backfill", lifecycleStatus: "awaiting_outcome" };
      assertProductScheduleBounds(record);
      assertBackfillWindow(record);
      const task = await transaction.insertTask(record);
      await transaction.insertLifecycleEvent({
        id: randomUUID(),
        taskId: task.id,
        fromStatus: null,
        toStatus: "awaiting_outcome",
        source: "app",
        reason: "same-day task backfill"
      });
      return { task, historicalOverlaps: [] };
    });
  }

  async createFromFeishu(input: TaskInput, taskId: string): Promise<{ task: StoredTask; historicalOverlaps: TaskConflict[] }> {
    return this.createWithId(input, taskId, "feishu");
  }

  private async createWithId(
    input: TaskInput,
    taskId: string,
    source: TaskEventSource
  ): Promise<{ task: StoredTask; historicalOverlaps: TaskConflict[] }> {
    return this.store.runSerializable(async (transaction) => {
      const record = toNewTaskRecord(input, taskId as NewTaskRecord["id"]);
      assertProductScheduleBounds(record);
      assertScheduleWindow(record);
      const blocking = await this.findConflicts(transaction, record);
      await this.assertConflictDecision(transaction, record, blocking, input.conflictDecision, input.expectedConflictFingerprint);
      const task = await transaction.insertTask(record);
      await transaction.syncReminderForTask(task);
      await transaction.insertLifecycleEvent({
        id: randomUUID(),
        taskId: task.id,
        fromStatus: null,
        toStatus: "open",
        source
      });
      if (input.conflictDecision === "keep") {
        await transaction.insertConflictAcceptances(blocking.map((conflict) => canonicalAcceptance(task, conflict)));
      }
      const historicalOverlaps = await this.findHistoricalOverlaps(transaction, task);
      return { task, historicalOverlaps };
    });
  }

  listInbox(): Promise<StoredInboxEntry[]> {
    return this.store.listInboxEntries();
  }

  async createInbox(entryKind: "idea" | "question", content: string, notes?: string | null): Promise<StoredInboxEntry> {
    return this.createInboxWithId(entryKind, content, notes, randomUUID());
  }

  async createInboxFromFeishu(
    entryKind: "idea" | "question",
    content: string,
    notes: string | null | undefined,
    inboxEntryId: string
  ): Promise<StoredInboxEntry> {
    return this.createInboxWithId(entryKind, content, notes, inboxEntryId);
  }

  private async createInboxWithId(
    entryKind: "idea" | "question",
    content: string,
    notes: string | null | undefined,
    inboxEntryId: string
  ): Promise<StoredInboxEntry> {
    return this.store.runSerializable((transaction) => transaction.insertInboxEntry({
      id: inboxEntryId, entryKind, content, notes: notes ?? null, version: 1
    }));
  }

  async convertInbox(id: string, expectedVersion: number, input: TaskInput): Promise<{
    entry: StoredInboxEntry;
    task: StoredTask;
    historicalOverlaps: TaskConflict[];
  }> {
    return this.store.runSerializable(async (transaction) => {
      const source = await transaction.getInboxEntry(id);
      if (!source || source.version !== expectedVersion || source.convertedAt) throw new InboxEntryConflictError(source);
      const record = { ...toNewTaskRecord(input), sourceInboxEntryId: id };
      assertProductScheduleBounds(record);
      assertScheduleWindow(record);
      const blocking = await this.findConflicts(transaction, record);
      await this.assertConflictDecision(transaction, record, blocking, input.conflictDecision, input.expectedConflictFingerprint);
      const task = await transaction.insertTask(record);
      await transaction.syncReminderForTask(task);
      await transaction.insertLifecycleEvent({ id: randomUUID(), taskId: task.id, fromStatus: null, toStatus: "open", source: "app" });
      if (input.conflictDecision === "keep") {
        await transaction.insertConflictAcceptances(blocking.map((conflict) => canonicalAcceptance(task, conflict)));
      }
      const entry = await transaction.markInboxConverted(id, expectedVersion, new Date());
      if (!entry) throw new InboxEntryConflictError(await transaction.getInboxEntry(id));
      return { entry, task, historicalOverlaps: await this.findHistoricalOverlaps(transaction, task) };
    });
  }

  async list(localDate?: string): Promise<TaskListResult> {
    const listedTasks = await this.store.listTasks(localDate);
    const blockingConflicts: TaskConflictPair[] = [];
    const historicalOverlaps: TaskConflictPair[] = [];

    for (let leftIndex = 0; leftIndex < listedTasks.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < listedTasks.length; rightIndex += 1) {
        const left = listedTasks[leftIndex]!;
        const right = listedTasks[rightIndex]!;
        if (left.recordKind !== "formal" || right.recordKind !== "formal" || !exactlyOverlaps(left, right)) continue;
        if (left.lifecycleStatus === "cancelled" || right.lifecycleStatus === "cancelled") continue;
        if (left.lifecycleStatus === "closed" || right.lifecycleStatus === "closed") {
          historicalOverlaps.push({ taskIdA: left.id, taskIdB: right.id, accepted: false });
          continue;
        }
        if (!isBlocking(left.lifecycleStatus) || !isBlocking(right.lifecycleStatus)) continue;
        const accepted = await this.store.isConflictAccepted(canonicalAcceptance(left, right));
        blockingConflicts.push({ taskIdA: left.id, taskIdB: right.id, accepted });
      }
    }

    return { tasks: listedTasks, blockingConflicts, historicalOverlaps };
  }

  async previewBulkShift(localDate: string | null, offsetMinutes: number): Promise<BulkShiftPreview> {
    const tasks = (await this.store.listTasks(localDate ?? undefined)).filter((task) => task.recordKind === "formal");
    const adjustments: BulkShiftAdjustment[] = [];
    const skipped: BulkShiftPreview["skipped"] = [];
    for (const task of tasks) {
      if (task.lifecycleStatus !== "open") {
        skipped.push({ taskId: task.id, title: task.title, reason: "任务已开始、等待结果或已结束，不能批量移动" });
        continue;
      }
      if (task.scheduleKind !== "exact" || !task.startAt || !task.endAt) {
        skipped.push({ taskId: task.id, title: task.title, reason: "未设置精确起止时间" });
        continue;
      }
      const nextStart = new Date(task.startAt.getTime() + offsetMinutes * 60_000);
      const nextEnd = new Date(task.endAt.getTime() + offsetMinutes * 60_000);
      try {
        assertProductScheduleBounds({ scheduleKind: "exact", startAt: nextStart, endAt: nextEnd, timeZone: task.timeZone });
        assertScheduleWindow({ scheduleKind: "exact", startAt: nextStart, endAt: nextEnd, timeZone: task.timeZone });
        if (localDateAtTimeZone(nextStart, task.timeZone) !== localDateAtTimeZone(task.startAt, task.timeZone)
          || localDateAtTimeZone(nextEnd, task.timeZone) !== localDateAtTimeZone(task.endAt, task.timeZone)) throw new TaskScheduleBoundsError();
      } catch (error) {
        skipped.push({ taskId: task.id, title: task.title, reason: error instanceof TaskScheduleBoundsError ? "顺延后超出当天 07:00–23:00 可排时段" : "顺延后的时间无效" });
        continue;
      }
      adjustments.push({
        taskId: task.id,
        title: task.title,
        expectedVersion: task.version,
        expectedScheduleRevision: task.scheduleRevision,
        currentStartAt: task.startAt.toISOString(),
        currentEndAt: task.endAt.toISOString(),
        nextStartAt: nextStart.toISOString(),
        nextEndAt: nextEnd.toISOString()
      });
    }
    return { localDate, offsetMinutes, adjustments, skipped };
  }

  async bulkShift(localDate: string | null, offsetMinutes: number, expected: Array<Pick<BulkShiftAdjustment, "taskId" | "expectedVersion" | "expectedScheduleRevision">>): Promise<{ tasks: StoredTask[] }> {
    if (!Number.isInteger(offsetMinutes) || offsetMinutes === 0 || offsetMinutes % 30 !== 0 || Math.abs(offsetMinutes) > 12 * 60) {
      throw new BulkShiftValidationError([]);
    }
    return this.store.runSerializable(async (transaction) => {
      const ids = new Set(expected.map((item) => item.taskId));
      const targets: Array<{ current: StoredTask; nextStart: Date; nextEnd: Date }> = [];
      const skipped: BulkShiftPreview["skipped"] = [];
      for (const item of expected) {
        const current = await transaction.getTask(item.taskId);
        if (!current || current.version !== item.expectedVersion || current.scheduleRevision !== item.expectedScheduleRevision) {
          throw current ? new TaskVersionConflictError(current) : new TaskNotFoundError("Task not found.");
        }
        if (current.lifecycleStatus !== "open" || current.recordKind !== "formal" || current.scheduleKind !== "exact" || !current.startAt || !current.endAt) {
          skipped.push({ taskId: current.id, title: current.title, reason: "任务当前不能批量移动" });
          continue;
        }
        if (localDate !== null && current.localDate !== localDate) {
          skipped.push({ taskId: current.id, title: current.title, reason: "任务不属于已确认的作用日期" });
          continue;
        }
        const nextStart = new Date(current.startAt.getTime() + offsetMinutes * 60_000);
        const nextEnd = new Date(current.endAt.getTime() + offsetMinutes * 60_000);
        if (localDateAtTimeZone(nextStart, current.timeZone) !== localDateAtTimeZone(current.startAt, current.timeZone)
          || localDateAtTimeZone(nextEnd, current.timeZone) !== localDateAtTimeZone(current.endAt, current.timeZone)) {
          skipped.push({ taskId: current.id, title: current.title, reason: "顺延后超出当天可排时段" });
          continue;
        }
        assertProductScheduleBounds({ scheduleKind: "exact", startAt: nextStart, endAt: nextEnd, timeZone: current.timeZone });
        assertScheduleWindow({ scheduleKind: "exact", startAt: nextStart, endAt: nextEnd, timeZone: current.timeZone });
        targets.push({ current, nextStart, nextEnd });
      }
      if (skipped.length > 0) throw new BulkShiftValidationError(skipped);
      const conflicts: TaskConflict[] = [];
      for (const target of targets) {
        const overlaps = await transaction.listExactOverlaps(target.nextStart, target.nextEnd, blockingStatuses, target.current.id);
        for (const overlap of overlaps) {
          if (!ids.has(overlap.id)) conflicts.push(toConflict(overlap));
        }
      }
      if (conflicts.length > 0) throw new TaskTimeConflictError(conflicts, conflictFingerprint(conflicts.map((item) => ({ id: item.taskId, scheduleRevision: item.scheduleRevision }))));
      const updated: StoredTask[] = [];
      for (const target of targets) {
        const task = await transaction.updateTask(target.current.id, target.current.version, {
          startAt: target.nextStart,
          endAt: target.nextEnd,
          localDate: localDateAtTimeZone(target.nextStart, target.current.timeZone),
          version: target.current.version + 1,
          scheduleRevision: target.current.scheduleRevision + 1,
          updatedAt: new Date()
        });
        if (!task) throw await this.versionOrMissing(transaction, target.current.id);
        await transaction.invalidateFocusStructures(task.id, task.scheduleRevision, "bulk plan shift");
        await transaction.syncReminderForTask(task);
        updated.push(task);
      }
      return { tasks: updated };
    });
  }

  listDeleted(localDate?: string): Promise<StoredTask[]> {
    return this.store.listDeletedTasks(localDate);
  }

  async get(id: string): Promise<{
    task: StoredTask;
    outcomes: StoredTaskOutcome[];
    feedback: StoredTaskFeedback[];
    blockingConflicts: TaskConflict[];
    historicalOverlaps: TaskConflict[];
  }> {
    const task = await this.store.getTask(id);
    if (!task) throw new TaskNotFoundError("Task not found.");
    const outcomes = await this.store.listOutcomes(id);
    const feedback = await this.store.listFeedback(id);
    const blocking = task.scheduleKind === "exact" && task.startAt && task.endAt && isBlocking(task.lifecycleStatus)
      ? await this.store.listExactOverlaps(task.startAt, task.endAt, blockingStatuses, task.id)
      : [];
    const blockingConflicts = await Promise.all(blocking.map(async (other) => ({
      ...toConflict(other),
      accepted: await this.store.isConflictAccepted(canonicalAcceptance(task, other))
    })));
    const historical = task.scheduleKind === "exact" && task.startAt && task.endAt
      ? await this.store.listExactOverlaps(task.startAt, task.endAt, ["closed"], task.id)
      : [];
    return { task, outcomes, feedback, blockingConflicts, historicalOverlaps: historical.map(toConflict) };
  }

  async update(id: string, patch: TaskPatch): Promise<{ task: StoredTask; historicalOverlaps: TaskConflict[] }> {
    return this.store.runSerializable(async (transaction) => {
      const current = await this.requireCurrentVersion(transaction, id, patch.expectedVersion);
      if (hasSchedulePatchField(patch) && patch.expectedScheduleRevision !== current.scheduleRevision) {
        throw new TaskScheduleRevisionConflictError(current);
      }
      this.assertEditable(current, patch);
      const normalized = mergeAndValidate(current, patch);
      if (hasSchedulePatchField(patch)) {
        assertProductScheduleBounds(normalized);
        assertScheduleWindow(normalized);
      }
      const scheduleChanged = hasScheduleSemanticChange(current, normalized);
      const target: NewTaskRecord = {
        ...normalized,
        id: current.id,
        recordKind: current.recordKind as "formal" | "backfill",
        lifecycleStatus: current.lifecycleStatus as TaskLifecycle,
        currentOutcome: current.currentOutcome as TaskOutcome | null,
        version: current.version + 1,
        scheduleRevision: current.scheduleRevision + (scheduleChanged ? 1 : 0)
      };
      const blocking = await this.findConflicts(transaction, target, current.id);
      await this.assertConflictDecision(transaction, target, blocking, patch.conflictDecision, patch.expectedConflictFingerprint);
      const updated = await transaction.updateTask(id, patch.expectedVersion, {
        ...toTaskUpdateRecord(target),
        updatedAt: new Date()
      });
      if (!updated) throw await this.versionOrMissing(transaction, id);
      if (scheduleChanged) {
        await transaction.invalidateFocusStructures(updated.id, updated.scheduleRevision, "task schedule changed");
      }
      await transaction.syncReminderForTask(updated);
      if (patch.conflictDecision === "keep") {
        await transaction.insertConflictAcceptances(blocking.map((conflict) => canonicalAcceptance(updated, conflict)));
      }
      return { task: updated, historicalOverlaps: await this.findHistoricalOverlaps(transaction, updated) };
    });
  }

  async cancel(id: string, expectedVersion: number, reason?: string): Promise<StoredTask> {
    return this.transition(id, expectedVersion, "cancelled", "app", reason, ["open"], true);
  }

  async cancelAndTrash(id: string, expectedVersion: number, reason?: string): Promise<StoredTask> {
    return this.store.runSerializable(async (transaction) => {
      const current = await this.requireCurrentVersion(transaction, id, expectedVersion);
      if (current.lifecycleStatus !== "open") {
        throw new InvalidTaskTransitionError(current.lifecycleStatus, "cancel and trash");
      }
      const now = new Date();
      const updated = await transaction.updateTask(id, expectedVersion, {
        lifecycleStatus: "cancelled",
        deletedAt: now,
        version: current.version + 1,
        scheduleRevision: current.scheduleRevision + 1,
        updatedAt: now
      });
      if (!updated) throw await this.versionOrMissing(transaction, id);
      await transaction.invalidateFocusStructures(updated.id, updated.scheduleRevision, "task cancelled and moved to trash");
      await transaction.syncReminderForTask(updated);
      await transaction.insertLifecycleEvent({
        id: randomUUID(), taskId: id, fromStatus: "open", toStatus: "cancelled", source: "app", reason
      });
      await transaction.insertLifecycleEvent({
        id: randomUUID(), taskId: id, fromStatus: "cancelled", toStatus: "deleted", source: "app", reason: reason ?? "cancelled task moved to trash"
      });
      return updated;
    });
  }

  async start(id: string, expectedVersion: number, source: TaskEventSource = "app"): Promise<StoredTask> {
    return this.transition(id, expectedVersion, "active", source, undefined, ["open"], false);
  }

  async awaitOutcome(
    id: string,
    expectedVersion: number,
    source: TaskEventSource = "app",
    reason?: string
  ): Promise<StoredTask> {
    return this.transition(id, expectedVersion, "awaiting_outcome", source, reason, ["active"], false);
  }

  async softDelete(id: string, expectedVersion: number, reason?: string): Promise<void> {
    await this.store.runSerializable(async (transaction) => {
      const current = await this.requireCurrentVersion(transaction, id, expectedVersion);
      if (current.lifecycleStatus === "active") throw new InvalidTaskTransitionError("active", "delete");
      const updated = await transaction.updateTask(id, expectedVersion, {
        deletedAt: new Date(),
        version: current.version + 1,
        scheduleRevision: current.scheduleRevision + 1,
        updatedAt: new Date()
      });
      if (!updated) throw await this.versionOrMissing(transaction, id);
      await transaction.invalidateFocusStructures(updated.id, updated.scheduleRevision, "task soft-deleted");
      await transaction.syncReminderForTask(updated);
      await transaction.insertLifecycleEvent({
        id: randomUUID(), taskId: id, fromStatus: current.lifecycleStatus as TaskLifecycle,
        toStatus: "deleted", source: "app", reason
      });
    });
  }

  async emptyTrash(): Promise<{ purgedCount: number }> {
    const purgedCount = await this.store.runSerializable((transaction) => transaction.purgeDeletedTasks());
    return { purgedCount };
  }

  async restore(
    id: string,
    expectedVersion: number,
    conflictDecision: "reject" | "keep",
    expectedConflictFingerprint?: string,
    reason?: string
  ): Promise<{ task: StoredTask; historicalOverlaps: TaskConflict[] }> {
    return this.store.runSerializable(async (transaction) => {
      const current = await transaction.getTask(id, true);
      if (!current) throw new TaskNotFoundError("Task not found.");
      if (!current.deletedAt) throw new InvalidTaskTransitionError(current.lifecycleStatus, "restore");
      if (current.version !== expectedVersion) throw new TaskVersionConflictError(current);
      const target = {
        ...current,
        deletedAt: null,
        version: current.version + 1,
        scheduleRevision: current.scheduleRevision + 1
      };
      const blocking = await this.findConflicts(transaction, target, id);
      await this.assertConflictDecision(
        transaction,
        target,
        blocking,
        conflictDecision,
        expectedConflictFingerprint
      );
      const updated = await transaction.restoreDeletedTask(id, expectedVersion, {
        deletedAt: null,
        version: target.version,
        scheduleRevision: target.scheduleRevision,
        updatedAt: new Date()
      });
      if (!updated) throw await this.versionOrMissing(transaction, id, true);
      await transaction.invalidateFocusStructures(updated.id, updated.scheduleRevision, "task restored");
      await transaction.syncReminderForTask(updated);
      await transaction.insertLifecycleEvent({
        id: randomUUID(),
        taskId: id,
        fromStatus: current.lifecycleStatus as TaskLifecycle,
        toStatus: current.lifecycleStatus as TaskLifecycle,
        source: "app",
        reason: reason ?? "restored from trash"
      });
      if (conflictDecision === "keep") {
        await transaction.insertConflictAcceptances(
          blocking.map((conflict) => canonicalAcceptance(updated, conflict))
        );
      }
      return { task: updated, historicalOverlaps: await this.findHistoricalOverlaps(transaction, updated) };
    });
  }

  async reopen(
    id: string,
    expectedVersion: number,
    conflictDecision: "reject" | "keep",
    expectedConflictFingerprint?: string,
    reason?: string
  ): Promise<{ task: StoredTask; historicalOverlaps: TaskConflict[] }> {
    return this.store.runSerializable(async (transaction) => {
      const current = await this.requireCurrentVersion(transaction, id, expectedVersion);
      if (current.lifecycleStatus !== "closed" && current.lifecycleStatus !== "cancelled") {
        throw new InvalidTaskTransitionError(current.lifecycleStatus, "reopen");
      }
      const target = {
        ...current,
        lifecycleStatus: "open" as const,
        currentOutcome: null,
        version: current.version + 1,
        scheduleRevision: current.scheduleRevision + 1
      };
      const blocking = await this.findConflicts(transaction, target, id);
      await this.assertConflictDecision(transaction, target, blocking, conflictDecision, expectedConflictFingerprint);
      const updated = await transaction.updateTask(id, expectedVersion, {
        lifecycleStatus: "open",
        currentOutcome: null,
        version: target.version,
        scheduleRevision: target.scheduleRevision,
        updatedAt: new Date()
      });
      if (!updated) throw await this.versionOrMissing(transaction, id);
      await transaction.invalidateFocusStructures(updated.id, updated.scheduleRevision, "task reopened");
      await transaction.syncReminderForTask(updated);
      await transaction.insertLifecycleEvent({
        id: randomUUID(), taskId: id, fromStatus: current.lifecycleStatus as TaskLifecycle,
        toStatus: "open", source: "app", reason
      });
      if (conflictDecision === "keep") {
        await transaction.insertConflictAcceptances(blocking.map((conflict) => canonicalAcceptance(updated, conflict)));
      }
      return { task: updated, historicalOverlaps: await this.findHistoricalOverlaps(transaction, updated) };
    });
  }

  async recordOutcome(
    id: string,
    input: {
      expectedVersion: number;
      outcome: TaskOutcome;
      progressPercent: number;
      source: TaskEventSource;
      focusSessionId?: string | null;
      satisfaction?: TaskSatisfaction;
      note?: string | null;
    }
  ): Promise<{ task: StoredTask; outcome: StoredTaskOutcome; feedback: StoredTaskFeedback | null }> {
    return this.store.runSerializable(async (transaction) => {
      const current = await this.requireCurrentVersion(transaction, id, input.expectedVersion);
      if (current.lifecycleStatus !== "open" && current.lifecycleStatus !== "awaiting_outcome") {
        throw new InvalidTaskTransitionError(current.lifecycleStatus, "record an outcome for");
      }
      const outcome = await transaction.insertOutcome({
        id: randomUUID(),
        taskId: id,
        focusSessionId: input.focusSessionId,
        outcome: input.outcome,
        progressPercent: input.progressPercent,
        source: input.source,
        note: input.note
      });
      const feedback = input.satisfaction ? await transaction.insertFeedback({
        id: randomUUID(),
        taskId: id,
        focusSessionId: input.focusSessionId,
        satisfaction: input.satisfaction,
        note: input.note
      }) : null;
      const updated = await transaction.updateTask(id, input.expectedVersion, {
        lifecycleStatus: "closed",
        currentOutcome: input.outcome,
        version: current.version + 1,
        scheduleRevision: current.scheduleRevision + 1,
        updatedAt: new Date()
      });
      if (!updated) throw await this.versionOrMissing(transaction, id);
      await transaction.invalidateFocusStructures(updated.id, updated.scheduleRevision, "task closed");
      await transaction.syncReminderForTask(updated);
      await transaction.insertLifecycleEvent({
        id: randomUUID(), taskId: id, fromStatus: current.lifecycleStatus as TaskLifecycle,
        toStatus: "closed", source: input.source, reason: input.note
      });
      return { task: updated, outcome, feedback };
    });
  }

  async correctOutcome(
    id: string,
    input: {
      expectedVersion: number;
      expectedOutcomeId: string;
      outcome: TaskOutcome;
      progressPercent: number;
      source: TaskEventSource;
      satisfaction: TaskSatisfaction;
      note?: string | null;
    }
  ): Promise<{ task: StoredTask; outcome: StoredTaskOutcome; feedback: StoredTaskFeedback }> {
    return this.store.runSerializable(async (transaction) => {
      const current = await this.requireCurrentVersion(transaction, id, input.expectedVersion);
      if (current.lifecycleStatus !== "closed") {
        throw new InvalidTaskTransitionError(current.lifecycleStatus, "correct today's outcome for");
      }
      const previous = await transaction.getOutcome(input.expectedOutcomeId, id);
      if (!previous) throw new TaskVersionConflictError(current);
      const now = new Date();
      const outcome = await transaction.insertOutcome({
        id: randomUUID(), taskId: id, focusSessionId: previous.focusSessionId,
        outcome: input.outcome, progressPercent: input.progressPercent, source: input.source, note: input.note
      });
      const previousFeedback = await transaction.getFeedbackByFocusSession(id, previous.focusSessionId);
      const feedback = previousFeedback
        ? await transaction.updateFeedback(previousFeedback.id, id, {
          satisfaction: input.satisfaction,
          note: input.note ?? null,
          createdAt: now
        })
        : await transaction.insertFeedback({
          id: randomUUID(), taskId: id, focusSessionId: previous.focusSessionId,
          satisfaction: input.satisfaction, note: null
        });
      if (!feedback) throw new TaskVersionConflictError(current);
      const updated = await transaction.updateTask(id, input.expectedVersion, {
        currentOutcome: input.outcome,
        version: current.version + 1,
        updatedAt: now
      });
      if (!updated) throw await this.versionOrMissing(transaction, id);
      return { task: updated, outcome, feedback };
    });
  }

  async acceptAllConflicts(id: string, expectedVersion: number, expectedFingerprint: string): Promise<TaskConflict[]> {
    return this.store.runSerializable(async (transaction) => {
      const current = await this.requireCurrentVersion(transaction, id, expectedVersion);
      if (!isBlocking(current.lifecycleStatus)) throw new InvalidTaskTransitionError(current.lifecycleStatus, "accept conflicts for");
      const blocking = await this.findConflicts(transaction, current, id);
      const conflicts = await this.withAcceptance(transaction, current, blocking);
      const fingerprint = conflictFingerprint(blocking);
      if (fingerprint !== expectedFingerprint) throw new ConflictSetChangedError(conflicts, fingerprint);
      await transaction.insertConflictAcceptances(blocking.map((conflict) => canonicalAcceptance(current, conflict)));
      return conflicts.map((conflict) => ({ ...conflict, accepted: true }));
    });
  }

  async recoverOrphanedActive(id: string, expectedVersion: number, reason: string): Promise<StoredTask> {
    return this.store.runSerializable(async (transaction) => {
      const current = await transaction.getTask(id);
      if (!current) throw new TaskNotFoundError("Task not found.");
      if (current.lifecycleStatus === "awaiting_outcome") return current;
      if (current.version !== expectedVersion) throw new TaskVersionConflictError(current);
      if (current.lifecycleStatus !== "active") throw new InvalidTaskTransitionError(current.lifecycleStatus, "recover");
      const updated = await transaction.updateTask(id, expectedVersion, {
        lifecycleStatus: "awaiting_outcome",
        version: current.version + 1,
        scheduleRevision: current.scheduleRevision,
        updatedAt: new Date()
      });
      if (!updated) throw await this.versionOrMissing(transaction, id);
      await transaction.syncReminderForTask(updated);
      await transaction.insertLifecycleEvent({
        id: randomUUID(), taskId: id, fromStatus: "active", toStatus: "awaiting_outcome",
        source: "system", reason
      });
      return updated;
    });
  }

  private async transition(
    id: string,
    expectedVersion: number,
    toStatus: TaskLifecycle,
    source: TaskEventSource,
    reason: string | undefined,
    allowedFrom: TaskLifecycle[],
    scheduleRevisionChanges: boolean
  ): Promise<StoredTask> {
    return this.store.runSerializable(async (transaction) => {
      const current = await this.requireCurrentVersion(transaction, id, expectedVersion);
      if (!allowedFrom.includes(current.lifecycleStatus as TaskLifecycle)) {
        throw new InvalidTaskTransitionError(current.lifecycleStatus, `transition to ${toStatus}`);
      }
      const updated = await transaction.updateTask(id, expectedVersion, {
        lifecycleStatus: toStatus,
        version: current.version + 1,
        scheduleRevision: current.scheduleRevision + (scheduleRevisionChanges ? 1 : 0),
        updatedAt: new Date()
      });
      if (!updated) throw await this.versionOrMissing(transaction, id);
      if (scheduleRevisionChanges) {
        await transaction.invalidateFocusStructures(updated.id, updated.scheduleRevision, `task transitioned to ${toStatus}`);
      }
      await transaction.syncReminderForTask(updated);
      await transaction.insertLifecycleEvent({
        id: randomUUID(), taskId: id, fromStatus: current.lifecycleStatus as TaskLifecycle,
        toStatus, source, reason
      });
      return updated;
    });
  }

  private async requireCurrentVersion(
    transaction: TaskStoreTransaction,
    id: string,
    expectedVersion: number
  ): Promise<StoredTask> {
    const current = await transaction.getTask(id);
    if (!current) throw new TaskNotFoundError("Task not found.");
    if (current.version !== expectedVersion) throw new TaskVersionConflictError(current);
    return current;
  }

  private async versionOrMissing(
    transaction: TaskStoreTransaction,
    id: string,
    includeDeleted = true
  ): Promise<Error> {
    const current = await transaction.getTask(id, includeDeleted);
    return current ? new TaskVersionConflictError(current) : new TaskNotFoundError("Task not found.");
  }

  private assertEditable(current: StoredTask, patch: TaskPatch): void {
    if (current.lifecycleStatus === "closed" || current.lifecycleStatus === "cancelled") {
      throw new InvalidTaskTransitionError(current.lifecycleStatus, "edit");
    }
    if (current.lifecycleStatus === "active" || current.lifecycleStatus === "awaiting_outcome") {
      const allowed = new Set(["expectedVersion", "title", "conflictDecision", "expectedConflictFingerprint"]);
      const hasDisallowed = Object.entries(patch).some(([key, value]) => value !== undefined && !allowed.has(key));
      if (hasDisallowed) throw new InvalidTaskTransitionError(current.lifecycleStatus, "edit scheduling or task structure for");
    }
  }

  private async findConflicts(
    transaction: TaskStoreTransaction,
    task: Pick<StoredTask, "recordKind" | "scheduleKind" | "startAt" | "endAt" | "lifecycleStatus"> & { id?: string },
    excludeTaskId?: string
  ): Promise<StoredTask[]> {
    if (task.recordKind !== "formal" || task.scheduleKind !== "exact" || !task.startAt || !task.endAt || !isBlocking(task.lifecycleStatus)) return [];
    return transaction.listExactOverlaps(task.startAt, task.endAt, blockingStatuses, excludeTaskId);
  }

  private async findHistoricalOverlaps(transaction: TaskStoreTransaction, task: StoredTask): Promise<TaskConflict[]> {
    if (task.scheduleKind !== "exact" || !task.startAt || !task.endAt) return [];
    const overlaps = await transaction.listExactOverlaps(task.startAt, task.endAt, ["closed"], task.id);
    return overlaps.map(toConflict);
  }

  private async withAcceptance(
    transaction: TaskStoreTransaction,
    task: Pick<StoredTask, "id" | "scheduleRevision">,
    conflicts: StoredTask[]
  ): Promise<TaskConflict[]> {
    return Promise.all(conflicts.map(async (conflict) => ({
      ...toConflict(conflict),
      accepted: await transaction.isConflictAccepted(canonicalAcceptance(task, conflict))
    })));
  }

  private async assertConflictDecision(
    transaction: TaskStoreTransaction,
    task: Pick<StoredTask, "id" | "scheduleRevision">,
    conflicts: StoredTask[],
    decision: "reject" | "keep",
    expectedFingerprint?: string
  ): Promise<void> {
    const detailed = await this.withAcceptance(transaction, task, conflicts);
    const fingerprint = conflictFingerprint(conflicts);
    if (detailed.length > 0) throw new TaskTimeConflictError(detailed, fingerprint);
  }
}

function toNewTaskRecord(input: TaskInput, id: NewTaskRecord["id"] = randomUUID()): NewTaskRecord {
  const startAt = input.scheduleKind === "exact" ? new Date(input.startAt!) : null;
  const endAt = input.scheduleKind === "exact" ? new Date(input.endAt!) : null;
  return {
    id,
    title: input.title,
    sourceInboxEntryId: null,
    sourceLongRangePlanId: null,
    recordKind: "formal",
    lifecycleStatus: "open",
    scheduleKind: input.scheduleKind,
    currentOutcome: null,
    localDate: input.scheduleKind === "exact" ? localDateAtTimeZone(startAt!, input.timeZone) : input.localDate ?? null,
    daypart: input.scheduleKind === "daypart" ? input.daypart ?? null : null,
    startAt,
    endAt,
    timeZone: input.timeZone,
    notes: input.notes ?? null,
    version: 1,
    scheduleRevision: 1
  };
}

function mergeAndValidate(current: StoredTask, patch: TaskPatch): NewTaskRecord {
  const candidate = {
    title: patch.title ?? current.title,
    scheduleKind: patch.scheduleKind ?? current.scheduleKind,
    localDate: patch.localDate !== undefined ? patch.localDate : current.localDate,
    daypart: patch.daypart !== undefined ? patch.daypart : current.daypart,
    startAt: patch.startAt !== undefined ? patch.startAt : current.startAt?.toISOString() ?? null,
    endAt: patch.endAt !== undefined ? patch.endAt : current.endAt?.toISOString() ?? null,
    timeZone: patch.timeZone ?? current.timeZone,
    notes: patch.notes !== undefined ? patch.notes : current.notes,
    conflictDecision: patch.conflictDecision,
    expectedConflictFingerprint: patch.expectedConflictFingerprint
  };
  if (candidate.scheduleKind === "exact") candidate.localDate = null;
  const parsed = taskInputSchema.safeParse(candidate);
  if (!parsed.success) throw parsed.error;
  return { ...toNewTaskRecord(parsed.data), id: current.id, recordKind: current.recordKind as "formal" | "backfill" };
}

function hasSchedulePatchField(patch: TaskPatch): boolean {
  return ["scheduleKind", "localDate", "daypart", "startAt", "endAt", "timeZone"]
    .some((field) => patch[field as keyof TaskPatch] !== undefined);
}

function toTaskUpdateRecord(record: NewTaskRecord): Omit<NewTaskRecord, "id"> {
  const { id: _id, ...update } = record;
  return update;
}

function hasScheduleSemanticChange(current: StoredTask, next: NewTaskRecord): boolean {
  return current.scheduleKind !== next.scheduleKind
    || current.localDate !== next.localDate
    || current.daypart !== next.daypart
    || current.startAt?.getTime() !== next.startAt?.getTime()
    || current.endAt?.getTime() !== next.endAt?.getTime()
    || current.timeZone !== next.timeZone;
}

function assertScheduleWindow(task: Pick<NewTaskRecord, "scheduleKind" | "startAt" | "endAt" | "timeZone">): void {
  if (task.scheduleKind !== "exact" || !task.startAt || !task.endAt) return;
  const now = new Date();
  if (localDateAtTimeZone(task.startAt, task.timeZone) !== localDateAtTimeZone(now, task.timeZone)) return;
  const nowParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: task.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);
  const nowMinute = Number(nowParts.find((part) => part.type === "hour")?.value ?? 0) * 60
    + Number(nowParts.find((part) => part.type === "minute")?.value ?? 0);
  const earliestMinute = Math.min(24 * 60, (Math.floor(nowMinute / 30) + 1) * 30);
  const startParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: task.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(task.startAt);
  const startMinute = Number(startParts.find((part) => part.type === "hour")?.value ?? 0) * 60
    + Number(startParts.find((part) => part.type === "minute")?.value ?? 0);
  if (startMinute < earliestMinute) {
    throw new TaskScheduleWindowError(new Date(task.startAt.getTime() + (earliestMinute - startMinute) * 60_000));
  }
}

function assertProductScheduleBounds(task: Pick<NewTaskRecord, "scheduleKind" | "startAt" | "endAt" | "timeZone">): void {
  if (task.scheduleKind !== "exact" || !task.startAt || !task.endAt) return;
  if (!isWithinProductScheduleWindow(task.startAt, task.endAt, task.timeZone)) throw new TaskScheduleBoundsError();
}

function assertBackfillWindow(task: Pick<NewTaskRecord, "scheduleKind" | "startAt" | "endAt" | "timeZone">): void {
  if (task.scheduleKind !== "exact" || !task.startAt || !task.endAt) throw new TaskBackfillWindowError(new Date());
  const now = new Date();
  const localDate = localDateAtTimeZone(now, task.timeZone);
  if (localDateAtTimeZone(task.startAt, task.timeZone) !== localDate || localDateAtTimeZone(task.endAt, task.timeZone) !== localDate) {
    throw new TaskBackfillWindowError(now);
  }
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: task.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const minute = (value: Date) => {
    const parts = formatter.formatToParts(value);
    return Number(parts.find((part) => part.type === "hour")?.value ?? 0) * 60
      + Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  };
  const startMinute = minute(task.startAt);
  const endMinute = minute(task.endAt);
  const nowMinute = minute(now);
  const latestMinute = Math.min(24 * 60, (Math.floor(nowMinute / 30) + 1) * 30);
  const latestEndAt = new Date(task.startAt.getTime() + (latestMinute - startMinute) * 60_000);
  if (startMinute >= latestMinute || endMinute > latestMinute) throw new TaskBackfillWindowError(latestEndAt);
}

function isBlocking(status: string): boolean {
  return blockingStatuses.includes(status as TaskLifecycle);
}

function exactlyOverlaps(left: StoredTask, right: StoredTask): boolean {
  return left.scheduleKind === "exact" && right.scheduleKind === "exact"
    && Boolean(left.startAt && left.endAt && right.startAt && right.endAt)
    && left.startAt! < right.endAt! && left.endAt! > right.startAt!;
}

function toConflict(task: StoredTask): TaskConflict {
  if (!task.startAt || !task.endAt) throw new Error("Conflict task is missing its exact interval.");
  return {
    taskId: task.id,
    title: task.title,
    startAt: task.startAt,
    endAt: task.endAt,
    lifecycleStatus: task.lifecycleStatus as TaskLifecycle,
    scheduleRevision: task.scheduleRevision,
    accepted: false
  };
}

function canonicalAcceptance(
  left: Pick<StoredTask, "id" | "scheduleRevision">,
  right: Pick<StoredTask, "id" | "scheduleRevision">
): ConflictAcceptanceRecord {
  if (left.id < right.id) {
    return {
      taskIdLow: left.id,
      taskScheduleRevisionLow: left.scheduleRevision,
      taskIdHigh: right.id,
      taskScheduleRevisionHigh: right.scheduleRevision
    };
  }
  return {
    taskIdLow: right.id,
    taskScheduleRevisionLow: right.scheduleRevision,
    taskIdHigh: left.id,
    taskScheduleRevisionHigh: left.scheduleRevision
  };
}

export function conflictFingerprint(conflicts: Array<Pick<StoredTask, "id" | "scheduleRevision">>): string {
  const normalized = conflicts
    .map((task) => `${task.id}:${task.scheduleRevision}`)
    .sort()
    .join("|");
  return createHash("sha256").update(normalized).digest("hex");
}
