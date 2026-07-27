import type { TaskLifecycle } from "@personal-ai/domain/task";
import type {
  ConflictAcceptanceRecord,
  LifecycleEventRecord,
  NewTaskRecord,
  StoredTask,
  StoredTaskOutcome,
  TaskOutcomeRecord,
  TaskStore,
  TaskStoreTransaction,
  TaskUpdateRecord
} from "../task-repository.js";

export class MemoryTaskStore implements TaskStore, TaskStoreTransaction {
  tasks: StoredTask[] = [];
  outcomes: StoredTaskOutcome[] = [];
  lifecycleEvents: LifecycleEventRecord[] = [];
  acceptances: ConflictAcceptanceRecord[] = [];
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
        acceptances: this.acceptances
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
