import { describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "@personal-ai/db/client";
import { ReminderWorker, reminderLeaseExpiredBefore, reminderRetryAt, type ReminderDeliveryProvider, type ReminderJob } from "./worker-core.js";

const now = new Date("2026-07-29T01:45:00.000Z");
const job: ReminderJob = {
  id: "job-1", taskId: "task-1", channel: "feishu", kind: "task_start", attempts: 1,
  scheduleRevision: 4, scheduledAt: new Date("2026-07-29T02:00:00.000Z"), payload: {}
};

describe("ReminderWorker", () => {
  it("normalizes PostgreSQL string timestamps before delivery", async () => {
    const stringJob = { ...job, scheduledAt: job.scheduledAt.toISOString() };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [stringJob] })
      .mockResolvedValueOnce({ rows: [{
        scheduleRevision: 4, lifecycleStatus: "open", scheduleKind: "exact",
        startAt: job.scheduledAt.toISOString(), endAt: "2026-07-29T03:00:00.000Z", deletedAt: null
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const provider: ReminderDeliveryProvider = { deliver: vi.fn().mockResolvedValue(undefined) };
    const worker = new ReminderWorker({ execute } as unknown as AppDatabase);

    await expect(worker.processNext(provider, now)).resolves.toBe("sent");
    expect(provider.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledAt: job.scheduledAt }),
      { now, timing: "upcoming" }
    );
  });

  it("uses an absolute retry timestamp exactly one minute later", () => {
    expect(reminderRetryAt(now)).toEqual(new Date("2026-07-29T01:46:00.000Z"));
  });

  it("reclaims processing jobs only after the five-minute lease expires", () => {
    expect(reminderLeaseExpiredBefore(now)).toEqual(new Date("2026-07-29T01:40:00.000Z"));
  });

  it("delivers and marks sent only after the current task contract is verified", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [job] })
      .mockResolvedValueOnce({ rows: [{
        scheduleRevision: 4, lifecycleStatus: "open", scheduleKind: "exact",
        startAt: job.scheduledAt, endAt: new Date("2026-07-29T03:00:00.000Z"), deletedAt: null
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const provider: ReminderDeliveryProvider = { deliver: vi.fn().mockResolvedValue(undefined) };
    const worker = new ReminderWorker({ execute } as unknown as AppDatabase);

    await expect(worker.processNext(provider, now)).resolves.toBe("sent");
    expect(provider.deliver).toHaveBeenCalledWith(job, { now, timing: "upcoming" });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("marks a delayed but still active reminder as in progress", async () => {
    const delayedNow = new Date("2026-07-29T02:44:00.000Z");
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [job] })
      .mockResolvedValueOnce({ rows: [{
        scheduleRevision: 4, lifecycleStatus: "open", scheduleKind: "exact",
        startAt: job.scheduledAt, endAt: new Date("2026-07-29T03:00:00.000Z"), deletedAt: null
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const provider: ReminderDeliveryProvider = { deliver: vi.fn().mockResolvedValue(undefined) };
    const worker = new ReminderWorker({ execute } as unknown as AppDatabase);

    await expect(worker.processNext(provider, delayedNow)).resolves.toBe("sent");
    expect(provider.deliver).toHaveBeenCalledWith(job, { now: delayedNow, timing: "in_progress" });
  });

  it("cancels a stale schedule revision without contacting Feishu", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [job] })
      .mockResolvedValueOnce({ rows: [{
        scheduleRevision: 5, lifecycleStatus: "open", scheduleKind: "exact",
        startAt: job.scheduledAt, endAt: new Date("2026-07-29T03:00:00.000Z"), deletedAt: null
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const provider: ReminderDeliveryProvider = { deliver: vi.fn() };
    const worker = new ReminderWorker({ execute } as unknown as AppDatabase);

    await expect(worker.processNext(provider, now)).resolves.toBe("cancelled");
    expect(provider.deliver).not.toHaveBeenCalled();
  });

  it("cancels an overdue reminder after the task has already ended", async () => {
    const endedNow = new Date("2026-07-29T03:01:00.000Z");
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [job] })
      .mockResolvedValueOnce({ rows: [{
        scheduleRevision: 4, lifecycleStatus: "open", scheduleKind: "exact",
        startAt: job.scheduledAt, endAt: new Date("2026-07-29T03:00:00.000Z"), deletedAt: null
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const provider: ReminderDeliveryProvider = { deliver: vi.fn() };
    const worker = new ReminderWorker({ execute } as unknown as AppDatabase);

    await expect(worker.processNext(provider, endedNow)).resolves.toBe("cancelled");
    expect(provider.deliver).not.toHaveBeenCalled();
  });

  it("records one durable not-completed outcome when the task start has no response for five minutes", async () => {
    const followUpNow = new Date("2026-07-29T02:05:00.000Z");
    const followUpJob: ReminderJob = { ...job, id: "job-follow-up", kind: "task_follow_up" };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [followUpJob] })
      .mockResolvedValueOnce({ rows: [{
        scheduleRevision: 4, lifecycleStatus: "open", scheduleKind: "exact",
        startAt: followUpJob.scheduledAt, endAt: new Date("2026-07-29T03:00:00.000Z"), deletedAt: null
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: "task-1", startAt: followUpJob.scheduledAt, endAt: new Date("2026-07-29T03:00:00.000Z")
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "session-no-response" }] })
      .mockResolvedValueOnce({ rows: [{ id: "task-1", lifecycleStatus: "open", version: 6 }] })
      .mockResolvedValueOnce({ rows: [{ id: "task-1" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const database = {
      execute,
      transaction: async (callback: (db: unknown) => unknown) => callback({ execute })
    } as unknown as AppDatabase;
    const provider: ReminderDeliveryProvider = { deliver: vi.fn() };
    const worker = new ReminderWorker(database);

    await expect(worker.processNext(provider, followUpNow)).resolves.toBe("sent");
    expect(provider.deliver).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(10);
  });
});
