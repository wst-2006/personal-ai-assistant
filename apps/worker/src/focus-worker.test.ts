import { describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "@personal-ai/db/client";
import { FocusTimerWorker, type FocusTimerJob } from "./focus-worker.js";

const now = new Date("2026-07-29T02:00:00.000Z");

describe("FocusTimerWorker", () => {
  it("stops an unanswered reminder exactly once", async () => {
    const job: FocusTimerJob = {
      id: "job-1", focusSessionId: "session-1", kind: "confirmation_timeout",
      expectedSessionVersion: 1, dueAt: now, attempts: 1
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [job] })
      .mockResolvedValueOnce({ rows: [{ id: "session-1", taskId: "task-1", state: "reminded", version: 1, startedAt: null, activeSinceAt: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const worker = new FocusTimerWorker({ execute, transaction: async (callback: (db: unknown) => unknown) => callback({ execute }) } as unknown as AppDatabase);
    await expect(worker.processNext(now)).resolves.toBe("completed");
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("starts a prepared session and activates its task", async () => {
    const job: FocusTimerJob = {
      id: "job-2", focusSessionId: "session-2", kind: "preparation_complete",
      expectedSessionVersion: 2, dueAt: now, attempts: 1
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [job] })
      .mockResolvedValueOnce({ rows: [{ id: "session-2", taskId: "task-2", state: "preparing", version: 2, startedAt: null, activeSinceAt: null }] })
      .mockResolvedValueOnce({ rows: [{ id: "task-2", lifecycleStatus: "open", endAt: new Date("2026-07-29T03:00:00.000Z") }] })
      .mockResolvedValueOnce({ rows: [{ id: "session-2" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const worker = new FocusTimerWorker({ execute, transaction: async (callback: (db: unknown) => unknown) => callback({ execute }) } as unknown as AppDatabase);
    await expect(worker.processNext(now)).resolves.toBe("completed");
    expect(execute).toHaveBeenCalledTimes(6);
  });

  it("cancels stale jobs without mutating a newer session", async () => {
    const job: FocusTimerJob = {
      id: "job-3", focusSessionId: "session-3", kind: "preparation_complete",
      expectedSessionVersion: 1, dueAt: now, attempts: 1
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [job] })
      .mockResolvedValueOnce({ rows: [{ id: "session-3", taskId: "task-3", state: "running", version: 2, startedAt: now, activeSinceAt: now }] })
      .mockResolvedValueOnce({ rows: [] });
    const worker = new FocusTimerWorker({ execute, transaction: async (callback: (db: unknown) => unknown) => callback({ execute }) } as unknown as AppDatabase);
    await expect(worker.processNext(now)).resolves.toBe("cancelled");
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("advances a structure segment and schedules the next boundary", async () => {
    const job: FocusTimerJob = {
      id: "job-4", focusSessionId: "session-4", kind: "segment_transition",
      expectedSessionVersion: 4, dueAt: now, attempts: 1
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [job] })
      .mockResolvedValueOnce({ rows: [{ id: "session-4", taskId: "task-4", state: "running", version: 4, startedAt: new Date("2026-07-29T01:00:00.000Z"), activeSinceAt: new Date("2026-07-29T01:00:00.000Z"), plannedEndAt: new Date("2026-07-29T03:00:00.000Z"), rawActiveSeconds: 0, focusStructureId: "structure-4", currentSegmentPosition: 0 }] })
      .mockResolvedValueOnce({ rows: [{ totalStartAt: new Date("2026-07-29T01:00:00.000Z") }] })
      .mockResolvedValueOnce({ rows: [{ position: 0, segmentType: "focus", durationMinutes: 55 }, { position: 1, segmentType: "break", durationMinutes: 5 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "session-4" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const worker = new FocusTimerWorker({ execute, transaction: async (callback: (db: unknown) => unknown) => callback({ execute }) } as unknown as AppDatabase);
    await expect(worker.processNext(now)).resolves.toBe("completed");
    expect(execute).toHaveBeenCalledTimes(9);
  });

  it("completes the final segment before moving the task to outcome review", async () => {
    const job: FocusTimerJob = {
      id: "job-final", focusSessionId: "session-final", kind: "segment_transition",
      expectedSessionVersion: 7, dueAt: now, attempts: 1
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [job] })
      .mockResolvedValueOnce({ rows: [{ id: "session-final", taskId: "task-final", state: "running", version: 7,
        startedAt: new Date("2026-07-29T01:00:00.000Z"), activeSinceAt: new Date("2026-07-29T01:00:00.000Z"),
        plannedEndAt: new Date("2026-07-29T02:00:00.000Z"), rawActiveSeconds: 0,
        focusStructureId: "structure-final", currentSegmentPosition: 1 }] })
      .mockResolvedValueOnce({ rows: [{ totalStartAt: new Date("2026-07-29T01:00:00.000Z") }] })
      .mockResolvedValueOnce({ rows: [{ position: 0, segmentType: "focus", durationMinutes: 55 }, { position: 1, segmentType: "break", durationMinutes: 5 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "session-final" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const worker = new FocusTimerWorker({ execute, transaction: async (callback: (db: unknown) => unknown) => callback({ execute }) } as unknown as AppDatabase);
    await expect(worker.processNext(now)).resolves.toBe("completed");
    expect(execute).toHaveBeenCalledTimes(9);
  });
});
