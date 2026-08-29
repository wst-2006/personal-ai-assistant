import { describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "@personal-ai/db/client";
import { ReminderWorker, reminderLeaseExpiredBefore, reminderRetryAt, type ReminderDeliveryProvider, type ReminderJob } from "./worker-core.js";

const now = new Date("2026-07-29T01:45:00.000Z");
const job: ReminderJob = {
  id: "job-1", taskId: "task-1", channel: "feishu", kind: "task_start", attempts: 1,
  scheduleRevision: 4, scheduledAt: new Date("2026-07-29T02:00:00.000Z"), payload: {}
};

const enabledSettings = {
  desktopFocusEnabled: true,
  feishuTaskCardsEnabled: true,
  feishuT15Enabled: true,
};

describe("ReminderWorker", () => {
  it("normalizes PostgreSQL string timestamps before delivery", async () => {
    const stringJob = { ...job, scheduledAt: job.scheduledAt.toISOString() };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [stringJob] })
      .mockResolvedValueOnce({ rows: [{
        scheduleRevision: 4, lifecycleStatus: "open", scheduleKind: "exact",
        recordKind: "formal", startAt: job.scheduledAt.toISOString(), endAt: "2026-07-29T03:00:00.000Z", deletedAt: null
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const provider: ReminderDeliveryProvider = { deliver: vi.fn().mockResolvedValue({ remoteMessageId: "om_initial" }) };
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
        recordKind: "formal", startAt: job.scheduledAt, endAt: new Date("2026-07-29T03:00:00.000Z"), deletedAt: null
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const provider: ReminderDeliveryProvider = { deliver: vi.fn().mockResolvedValue({ remoteMessageId: "om_initial" }) };
    const worker = new ReminderWorker({ execute } as unknown as AppDatabase);

    await expect(worker.processNext(provider, now)).resolves.toBe("sent");
    expect(provider.deliver).toHaveBeenCalledWith(job, { now, timing: "upcoming" });
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("marks a delayed but still active reminder as in progress", async () => {
    const delayedNow = new Date("2026-07-29T02:44:00.000Z");
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [job] })
      .mockResolvedValueOnce({ rows: [{
        scheduleRevision: 4, lifecycleStatus: "open", scheduleKind: "exact",
        recordKind: "formal", startAt: job.scheduledAt, endAt: new Date("2026-07-29T03:00:00.000Z"), deletedAt: null
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const provider: ReminderDeliveryProvider = { deliver: vi.fn().mockResolvedValue({ remoteMessageId: "om_initial" }) };
    const worker = new ReminderWorker({ execute } as unknown as AppDatabase);

    await expect(worker.processNext(provider, delayedNow)).resolves.toBe("sent");
    expect(provider.deliver).toHaveBeenCalledWith(job, { now: delayedNow, timing: "in_progress" });
  });

  it("delivers the queued started-card update after desktop confirmation", async () => {
    const startedJob: ReminderJob = {
      ...job,
      id: "job-started-card",
      kind: "task_start_lapsed",
      payload: { cardState: "started" }
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [startedJob] })
      .mockResolvedValueOnce({ rows: [{
        scheduleRevision: 4,
        lifecycleStatus: "active",
        scheduleKind: "exact",
        recordKind: "formal",
        startAt: job.scheduledAt,
        endAt: new Date("2026-07-29T03:00:00.000Z"),
        deletedAt: null
      }] })
      .mockResolvedValueOnce({ rows: [enabledSettings] })
      .mockResolvedValueOnce({ rows: [{ remoteMessageId: "om_initial" }] })
      .mockResolvedValueOnce({ rows: [] });
    const provider: ReminderDeliveryProvider = { deliver: vi.fn().mockResolvedValue({ remoteMessageId: "om_initial" }) };
    const worker = new ReminderWorker({ execute } as unknown as AppDatabase);

    await expect(worker.processNext(provider, now)).resolves.toBe("sent");
    expect(provider.deliver).toHaveBeenCalledWith(startedJob, {
      now,
      timing: "upcoming",
      remoteMessageId: "om_initial"
    });
  });

  it("cancels a stale schedule revision without contacting Feishu", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [job] })
      .mockResolvedValueOnce({ rows: [{
        scheduleRevision: 5, lifecycleStatus: "open", scheduleKind: "exact",
        recordKind: "formal", startAt: job.scheduledAt, endAt: new Date("2026-07-29T03:00:00.000Z"), deletedAt: null
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
        recordKind: "formal", startAt: job.scheduledAt, endAt: new Date("2026-07-29T03:00:00.000Z"), deletedAt: null
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const provider: ReminderDeliveryProvider = { deliver: vi.fn() };
    const worker = new ReminderWorker({ execute } as unknown as AppDatabase);

    await expect(worker.processNext(provider, endedNow)).resolves.toBe("cancelled");
    expect(provider.deliver).not.toHaveBeenCalled();
  });

  it("records one durable not-completed outcome only at the fixed end and updates the original card", async () => {
    const expiryNow = new Date("2026-07-29T03:00:00.000Z");
    const expiryJob: ReminderJob = { ...job, id: "job-expire", kind: "task_start_expire" };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [expiryJob] })
      .mockResolvedValueOnce({ rows: [{
        scheduleRevision: 4, lifecycleStatus: "open", scheduleKind: "exact",
        recordKind: "formal", startAt: expiryJob.scheduledAt, endAt: expiryNow, deletedAt: null
      }] })
      .mockResolvedValueOnce({ rows: [enabledSettings] })
      .mockResolvedValueOnce({ rows: [{
        id: "task-1", startAt: expiryJob.scheduledAt, endAt: expiryNow
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "session-no-response" }] })
      .mockResolvedValueOnce({ rows: [{ id: "task-1", lifecycleStatus: "open", version: 6 }] })
      .mockResolvedValueOnce({ rows: [{ id: "task-1" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ remoteMessageId: "om_initial" }] })
      .mockResolvedValueOnce({ rows: [] });
    const database = {
      execute,
      transaction: async (callback: (db: unknown) => unknown) => callback({ execute })
    } as unknown as AppDatabase;
    const provider: ReminderDeliveryProvider = { deliver: vi.fn().mockResolvedValue({ remoteMessageId: "om_initial" }) };
    const worker = new ReminderWorker(database);

    await expect(worker.processNext(provider, expiryNow)).resolves.toBe("sent");
    expect(provider.deliver).toHaveBeenCalledWith(expiryJob, {
      now: expiryNow,
      timing: "in_progress",
      remoteMessageId: "om_initial"
    });
    expect(execute).toHaveBeenCalledTimes(12);
  });

  it("cancels T-15 delivery while keeping the T-1 confirmation path available", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [job] })
      .mockResolvedValueOnce({ rows: [{
        scheduleRevision: 4, lifecycleStatus: "open", scheduleKind: "exact",
        recordKind: "formal", startAt: job.scheduledAt, endAt: new Date("2026-07-29T03:00:00.000Z"), deletedAt: null
      }] })
      .mockResolvedValueOnce({ rows: [{ ...enabledSettings, feishuT15Enabled: false }] })
      .mockResolvedValueOnce({ rows: [] });
    const provider: ReminderDeliveryProvider = { deliver: vi.fn() };
    const worker = new ReminderWorker({ execute } as unknown as AppDatabase);

    await expect(worker.processNext(provider, now)).resolves.toBe("cancelled");
    expect(provider.deliver).not.toHaveBeenCalled();
  });

  it("advances desktop preparation without sending a card when Feishu task cards are disabled", async () => {
    const readyJob: ReminderJob = { ...job, id: "job-ready-desktop-only", kind: "task_start_ready" };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [readyJob] })
      .mockResolvedValueOnce({ rows: [{
        scheduleRevision: 4, lifecycleStatus: "open", scheduleKind: "exact",
        recordKind: "formal", startAt: job.scheduledAt, endAt: new Date("2026-07-29T03:00:00.000Z"), deletedAt: null
      }] })
      .mockResolvedValueOnce({ rows: [{ ...enabledSettings, feishuTaskCardsEnabled: false }] })
      .mockResolvedValueOnce({ rows: [{
        id: "task-1",
        startAt: job.scheduledAt,
        endAt: new Date("2026-07-29T03:00:00.000Z"),
        scheduleRevision: 4,
      }] })
      .mockResolvedValueOnce({ rows: [{ id: "existing-preparation-session" }] })
      .mockResolvedValueOnce({ rows: [] });
    const database = {
      execute,
      transaction: async (callback: (db: unknown) => unknown) => callback({ execute })
    } as unknown as AppDatabase;
    const provider: ReminderDeliveryProvider = { deliver: vi.fn() };
    const worker = new ReminderWorker(database);

    await expect(worker.processNext(provider, now)).resolves.toBe("sent");
    expect(provider.deliver).not.toHaveBeenCalled();
  });

  it("creates desktop preparation even when the Feishu provider is unavailable", async () => {
    const readyJob: ReminderJob = { ...job, id: "job-ready-no-provider", kind: "task_start_ready" };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [readyJob] })
      .mockResolvedValueOnce({ rows: [{
        scheduleRevision: 4, lifecycleStatus: "open", scheduleKind: "exact",
        recordKind: "formal", startAt: job.scheduledAt, endAt: new Date("2026-07-29T03:00:00.000Z"), deletedAt: null
      }] })
      .mockResolvedValueOnce({ rows: [enabledSettings] })
      .mockResolvedValueOnce({ rows: [{
        id: "task-1", startAt: job.scheduledAt, endAt: new Date("2026-07-29T03:00:00.000Z"), scheduleRevision: 4
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: "structure-1", version: 1, taskScheduleRevision: 4, totalStartAt: job.scheduledAt
      }] })
      .mockResolvedValueOnce({ rows: [{ position: 0, segmentType: "focus", durationMinutes: 55 }, { position: 1, segmentType: "break", durationMinutes: 5 }] })
      .mockResolvedValueOnce({ rows: [{ id: "session-preparing" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const database = {
      execute,
      transaction: async (callback: (db: unknown) => unknown) => callback({ execute })
    } as unknown as AppDatabase;
    const worker = new ReminderWorker(database);

    await expect(worker.processNext(null, now)).resolves.toBe("retry");
    expect(execute).toHaveBeenCalledTimes(12);
  });

  it("cancels the complete focus pipeline in memo mode", async () => {
    const readyJob: ReminderJob = { ...job, id: "job-ready-memo", kind: "task_start_ready" };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [readyJob] })
      .mockResolvedValueOnce({ rows: [{
        scheduleRevision: 4, lifecycleStatus: "open", scheduleKind: "exact",
        recordKind: "formal", startAt: job.scheduledAt, endAt: new Date("2026-07-29T03:00:00.000Z"), deletedAt: null
      }] })
      .mockResolvedValueOnce({ rows: [{
        desktopFocusEnabled: false,
        feishuTaskCardsEnabled: false,
        feishuT15Enabled: false,
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const provider: ReminderDeliveryProvider = { deliver: vi.fn() };
    const worker = new ReminderWorker({ execute } as unknown as AppDatabase);

    await expect(worker.processNext(provider, now)).resolves.toBe("cancelled");
    expect(provider.deliver).not.toHaveBeenCalled();
  });
});
