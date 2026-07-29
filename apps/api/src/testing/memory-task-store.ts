import type { TaskLifecycle } from "@personal-ai/domain/task";
import type {
  ConflictAcceptanceRecord,
  LifecycleEventRecord,
  NewTaskRecord,
  StoredTask,
  StoredInboxEntry,
  StoredTaskOutcome,
  TaskOutcomeRecord,
  TaskStore,
  TaskStoreTransaction,
  TaskUpdateRecord
} from "../task-repository.js";

type MemoryReminderJob = {
  id: string;
  taskId: string;
  scheduleRevision: number;
  status: "pending" | "sent" | "cancelled";
  scheduledAt: Date;
  availableAt: Date;
  payload: Record<string, unknown>;
};

export class MemoryTaskStore implements TaskStore, TaskStoreTransaction {
  tasks: StoredTask[] = [];
  outcomes: StoredTaskOutcome[] = [];
  lifecycleEvents: LifecycleEventRecord[] = [];
  acceptances: ConflictAcceptanceRecord[] = [];
  inboxEntries: StoredInboxEntry[] = [];
  reminderJobs: MemoryReminderJob[] = [];
  transactionAttempts = 0;
  serializationFailuresRemaining = 0;

  async runSerializable<T>(operation: (transaction: TaskStoreTransaction) => Promise<T>): Promise<T> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.transactionAttempts += 1;
      const snapshot = structuredClone({
        tasks: this.tasks,
        outcomes: this.outcomes,
        lifecycleEvents: this.lifecycleEvents,
        acceptances: this.acceptances,
        inboxEntries: this.inboxEntries,
        reminderJobs: this.reminderJobs
      });
      try {
        const result = await operation(this);
        if (this.serializationFailuresRemaining > 0) {
          this.serializationFailuresRemaining -= 1;
          const failure = new Error("serialization failure") as Error & { code: string };
          failure.code = "40001";
          throw failure;
        }
        return result;
      } catch (error) {
        this.tasks = snapshot.tasks;
        this.outcomes = snapshot.outcomes;
        this.lifecycleEvents = snapshot.lifecycleEvents;
        this.acceptances = snapshot.acceptances;
        this.inboxEntries = snapshot.inboxEntries;
        this.reminderJobs = snapshot.reminderJobs;
        if (!isSerializationFailure(error) || attempt === maxAttempts) throw error;
      }
    }
    throw new Error("Serializable transaction exhausted its retry budget.");
  }

  async insertTask(record: NewTaskRecord): Promise<StoredTask> {
    const now = new Date();
    const task: StoredTask = { ...record, deletedAt: null, createdAt: now, updatedAt: now };
    this.tasks.push(task);
    return task;
  }

  async insertInboxEntry(record: Parameters<TaskStoreTransaction["insertInboxEntry"]>[0]): Promise<StoredInboxEntry> {
    const now = new Date();
    const entry = { ...record, convertedAt: null, deletedAt: null, createdAt: now, updatedAt: now } as StoredInboxEntry;
    this.inboxEntries.push(entry);
    return entry;
  }

  async getInboxEntry(id: string): Promise<StoredInboxEntry | null> {
    return this.inboxEntries.find((entry) => entry.id === id && !entry.deletedAt) ?? null;
  }

  async markInboxConverted(id: string, expectedVersion: number, convertedAt: Date): Promise<StoredInboxEntry | null> {
    const index = this.inboxEntries.findIndex((entry) => entry.id === id && entry.version === expectedVersion && !entry.convertedAt);
    if (index < 0) return null;
    const entry = { ...this.inboxEntries[index]!, convertedAt, updatedAt: convertedAt, version: expectedVersion + 1 };
    this.inboxEntries[index] = entry;
    return entry;
  }

  async listInboxEntries(): Promise<StoredInboxEntry[]> {
    return this.inboxEntries.filter((entry) => !entry.deletedAt && !entry.convertedAt);
  }

  async getTask(id: string, includeDeleted = false): Promise<StoredTask | null> {
    return this.tasks.find((task) => task.id === id && (includeDeleted || !task.deletedAt)) ?? null;
  }

  async updateTask(id: string, expectedVersion: number, changes: TaskUpdateRecord): Promise<StoredTask | null> {
    const index = this.tasks.findIndex((task) => task.id === id && task.version === expectedVersion && !task.deletedAt);
    if (index < 0) return null;
    const updated = { ...this.tasks[index]!, ...changes } as StoredTask;
    this.tasks[index] = updated;
    return updated;
  }

  async listTasks(localDate?: string): Promise<StoredTask[]> {
    return this.tasks
      .filter((task) => !task.deletedAt && (!localDate || task.localDate === localDate))
      .sort((left, right) => (left.startAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (right.startAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
  }

  async listOutcomes(taskId: string): Promise<StoredTaskOutcome[]> {
    return this.outcomes.filter((outcome) => outcome.taskId === taskId).sort((left, right) => right.recordedAt.getTime() - left.recordedAt.getTime());
  }

  async listExactOverlaps(
    startAt: Date,
    endAt: Date,
    lifecycleStatuses: TaskLifecycle[],
    excludeTaskId?: string
  ): Promise<StoredTask[]> {
    return this.tasks.filter((task) => !task.deletedAt
      && task.id !== excludeTaskId
      && task.scheduleKind === "exact"
      && lifecycleStatuses.includes(task.lifecycleStatus as TaskLifecycle)
      && Boolean(task.startAt && task.endAt)
      && task.startAt! < endAt
      && task.endAt! > startAt);
  }

  async isConflictAccepted(record: ConflictAcceptanceRecord): Promise<boolean> {
    return this.acceptances.some((existing) => acceptanceKey(existing) === acceptanceKey(record));
  }

  async insertConflictAcceptances(records: ConflictAcceptanceRecord[]): Promise<void> {
    for (const record of records) {
      if (!await this.isConflictAccepted(record)) this.acceptances.push(record);
    }
  }

  async insertLifecycleEvent(record: LifecycleEventRecord): Promise<void> {
    this.lifecycleEvents.push(record);
  }

  async insertOutcome(record: TaskOutcomeRecord): Promise<StoredTaskOutcome> {
    const outcome: StoredTaskOutcome = {
      id: record.id,
      taskId: record.taskId,
      focusSessionId: record.focusSessionId ?? null,
      outcome: record.outcome,
      progressPercent: record.progressPercent,
      source: record.source,
      note: record.note ?? null,
      recordedAt: new Date()
    };
    this.outcomes.push(outcome);
    return outcome;
  }

  async syncReminderForTask(task: StoredTask): Promise<void> {
    const index = this.reminderJobs.findIndex((job) => job.taskId === task.id);
    const shouldSchedule = !task.deletedAt
      && task.lifecycleStatus === "open"
      && task.scheduleKind === "exact"
      && Boolean(task.startAt && task.endAt);
    if (!shouldSchedule) {
      if (index >= 0 && this.reminderJobs[index]!.status !== "sent") {
        this.reminderJobs[index] = { ...this.reminderJobs[index]!, status: "cancelled" };
      }
      return;
    }
    const scheduledAt = task.startAt!;
    const next: MemoryReminderJob = {
      id: index >= 0 ? this.reminderJobs[index]!.id : `reminder-${task.id}`,
      taskId: task.id,
      scheduleRevision: task.scheduleRevision,
      status: "pending",
      scheduledAt,
      availableAt: new Date(scheduledAt.getTime() - 15 * 60 * 1000),
      payload: {
        taskId: task.id,
        title: task.title,
        startAt: scheduledAt.toISOString(),
        endAt: task.endAt!.toISOString(),
        timeZone: task.timeZone,
        scheduleRevision: task.scheduleRevision
      }
    };
    if (index >= 0) this.reminderJobs[index] = next;
    else this.reminderJobs.push(next);
  }
}

function acceptanceKey(record: ConflictAcceptanceRecord): string {
  return [
    record.taskIdLow,
    record.taskScheduleRevisionLow,
    record.taskIdHigh,
    record.taskScheduleRevisionHigh
  ].join(":");
}

function isSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "40001";
}
