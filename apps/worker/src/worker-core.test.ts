import { describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "@personal-ai/db/client";
import { ReminderWorker, type ReminderDeliveryProvider, type ReminderJob } from "./worker-core.js";

const now = new Date("2026-07-29T01:45:00.000Z");
const job: ReminderJob = {
  id: "job-1", taskId: "task-1", channel: "feishu", kind: "task_start", attempts: 1,
  scheduleRevision: 4, scheduledAt: new Date("2026-07-29T02:00:00.000Z"), payload: {}
};

describe("ReminderWorker", () => {
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
    expect(provider.deliver).toHaveBeenCalledWith(job);
    expect(execute).toHaveBeenCalledTimes(3);
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
});
