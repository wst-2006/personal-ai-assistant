import { taskInputSchema, taskPatchSchema } from "@personal-ai/domain/task";
import { describe, expect, it } from "vitest";
import type { ConflictAcceptanceRecord } from "./task-repository.js";
import {
  ConflictSetChangedError,
  InboxEntryConflictError,
  InvalidTaskTransitionError,
  TaskService,
  TaskTimeConflictError,
  TaskVersionConflictError
} from "./task-service.js";
import { MemoryTaskStore } from "./testing/memory-task-store.js";

function unscheduled(title = "Task") {
  return taskInputSchema.parse({
    title,
    scheduleKind: "none",
    localDate: "2026-07-27"
  });
}

function exact(title: string, start: string, end: string, conflict?: { decision: "keep"; fingerprint: string }) {
  return taskInputSchema.parse({
    title,
    scheduleKind: "exact",
    startAt: `2026-07-27T${start}:00+08:00`,
    endAt: `2026-07-27T${end}:00+08:00`,
    timeZone: "Asia/Shanghai",
    conflictDecision: conflict?.decision,
    expectedConflictFingerprint: conflict?.fingerprint
  });
}

async function rejectedConflict(operation: Promise<unknown>): Promise<TaskTimeConflictError> {
  try {
    await operation;
    throw new Error("Expected a task time conflict.");
  } catch (error) {
    expect(error).toBeInstanceOf(TaskTimeConflictError);
    return error as TaskTimeConflictError;
  }
}

describe("TaskService lifecycle and revisions", () => {
  it("keeps lifecycle, scheduling, deletion, version and schedule revision independent", async () => {
    const store = new MemoryTaskStore();
    const service = new TaskService(store);
    const created = (await service.create(unscheduled())).task;
    expect(created).toMatchObject({ lifecycleStatus: "open", scheduleKind: "none", version: 1, scheduleRevision: 1 });

    const renamed = (await service.update(created.id, taskPatchSchema.parse({
      expectedVersion: created.version,
      title: "Renamed"
    }))).task;
    expect(renamed).toMatchObject({ version: 2, scheduleRevision: 1 });

    const scheduled = (await service.update(created.id, taskPatchSchema.parse({
      expectedVersion: renamed.version,
      expectedScheduleRevision: renamed.scheduleRevision,
      scheduleKind: "daypart",
      localDate: "2026-07-28",
      daypart: "morning"
    }))).task;
    expect(scheduled).toMatchObject({ version: 3, scheduleRevision: 2, lifecycleStatus: "open" });

    const active = await service.start(created.id, scheduled.version);
    const awaiting = await service.awaitOutcome(created.id, active.version);
    expect(active).toMatchObject({ lifecycleStatus: "active", version: 4, scheduleRevision: 2 });
    expect(awaiting).toMatchObject({ lifecycleStatus: "awaiting_outcome", version: 5, scheduleRevision: 2 });

    const closed = (await service.recordOutcome(created.id, {
      expectedVersion: awaiting.version,
      outcome: "complete",
      progressPercent: 100,
      source: "app"
    })).task;
    expect(closed).toMatchObject({ lifecycleStatus: "closed", currentOutcome: "complete", version: 6, scheduleRevision: 3 });
  });

  it("retains append-only outcome history when a task is reopened", async () => {
    const store = new MemoryTaskStore();
    const service = new TaskService(store);
    let task = (await service.create(unscheduled())).task;
    task = (await service.recordOutcome(task.id, {
      expectedVersion: task.version, outcome: "partial", progressPercent: 40, source: "app"
    })).task;
    task = (await service.reopen(task.id, task.version, "reject")).task;
    expect(task.currentOutcome).toBeNull();
    task = (await service.recordOutcome(task.id, {
      expectedVersion: task.version, outcome: "complete", progressPercent: 100, source: "app"
    })).task;

    const detail = await service.get(task.id);
    expect(detail.outcomes).toHaveLength(2);
    expect(detail.outcomes.map((item) => item.outcome).sort()).toEqual(["complete", "partial"]);
    expect(task.currentOutcome).toBe("complete");
  });

  it("rejects invalid transitions and stale versions", async () => {
    const service = new TaskService(new MemoryTaskStore());
    const task = (await service.create(unscheduled())).task;
    const active = await service.start(task.id, task.version);
    await expect(service.cancel(task.id, active.version)).rejects.toBeInstanceOf(InvalidTaskTransitionError);
    await expect(service.update(task.id, taskPatchSchema.parse({
      expectedVersion: task.version,
      title: "Stale"
    }))).rejects.toBeInstanceOf(TaskVersionConflictError);
  });

  it("recovers an orphaned active task idempotently without changing schedule revision", async () => {
    const service = new TaskService(new MemoryTaskStore());
    const task = (await service.create(unscheduled())).task;
    const active = await service.start(task.id, task.version);
    const recovered = await service.recoverOrphanedActive(task.id, active.version, "missing focus session");
    const repeated = await service.recoverOrphanedActive(task.id, active.version, "missing focus session");
    expect(recovered).toMatchObject({ lifecycleStatus: "awaiting_outcome", scheduleRevision: active.scheduleRevision });
    expect(repeated).toEqual(recovered);
  });
});

describe("TaskService reminder scheduling", () => {
  it("creates a 15-minute reminder and keeps it aligned with task edits", async () => {
    const store = new MemoryTaskStore();
    const service = new TaskService(store);
    const created = (await service.create(exact("Read paper", "14:00", "15:30"))).task;

    expect(store.reminderJobs).toHaveLength(2);
    const startReminder = store.reminderJobs.find((job) => job.kind === "task_start");
    const followUp = store.reminderJobs.find((job) => job.kind === "task_follow_up");
    expect(startReminder).toMatchObject({
      taskId: created.id,
      scheduleRevision: created.scheduleRevision,
      status: "pending"
    });
    expect(startReminder!.availableAt.toISOString()).toBe("2026-07-27T05:45:00.000Z");
    expect(followUp).toMatchObject({
      taskId: created.id,
      scheduleRevision: created.scheduleRevision,
      status: "pending"
    });
    expect(followUp!.availableAt.toISOString()).toBe("2026-07-27T06:05:00.000Z");

    const renamed = (await service.update(created.id, taskPatchSchema.parse({
      expectedVersion: created.version,
      title: "Read systems paper"
    }))).task;
    expect(renamed.scheduleRevision).toBe(created.scheduleRevision);
    expect(store.reminderJobs.every((job) => job.payload.title === "Read systems paper")).toBe(true);

    const moved = (await service.update(created.id, taskPatchSchema.parse({
      expectedVersion: renamed.version,
      expectedScheduleRevision: renamed.scheduleRevision,
      startAt: "2026-07-27T16:00:00+08:00",
      endAt: "2026-07-27T17:30:00+08:00"
    }))).task;
    expect(store.reminderJobs.every((job) => job.scheduleRevision === moved.scheduleRevision && job.status === "pending")).toBe(true);
    expect(store.reminderJobs.find((job) => job.kind === "task_start")!.availableAt.toISOString()).toBe("2026-07-27T07:45:00.000Z");
    expect(store.reminderJobs.find((job) => job.kind === "task_follow_up")!.availableAt.toISOString()).toBe("2026-07-27T08:05:00.000Z");
  });

  it("cancels pending delivery when a task leaves reminder eligibility and restores it on reopen", async () => {
    const store = new MemoryTaskStore();
    const service = new TaskService(store);
    let task = (await service.create(exact("Prepare slides", "18:00", "19:00"))).task;

    task = await service.cancel(task.id, task.version);
    expect(store.reminderJobs.every((job) => job.status === "cancelled")).toBe(true);

    task = (await service.reopen(task.id, task.version, "reject")).task;
    expect(store.reminderJobs.every((job) => job.status === "pending" && job.scheduleRevision === task.scheduleRevision)).toBe(true);

    task = await service.start(task.id, task.version);
    expect(store.reminderJobs.every((job) => job.status === "cancelled")).toBe(true);
  });

  it("does not schedule reminders for unscheduled or daypart tasks", async () => {
    const store = new MemoryTaskStore();
    const service = new TaskService(store);
    await service.create(unscheduled());
    await service.create(taskInputSchema.parse({ title: "Morning note", scheduleKind: "daypart", localDate: "2026-07-27", daypart: "morning" }));
    expect(store.reminderJobs).toHaveLength(0);
  });
});

describe("TaskService conflict semantics", () => {
  it("allows touching boundaries and atomically accepts every current overlap", async () => {
    const store = new MemoryTaskStore();
    const service = new TaskService(store);
    await service.create(exact("First", "09:00", "10:00"));
    await service.create(exact("Second", "10:00", "11:00"));

    const conflict = await rejectedConflict(service.create(exact("Bridge", "09:30", "10:30")));
    expect(conflict.conflicts).toHaveLength(2);
    const bridge = await service.create(exact("Bridge", "09:30", "10:30", {
      decision: "keep",
      fingerprint: conflict.conflictSetFingerprint
    }));
    expect(bridge.task.title).toBe("Bridge");
    expect(store.acceptances).toHaveLength(2);
    expect((await service.list("2026-07-27")).blockingConflicts).toHaveLength(2);
    expect((await service.list("2026-07-27")).blockingConflicts.every((pair) => pair.accepted)).toBe(true);
  });

  it("returns closed overlaps as historical warnings instead of blocking", async () => {
    const service = new TaskService(new MemoryTaskStore());
    let first = (await service.create(exact("Past", "09:00", "10:00"))).task;
    first = (await service.recordOutcome(first.id, {
      expectedVersion: first.version, outcome: "complete", progressPercent: 100, source: "app"
    })).task;
    const current = await service.create(exact("Current", "09:30", "10:30"));
    expect(current.historicalOverlaps.map((overlap) => overlap.taskId)).toContain(first.id);
    const listed = await service.list("2026-07-27");
    expect(listed.blockingConflicts).toHaveLength(0);
    expect(listed.historicalOverlaps).toHaveLength(1);
  });

  it("rejects stale conflict fingerprints without writing acceptances", async () => {
    const store = new MemoryTaskStore();
    const service = new TaskService(store);
    await service.create(exact("Existing", "09:00", "10:00"));
    const conflict = await rejectedConflict(service.create(exact("Incoming", "09:30", "10:30")));
    await service.create(exact("Changed set", "10:00", "11:00"));
    await expect(service.create(exact("Incoming", "09:30", "10:30", {
      decision: "keep", fingerprint: conflict.conflictSetFingerprint
    }))).rejects.toBeInstanceOf(ConflictSetChangedError);
    expect(store.acceptances).toHaveLength(0);
  });

  it("rolls back all acceptance and task writes when batch insertion fails", async () => {
    class FailingAcceptanceStore extends MemoryTaskStore {
      override async insertConflictAcceptances(records: ConflictAcceptanceRecord[]): Promise<void> {
        await super.insertConflictAcceptances(records.slice(0, 1));
        throw new Error("acceptance write failed");
      }
    }
    const store = new FailingAcceptanceStore();
    const service = new TaskService(store);
    await service.create(exact("First", "09:00", "10:00"));
    await service.create(exact("Second", "10:00", "11:00"));
    const conflict = await rejectedConflict(service.create(exact("Bridge", "09:30", "10:30")));
    await expect(service.create(exact("Bridge", "09:30", "10:30", {
      decision: "keep", fingerprint: conflict.conflictSetFingerprint
    }))).rejects.toThrow("acceptance write failed");
    expect(store.tasks.map((task) => task.title)).toEqual(["First", "Second"]);
    expect(store.acceptances).toHaveLength(0);
  });
});

describe("TaskService serializable retries", () => {
  it("re-runs and rolls back the complete transaction after PostgreSQL 40001", async () => {
    const store = new MemoryTaskStore();
    store.serializationFailuresRemaining = 2;
    const service = new TaskService(store);
    await service.create(unscheduled("Retried"));
    expect(store.transactionAttempts).toBe(3);
    expect(store.tasks).toHaveLength(1);
    expect(store.lifecycleEvents).toHaveLength(1);
  });

  it("stops after three serialization failures", async () => {
    const store = new MemoryTaskStore();
    store.serializationFailuresRemaining = 3;
    await expect(new TaskService(store).create(unscheduled())).rejects.toMatchObject({ code: "40001" });
    expect(store.transactionAttempts).toBe(3);
    expect(store.tasks).toHaveLength(0);
  });
});

describe("TaskService inbox conversion", () => {
  it("retains the inbox entry and creates one linked task atomically", async () => {
    const store = new MemoryTaskStore();
    const service = new TaskService(store);
    const entry = await service.createInbox("idea", "Write a paper");
    const converted = await service.convertInbox(entry.id, entry.version, unscheduled("Write a paper"));
    expect(converted.entry.convertedAt).toBeInstanceOf(Date);
    expect(converted.task.sourceInboxEntryId).toBe(entry.id);
    expect(store.inboxEntries).toHaveLength(1);
    await expect(service.convertInbox(entry.id, entry.version, unscheduled())).rejects.toBeInstanceOf(InboxEntryConflictError);
    expect(store.tasks).toHaveLength(1);
  });

  it("rolls back the linked task when the inbox update cannot be committed", async () => {
    class FailingConversionStore extends MemoryTaskStore {
      override async markInboxConverted(): Promise<null> {
        return null;
      }
    }
    const store = new FailingConversionStore();
    const service = new TaskService(store);
    const entry = await service.createInbox("question", "Should this become a task?");
    await expect(service.convertInbox(entry.id, entry.version, unscheduled("Investigate")))
      .rejects.toBeInstanceOf(InboxEntryConflictError);
    expect(store.tasks).toHaveLength(0);
    expect(store.lifecycleEvents).toHaveLength(0);
    expect(store.inboxEntries[0]).toMatchObject({ id: entry.id, convertedAt: null, version: 1 });
  });
});
