import { localDateAtTimeZone, taskInputSchema, taskPatchSchema } from "@personal-ai/domain/task";
import { describe, expect, it } from "vitest";
import {
  InboxEntryConflictError,
  InvalidTaskTransitionError,
  TaskNotFoundError,
  TaskScheduleBoundsError,
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
  it("enforces the 07:00-23:00 product scheduling boundary", async () => {
    const service = new TaskService(new MemoryTaskStore());
    await expect(service.create(exact("Too early", "06:30", "07:30"))).rejects.toBeInstanceOf(TaskScheduleBoundsError);
    await expect(service.create(exact("Too late", "22:30", "23:30"))).rejects.toBeInstanceOf(TaskScheduleBoundsError);
    await expect(service.create(exact("Full window", "07:00", "23:00"))).resolves.toMatchObject({ task: { title: "Full window" } });
  });

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

  it("corrects only today's evaluation without reopening the task or changing its schedule revision", async () => {
    const store = new MemoryTaskStore();
    const service = new TaskService(store);
    let task = (await service.create(taskInputSchema.parse({
      title: "Today evaluation correction",
      scheduleKind: "none",
      localDate: localDateAtTimeZone(new Date(), "Asia/Shanghai")
    }))).task;
    const recorded = await service.recordOutcome(task.id, {
      expectedVersion: task.version,
      outcome: "partial",
      progressPercent: 40,
      source: "app",
      satisfaction: "neutral",
      note: "first"
    });
    task = recorded.task;
    const scheduleRevision = task.scheduleRevision;

    const corrected = await service.correctOutcome(task.id, {
      expectedVersion: task.version,
      expectedOutcomeId: recorded.outcome.id,
      outcome: "complete",
      progressPercent: 100,
      source: "app",
      satisfaction: "satisfied",
      note: "corrected"
    });

    expect(corrected.task).toMatchObject({ lifecycleStatus: "closed", currentOutcome: "complete", version: task.version + 1, scheduleRevision });
    const detail = await service.get(task.id);
    expect(detail.outcomes).toHaveLength(2);
    expect(detail.feedback).toHaveLength(2);
    expect(detail.outcomes.map((item) => item.note)).toContain("first");
    expect(detail.outcomes.map((item) => item.note)).toContain("corrected");
  });

  it("rejects evaluation correction for a previous day", async () => {
    const service = new TaskService(new MemoryTaskStore());
    let task = (await service.create(unscheduled("Past evaluation"))).task;
    const recorded = await service.recordOutcome(task.id, {
      expectedVersion: task.version,
      outcome: "complete",
      progressPercent: 100,
      source: "app",
      satisfaction: "satisfied"
    });
    task = recorded.task;

    await expect(service.correctOutcome(task.id, {
      expectedVersion: task.version,
      expectedOutcomeId: recorded.outcome.id,
      outcome: "partial",
      progressPercent: 80,
      source: "app",
      satisfaction: "neutral"
    })).rejects.toBeInstanceOf(InvalidTaskTransitionError);
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

  it("restores a soft-deleted task with a new schedule revision", async () => {
    const store = new MemoryTaskStore();
    const service = new TaskService(store);
    const task = (await service.create(unscheduled("Restore me"))).task;
    await service.softDelete(task.id, task.version);
    const [deleted] = await service.listDeleted("2026-07-27");
    expect(deleted?.deletedAt).toBeInstanceOf(Date);

    const restored = (await service.restore(task.id, deleted!.version, "reject")).task;
    expect(restored).toMatchObject({
      id: task.id,
      deletedAt: null,
      version: deleted!.version + 1,
      scheduleRevision: deleted!.scheduleRevision + 1
    });
    expect(await service.listDeleted("2026-07-27")).toHaveLength(0);
  });

  it("permanently empties only soft-deleted tasks", async () => {
    const store = new MemoryTaskStore();
    const service = new TaskService(store);
    const deleted = (await service.create(unscheduled("Purge me"))).task;
    const kept = (await service.create(unscheduled("Keep me"))).task;
    await service.softDelete(deleted.id, deleted.version);

    await expect(service.emptyTrash()).resolves.toEqual({ purgedCount: 1 });
    await expect(service.get(deleted.id)).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(service.get(kept.id)).resolves.toMatchObject({ task: { id: kept.id, title: "Keep me" } });
    await expect(service.emptyTrash()).resolves.toEqual({ purgedCount: 0 });
  });
});

describe("TaskService reminder scheduling", () => {
  it("creates all four staged reminders and keeps them aligned with task edits", async () => {
    const store = new MemoryTaskStore();
    const service = new TaskService(store);
    const created = (await service.create(exact("Read paper", "14:00", "15:30"))).task;

    expect(store.reminderJobs).toHaveLength(4);
    const startReminder = store.reminderJobs.find((job) => job.kind === "task_start");
    const readyReminder = store.reminderJobs.find((job) => job.kind === "task_start_ready");
    const lapsedReminder = store.reminderJobs.find((job) => job.kind === "task_start_lapsed");
    const expiryReminder = store.reminderJobs.find((job) => job.kind === "task_start_expire");
    expect(startReminder).toMatchObject({
      taskId: created.id,
      scheduleRevision: created.scheduleRevision,
      status: "pending"
    });
    expect(startReminder!.availableAt.toISOString()).toBe("2026-07-27T05:45:00.000Z");
    expect(readyReminder).toMatchObject({
      taskId: created.id,
      scheduleRevision: created.scheduleRevision,
      status: "pending"
    });
    expect(readyReminder!.availableAt.toISOString()).toBe("2026-07-27T05:59:00.000Z");
    expect(lapsedReminder!.availableAt.toISOString()).toBe("2026-07-27T06:00:00.000Z");
    expect(expiryReminder!.availableAt.toISOString()).toBe("2026-07-27T07:30:00.000Z");

    startReminder!.status = "sent";

    const renamed = (await service.update(created.id, taskPatchSchema.parse({
      expectedVersion: created.version,
      title: "Read systems paper"
    }))).task;
    expect(renamed.scheduleRevision).toBe(created.scheduleRevision);
    expect(store.reminderJobs.every((job) => job.payload.title === "Read systems paper")).toBe(true);
    expect(store.reminderJobs.find((job) => job.kind === "task_start")?.status).toBe("sent");

    const moved = (await service.update(created.id, taskPatchSchema.parse({
      expectedVersion: renamed.version,
      expectedScheduleRevision: renamed.scheduleRevision,
      startAt: "2026-07-27T16:00:00+08:00",
      endAt: "2026-07-27T17:30:00+08:00"
    }))).task;
    expect(store.reminderJobs.every((job) => job.scheduleRevision === moved.scheduleRevision && job.status === "pending")).toBe(true);
    expect(store.reminderJobs.find((job) => job.kind === "task_start")!.availableAt.toISOString()).toBe("2026-07-27T07:45:00.000Z");
    expect(store.reminderJobs.find((job) => job.kind === "task_start_ready")!.availableAt.toISOString()).toBe("2026-07-27T07:59:00.000Z");
    expect(store.reminderJobs.find((job) => job.kind === "task_start_lapsed")!.availableAt.toISOString()).toBe("2026-07-27T08:00:00.000Z");
    expect(store.reminderJobs.find((job) => job.kind === "task_start_expire")!.availableAt.toISOString()).toBe("2026-07-27T09:30:00.000Z");
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

  it("previews and applies a confirmed bulk shift in one transaction", async () => {
    const store = new MemoryTaskStore();
    const service = new TaskService(store);
    await service.create(exact("First", "09:00", "10:00"));
    await service.create(exact("Second", "10:00", "11:00"));
    await service.create(unscheduled("No exact time"));

    const preview = await service.previewBulkShift("2026-07-27", 30);
    expect(preview.adjustments.map((item) => [item.title, item.nextStartAt.slice(11, 16)])).toEqual([
      ["First", "01:30"],
      ["Second", "02:30"]
    ]);
    expect(preview.skipped).toEqual([expect.objectContaining({ title: "No exact time" })]);

    const result = await service.bulkShift("2026-07-27", 30, preview.adjustments);
    expect(result.tasks.map((task) => task.scheduleRevision)).toEqual([2, 2]);
    expect(store.tasks.filter((task) => task.scheduleKind === "exact").map((task) => task.startAt?.toISOString().slice(11, 16))).toEqual(["01:30", "02:30"]);
  });

  it("rolls back a bulk shift when one confirmed version is stale", async () => {
    const store = new MemoryTaskStore();
    const service = new TaskService(store);
    const first = (await service.create(exact("First", "09:00", "10:00"))).task;
    await service.create(exact("Second", "10:00", "11:00"));
    const preview = await service.previewBulkShift("2026-07-27", 30);
    await service.update(first.id, taskPatchSchema.parse({ expectedVersion: first.version, title: "Changed" }));

    await expect(service.bulkShift("2026-07-27", 30, preview.adjustments)).rejects.toBeInstanceOf(TaskVersionConflictError);
    expect(store.tasks.filter((task) => task.scheduleKind === "exact").map((task) => task.startAt?.toISOString().slice(11, 16))).toEqual(["01:00", "02:00"]);
  });

  it("rejects a confirmed task that falls outside the previewed date scope", async () => {
    const store = new MemoryTaskStore();
    const service = new TaskService(store);
    const task = (await service.create(taskInputSchema.parse({
      title: "Tomorrow task",
      scheduleKind: "exact",
      startAt: "2026-07-28T09:00:00+08:00",
      endAt: "2026-07-28T10:00:00+08:00",
      timeZone: "Asia/Shanghai"
    }))).task;

    await expect(service.bulkShift("2026-07-27", 30, [{
      taskId: task.id,
      expectedVersion: task.version,
      expectedScheduleRevision: task.scheduleRevision
    }])).rejects.toMatchObject({ skipped: [expect.objectContaining({ reason: "任务不属于已确认的作用日期" })] });
    expect(store.tasks[0]?.startAt?.toISOString()).toBe("2026-07-28T01:00:00.000Z");
  });
});

describe("TaskService conflict semantics", () => {
  it("keeps factual backfill outside formal conflict lanes in both directions", async () => {
    const store = new MemoryTaskStore();
    const service = new TaskService(store);
    await store.insertTask({
      id: "00000000-0000-4000-8000-000000000101",
      title: "Already happened",
      sourceInboxEntryId: null,
      sourceLongRangePlanId: null,
      recordKind: "backfill",
      lifecycleStatus: "closed",
      scheduleKind: "exact",
      currentOutcome: "complete",
      localDate: "2026-07-27",
      daypart: null,
      startAt: new Date("2026-07-27T01:00:00.000Z"),
      endAt: new Date("2026-07-27T02:00:00.000Z"),
      timeZone: "Asia/Shanghai",
      notes: null,
      version: 1,
      scheduleRevision: 1
    });

    const formal = await service.create(exact("Still schedulable", "09:30", "10:30"));
    expect(formal.task.recordKind).toBe("formal");
    expect(formal.historicalOverlaps).toEqual([]);
    expect(store.acceptances).toHaveLength(0);
    const listed = await service.list("2026-07-27");
    expect(listed.blockingConflicts).toEqual([]);
    expect(listed.historicalOverlaps).toEqual([]);
  });

  it("allows touching boundaries but never permits a formal overlap", async () => {
    const store = new MemoryTaskStore();
    const service = new TaskService(store);
    await service.create(exact("First", "09:00", "10:00"));
    await service.create(exact("Second", "10:00", "11:00"));

    const conflict = await rejectedConflict(service.create(exact("Bridge", "09:30", "10:30")));
    expect(conflict.conflicts).toHaveLength(2);
    await expect(service.create(exact("Bridge", "09:30", "10:30", {
      decision: "keep",
      fingerprint: conflict.conflictSetFingerprint
    }))).rejects.toBeInstanceOf(TaskTimeConflictError);
    expect(store.tasks.map((task) => task.title)).toEqual(["First", "Second"]);
    expect(store.acceptances).toHaveLength(0);
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

  it("keeps rejecting an overlap even when an old client submits a conflict fingerprint", async () => {
    const store = new MemoryTaskStore();
    const service = new TaskService(store);
    await service.create(exact("Existing", "09:00", "10:00"));
    const conflict = await rejectedConflict(service.create(exact("Incoming", "09:30", "10:30")));
    await service.create(exact("Changed set", "10:00", "11:00"));
    await expect(service.create(exact("Incoming", "09:30", "10:30", {
      decision: "keep", fingerprint: conflict.conflictSetFingerprint
    }))).rejects.toBeInstanceOf(TaskTimeConflictError);
    expect(store.tasks.map((task) => task.title)).toEqual(["Existing", "Changed set"]);
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
