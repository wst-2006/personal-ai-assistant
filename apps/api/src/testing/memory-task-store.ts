import type { TaskLifecycle } from "@personal-ai/domain/task";
import type {
  ConflictAcceptanceRecord,
  LifecycleEventRecord,
  NewTaskRecord,
  StoredTask,
  StoredTaskFeedback,
  StoredInboxEntry,
  StoredTaskOutcome,
  TaskOutcomeRecord,
  TaskFeedbackRecord,
  TaskStore,
  TaskStoreTransaction,
  TaskUpdateRecord
} from "../task-repository.js";

type MemoryReminderJob = {
  id: string;
  taskId: string;
  kind: "task_start" | "task_start_ready" | "task_start_lapsed" | "task_start_expire";
  scheduleRevision: number;
  status: "pending" | "sent" | "cancelled";
  scheduledAt: Date;
  availableAt: Date;
  payload: Record<string, unknown>;
};

export class MemoryTaskStore implements TaskStore, TaskStoreTransaction {
  tasks: StoredTask[] = [];
  outcomes: StoredTaskOutcome[] = [];
  feedback: StoredTaskFeedback[] = [];
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
        feedback: this.feedback,
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
        this.feedback = snapshot.feedback;
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

  async restoreDeletedTask(id: string, expectedVersion: number, changes: TaskUpdateRecord): Promise<StoredTask | null> {
    const index = this.tasks.findIndex((task) => task.id === id && task.version === expectedVersion && Boolean(task.deletedAt));
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

  async listDeletedTasks(localDate?: string): Promise<StoredTask[]> {
    return this.tasks
      .filter((task) => Boolean(task.deletedAt) && (!localDate || task.localDate === localDate))
      .sort((left, right) => (right.deletedAt?.getTime() ?? 0) - (left.deletedAt?.getTime() ?? 0));
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
      && task.recordKind === "formal"
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

  async getOutcome(id: string, taskId: string): Promise<StoredTaskOutcome | null> {
    return this.outcomes.find((item) => item.id === id && item.taskId === taskId) ?? null;
  }

  async insertFeedback(record: TaskFeedbackRecord): Promise<StoredTaskFeedback> {
    const feedback: StoredTaskFeedback = {
      id: record.id,
      taskId: record.taskId,
      focusSessionId: record.focusSessionId ?? null,
      satisfaction: record.satisfaction,
      note: record.note ?? null,
      createdAt: new Date()
    };
    this.feedback.push(feedback);
    return feedback;
  }

  async listFeedback(taskId: string): Promise<StoredTaskFeedback[]> {
    return this.feedback
      .filter((item) => item.taskId === taskId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  async invalidateFocusStructures(_taskId: string, _currentScheduleRevision: number, _reason: string): Promise<void> {
    // The in-memory task store intentionally has no focus-structure projection.
  }

  async syncReminderForTask(task: StoredTask): Promise<void> {
    const taskJobs = this.reminderJobs.filter((job) => job.taskId === task.id);
    const shouldSchedule = !task.deletedAt
      && task.recordKind === "formal"
      && task.lifecycleStatus === "open"
      && task.scheduleKind === "exact"
      && Boolean(task.startAt && task.endAt);
    if (!shouldSchedule) {
      for (const job of taskJobs) {
        const index = this.reminderJobs.findIndex((candidate) => candidate.id === job.id);
        if (index >= 0 && this.reminderJobs[index]!.status !== "sent") {
          this.reminderJobs[index] = { ...this.reminderJobs[index]!, status: "cancelled" };
        }
      }
      return;
    }
    const scheduledAt = task.startAt!;
    for (const kind of ["task_start", "task_start_ready", "task_start_lapsed", "task_start_expire"] as const) {
      const index = this.reminderJobs.findIndex((job) => job.taskId === task.id && job.kind === kind);
      const existing = index >= 0 ? this.reminderJobs[index]! : null;
      const next: MemoryReminderJob = {
        id: existing?.id ?? `reminder-${kind}-${task.id}`,
        taskId: task.id,
        kind,
        scheduleRevision: task.scheduleRevision,
        status: existing?.scheduleRevision === task.scheduleRevision ? existing.status : "pending",
        scheduledAt,
        availableAt: kind === "task_start"
          ? new Date(scheduledAt.getTime() - 15 * 60 * 1000)
          : kind === "task_start_ready"
            ? new Date(scheduledAt.getTime() - 60 * 1000)
            : kind === "task_start_lapsed"
              ? scheduledAt
              : task.endAt!,
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

  async purgeDeletedTasks(): Promise<number> {
    const deletedIds = new Set(this.tasks.filter((task) => Boolean(task.deletedAt)).map((task) => task.id));
    if (deletedIds.size === 0) return 0;
    this.tasks = this.tasks.filter((task) => !deletedIds.has(task.id));
    this.outcomes = this.outcomes.filter((item) => !deletedIds.has(item.taskId));
    this.feedback = this.feedback.filter((item) => !deletedIds.has(item.taskId));
    this.lifecycleEvents = this.lifecycleEvents.filter((item) => !deletedIds.has(item.taskId));
    this.acceptances = this.acceptances.filter((item) => !deletedIds.has(item.taskIdLow) && !deletedIds.has(item.taskIdHigh));
    this.reminderJobs = this.reminderJobs.filter((item) => !deletedIds.has(item.taskId));
    return deletedIds.size;
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
