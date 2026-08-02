import type { AppDatabase } from "@personal-ai/db/client";
import {
  focusStructures,
  inboxEntries,
  taskConflictAcceptances,
  taskLifecycleEvents,
  taskOutcomes,
  tasks
} from "@personal-ai/db/schema";
import type { TaskEventSource, TaskLifecycle, TaskOutcome, TaskScheduleKind } from "@personal-ai/domain/task";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { syncTaskStartReminder } from "./reminder-scheduler.js";

export type StoredTask = typeof tasks.$inferSelect;
export type StoredInboxEntry = typeof inboxEntries.$inferSelect;
export type StoredTaskOutcome = typeof taskOutcomes.$inferSelect;

export type NewTaskRecord = {
  id: string;
  title: string;
  sourceInboxEntryId: string | null;
  lifecycleStatus: TaskLifecycle;
  scheduleKind: TaskScheduleKind;
  currentOutcome: TaskOutcome | null;
  localDate: string | null;
  daypart: string | null;
  startAt: Date | null;
  endAt: Date | null;
  timeZone: string;
  notes: string | null;
  version: number;
  scheduleRevision: number;
};

export type TaskUpdateRecord = Partial<Omit<NewTaskRecord, "id">> & {
  deletedAt?: Date | null;
  updatedAt: Date;
};

export type LifecycleEventRecord = {
  id: string;
  taskId: string;
  fromStatus: TaskLifecycle | null;
  toStatus: TaskLifecycle | "deleted";
  source: TaskEventSource;
  reason?: string | null;
};

export type TaskOutcomeRecord = {
  id: string;
  taskId: string;
  focusSessionId?: string | null;
  outcome: TaskOutcome;
  progressPercent: number;
  source: TaskEventSource;
  note?: string | null;
};

export type ConflictAcceptanceRecord = {
  taskIdLow: string;
  taskScheduleRevisionLow: number;
  taskIdHigh: string;
  taskScheduleRevisionHigh: number;
};

export interface TaskStoreTransaction {
  insertInboxEntry(record: typeof inboxEntries.$inferInsert): Promise<StoredInboxEntry>;
  getInboxEntry(id: string): Promise<StoredInboxEntry | null>;
  markInboxConverted(id: string, expectedVersion: number, convertedAt: Date): Promise<StoredInboxEntry | null>;
  insertTask(record: NewTaskRecord): Promise<StoredTask>;
  getTask(id: string, includeDeleted?: boolean): Promise<StoredTask | null>;
  updateTask(id: string, expectedVersion: number, changes: TaskUpdateRecord): Promise<StoredTask | null>;
  listExactOverlaps(startAt: Date, endAt: Date, lifecycleStatuses: TaskLifecycle[], excludeTaskId?: string): Promise<StoredTask[]>;
  isConflictAccepted(record: ConflictAcceptanceRecord): Promise<boolean>;
  insertConflictAcceptances(records: ConflictAcceptanceRecord[]): Promise<void>;
  insertLifecycleEvent(record: LifecycleEventRecord): Promise<void>;
  insertOutcome(record: TaskOutcomeRecord): Promise<StoredTaskOutcome>;
  invalidateFocusStructures(taskId: string, currentScheduleRevision: number, reason: string): Promise<void>;
  syncReminderForTask(task: StoredTask): Promise<void>;
}

export interface TaskStore {
  runSerializable<T>(operation: (transaction: TaskStoreTransaction) => Promise<T>): Promise<T>;
  getTask(id: string): Promise<StoredTask | null>;
  listTasks(localDate?: string): Promise<StoredTask[]>;
  listOutcomes(taskId: string): Promise<StoredTaskOutcome[]>;
  listExactOverlaps(startAt: Date, endAt: Date, lifecycleStatuses: TaskLifecycle[], excludeTaskId?: string): Promise<StoredTask[]>;
  isConflictAccepted(record: ConflictAcceptanceRecord): Promise<boolean>;
  listInboxEntries(): Promise<StoredInboxEntry[]>;
}

class PostgresTaskTransaction implements TaskStoreTransaction {
  constructor(private readonly db: AppDatabase) {}

  async insertInboxEntry(record: typeof inboxEntries.$inferInsert): Promise<StoredInboxEntry> {
    const [created] = await this.db.insert(inboxEntries).values(record).returning();
    if (!created) throw new Error("PostgreSQL did not return the inbox entry.");
    return created;
  }

  async getInboxEntry(id: string): Promise<StoredInboxEntry | null> {
    const [entry] = await this.db.select().from(inboxEntries)
      .where(and(eq(inboxEntries.id, id), isNull(inboxEntries.deletedAt))).limit(1);
    return entry ?? null;
  }

  async markInboxConverted(id: string, expectedVersion: number, convertedAt: Date): Promise<StoredInboxEntry | null> {
    const [entry] = await this.db.update(inboxEntries).set({
      convertedAt, version: expectedVersion + 1, updatedAt: convertedAt
    }).where(and(eq(inboxEntries.id, id), eq(inboxEntries.version, expectedVersion),
      isNull(inboxEntries.convertedAt), isNull(inboxEntries.deletedAt))).returning();
    return entry ?? null;
  }

  async insertTask(record: NewTaskRecord): Promise<StoredTask> {
    const [created] = await this.db.insert(tasks).values(record).returning();
    if (!created) throw new Error("PostgreSQL did not return the created task.");
    return created;
  }

  async getTask(id: string, includeDeleted = false): Promise<StoredTask | null> {
    const conditions = [eq(tasks.id, id)];
    if (!includeDeleted) conditions.push(isNull(tasks.deletedAt));
    const [task] = await this.db.select().from(tasks).where(and(...conditions)).limit(1);
    return task ?? null;
  }

  async updateTask(id: string, expectedVersion: number, changes: TaskUpdateRecord): Promise<StoredTask | null> {
    const [updated] = await this.db
      .update(tasks)
      .set(changes)
      .where(and(eq(tasks.id, id), eq(tasks.version, expectedVersion), isNull(tasks.deletedAt)))
      .returning();
    return updated ?? null;
  }

  async listExactOverlaps(
    startAt: Date,
    endAt: Date,
    lifecycleStatuses: TaskLifecycle[],
    excludeTaskId?: string
  ): Promise<StoredTask[]> {
    const conditions = [
      isNull(tasks.deletedAt),
      eq(tasks.scheduleKind, "exact"),
      inArray(tasks.lifecycleStatus, lifecycleStatuses),
      lt(tasks.startAt, endAt),
      gt(tasks.endAt, startAt)
    ];
    if (excludeTaskId) conditions.push(ne(tasks.id, excludeTaskId));
    return this.db.select().from(tasks).where(and(...conditions)).orderBy(asc(tasks.startAt), asc(tasks.id));
  }

  async isConflictAccepted(record: ConflictAcceptanceRecord): Promise<boolean> {
    const [found] = await this.db
      .select({ taskIdLow: taskConflictAcceptances.taskIdLow })
      .from(taskConflictAcceptances)
      .where(and(
        eq(taskConflictAcceptances.taskIdLow, record.taskIdLow),
        eq(taskConflictAcceptances.taskScheduleRevisionLow, record.taskScheduleRevisionLow),
        eq(taskConflictAcceptances.taskIdHigh, record.taskIdHigh),
        eq(taskConflictAcceptances.taskScheduleRevisionHigh, record.taskScheduleRevisionHigh)
      ))
      .limit(1);
    return Boolean(found);
  }

  async insertConflictAcceptances(records: ConflictAcceptanceRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.db.insert(taskConflictAcceptances).values(records).onConflictDoNothing();
  }

  async insertLifecycleEvent(record: LifecycleEventRecord): Promise<void> {
    await this.db.insert(taskLifecycleEvents).values(record);
  }

  async insertOutcome(record: TaskOutcomeRecord): Promise<StoredTaskOutcome> {
    const [created] = await this.db.insert(taskOutcomes).values(record).returning();
    if (!created) throw new Error("PostgreSQL did not return the created task outcome.");
    return created;
  }

  async invalidateFocusStructures(taskId: string, currentScheduleRevision: number, reason: string): Promise<void> {
    const now = new Date();
    await this.db.update(focusStructures).set({
      state: "invalidated",
      invalidatedAt: now,
      invalidationReason: reason,
      version: sql`${focusStructures.version} + 1`,
      updatedAt: now
    }).where(and(
      eq(focusStructures.taskId, taskId),
      ne(focusStructures.taskScheduleRevision, currentScheduleRevision),
      inArray(focusStructures.state, ["candidate", "active"])
    ));
  }

  async syncReminderForTask(task: StoredTask): Promise<void> {
    await syncTaskStartReminder(this.db, task);
  }
}

export class PostgresTaskStore implements TaskStore {
  private readonly reader: PostgresTaskTransaction;

  constructor(private readonly db: AppDatabase) {
    this.reader = new PostgresTaskTransaction(db);
  }

  async runSerializable<T>(operation: (transaction: TaskStoreTransaction) => Promise<T>): Promise<T> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.db.transaction(
          async (transaction) => operation(new PostgresTaskTransaction(transaction as unknown as AppDatabase)),
          { isolationLevel: "serializable" }
        );
      } catch (error) {
        if (!isSerializationFailure(error) || attempt === maxAttempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
      }
    }
    throw new Error("Serializable task transaction exhausted its retry budget.");
  }

  getTask(id: string): Promise<StoredTask | null> {
    return this.reader.getTask(id);
  }

  listTasks(localDate?: string): Promise<StoredTask[]> {
    const conditions = [isNull(tasks.deletedAt)];
    if (localDate) conditions.push(eq(tasks.localDate, localDate));
    return this.db.select().from(tasks).where(and(...conditions)).orderBy(asc(tasks.startAt), asc(tasks.createdAt));
  }

  listOutcomes(taskId: string): Promise<StoredTaskOutcome[]> {
    return this.db.select().from(taskOutcomes).where(eq(taskOutcomes.taskId, taskId)).orderBy(desc(taskOutcomes.recordedAt));
  }

  listExactOverlaps(
    startAt: Date,
    endAt: Date,
    lifecycleStatuses: TaskLifecycle[],
    excludeTaskId?: string
  ): Promise<StoredTask[]> {
    return this.reader.listExactOverlaps(startAt, endAt, lifecycleStatuses, excludeTaskId);
  }

  isConflictAccepted(record: ConflictAcceptanceRecord): Promise<boolean> {
    return this.reader.isConflictAccepted(record);
  }

  listInboxEntries(): Promise<StoredInboxEntry[]> {
    return this.db.select().from(inboxEntries)
      .where(and(isNull(inboxEntries.deletedAt), isNull(inboxEntries.convertedAt)))
      .orderBy(asc(inboxEntries.createdAt));
  }
}

function isSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "40001";
}
