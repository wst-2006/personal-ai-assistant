import type { AppDatabase } from "@personal-ai/db/client";
import {
  taskConflictAcceptances,
  taskLifecycleEvents,
  taskOutcomes,
  tasks
} from "@personal-ai/db/schema";
import type { TaskEventSource, TaskLifecycle, TaskOutcome, TaskScheduleKind } from "@personal-ai/domain/task";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne } from "drizzle-orm";

export type StoredTask = typeof tasks.$inferSelect;
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
  plannedEffortMinutes: number | null;
  difficulty: string | null;
  taskType: string | null;
  requiresContinuousFocus: boolean | null;
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
  insertTask(record: NewTaskRecord): Promise<StoredTask>;
  getTask(id: string, includeDeleted?: boolean): Promise<StoredTask | null>;
  updateTask(id: string, expectedVersion: number, changes: TaskUpdateRecord): Promise<StoredTask | null>;
  listExactOverlaps(startAt: Date, endAt: Date, lifecycleStatuses: TaskLifecycle[], excludeTaskId?: string): Promise<StoredTask[]>;
  isConflictAccepted(record: ConflictAcceptanceRecord): Promise<boolean>;
  insertConflictAcceptances(records: ConflictAcceptanceRecord[]): Promise<void>;
  insertLifecycleEvent(record: LifecycleEventRecord): Promise<void>;
  insertOutcome(record: TaskOutcomeRecord): Promise<StoredTaskOutcome>;
}

export interface TaskStore {
  runSerializable<T>(operation: (transaction: TaskStoreTransaction) => Promise<T>): Promise<T>;
  getTask(id: string): Promise<StoredTask | null>;
  listTasks(localDate?: string): Promise<StoredTask[]>;
  listOutcomes(taskId: string): Promise<StoredTaskOutcome[]>;
  listExactOverlaps(startAt: Date, endAt: Date, lifecycleStatuses: TaskLifecycle[], excludeTaskId?: string): Promise<StoredTask[]>;
  isConflictAccepted(record: ConflictAcceptanceRecord): Promise<boolean>;
}

class PostgresTaskTransaction implements TaskStoreTransaction {
  constructor(private readonly db: AppDatabase) {}

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
}

function isSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "40001";
}
