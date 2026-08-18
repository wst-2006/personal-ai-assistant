import { describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "@personal-ai/db/client";
import { FocusTimerWorker, focusTimerLeaseExpiredBefore, type FocusTimerJob } from "./focus-worker.js";

const now = new Date("2026-07-29T02:00:00.000Z");

describe("FocusTimerWorker", () => {
  it("reclaims processing timer jobs only after the five-minute lease expires", () => {
    expect(focusTimerLeaseExpiredBefore(now)).toEqual(new Date("2026-07-29T01:55:00.000Z"));
  });

  it("moves a scheduled session into preparation one minute before the fixed start", async () => {
    const preparationNow = new Date("2026-07-29T01:59:00.000Z");
    const job: FocusTimerJob = {
      id: "job-scheduled", focusSessionId: "session-scheduled", kind: "preparation_start",
      expectedSessionVersion: 1, dueAt: preparationNow, attempts: 1
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [job] })
      .mockResolvedValueOnce({ rows: [{ id: "session-scheduled", taskId: "task-scheduled", state: "scheduled", version: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: "task-scheduled", lifecycleStatus: "open", recordKind: "formal", startAt: now, endAt: new Date("2026-07-29T04:00:00.000Z"), scheduleRevision: 3 }] })
      .mockResolvedValueOnce({ rows: [{ id: "structure-scheduled", version: 2, taskScheduleRevision: 3, totalStartAt: now }] })
      .mockResolvedValueOnce({ rows: [
        { position: 0, segmentType: "focus", durationMinutes: 55 },
        { position: 1, segmentType: "break", durationMinutes: 5 }
      ] })
      .mockResolvedValueOnce({ rows: [{ id: "session-scheduled" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const worker = new FocusTimerWorker({ execute, transaction: async (callback: (db: unknown) => unknown) => callback({ execute }) } as unknown as AppDatabase);
    await expect(worker.processNext(preparationNow)).resolves.toBe("completed");
    expect(execute).toHaveBeenCalledTimes(11);
  });

  it("moves an unconfirmed task into late-start waiting without recording failure", async () => {
    const job: FocusTimerJob = {
      id: "job-1", focusSessionId: "session-1", kind: "confirmation_timeout",
      expectedSessionVersion: 1, dueAt: now, attempts: 1
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [job] })
      .mockResolvedValueOnce({ rows: [{ id: "session-1", taskId: "task-1", state: "reminded", version: 1, startedAt: null, activeSinceAt: null }] })
      .mockResolvedValueOnce({ rows: [{ id: "session-1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "task-1", lifecycleStatus: "open", version: 4 }] })
      .mockResolvedValueOnce({ rows: [{ id: "task-1" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const worker = new FocusTimerWorker({ execute, transaction: async (callback: (db: unknown) => unknown) => callback({ execute }) } as unknown as AppDatabase);
    await expect(worker.processNext(now)).resolves.toBe("completed");
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("starts only an explicitly armed session and activates its task", async () => {
    const job: FocusTimerJob = {
      id: "job-2", focusSessionId: "session-2", kind: "preparation_complete",
      expectedSessionVersion: 2, dueAt: now, attempts: 1
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [job] })
      .mockResolvedValueOnce({ rows: [{ id: "session-2", taskId: "task-2", state: "armed", version: 2, startedAt: null, activeSinceAt: null, focusStructureId: null }] })
      .mockResolvedValueOnce({ rows: [{ id: "task-2", lifecycleStatus: "open", recordKind: "formal", startAt: now, endAt: new Date("2026-07-29T03:00:00.000Z") }] })
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
      .mockResolvedValueOnce({ rows: [{ startedAt: new Date("2026-07-29T01:00:00.000Z"), plannedDurationSeconds: 55 * 60 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "session-4" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const worker = new FocusTimerWorker({ execute, transaction: async (callback: (db: unknown) => unknown) => callback({ execute }) } as unknown as AppDatabase);
    await expect(worker.processNext(now)).resolves.toBe("completed");
    expect(execute).toHaveBeenCalledTimes(10);
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
      .mockResolvedValueOnce({ rows: [{ startedAt: new Date("2026-07-29T01:55:00.000Z"), plannedDurationSeconds: 5 * 60 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ focusSeconds: 55 * 60 }] })
      .mockResolvedValueOnce({ rows: [{ id: "session-final" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const worker = new FocusTimerWorker({ execute, transaction: async (callback: (db: unknown) => unknown) => callback({ execute }) } as unknown as AppDatabase);
    await expect(worker.processNext(now)).resolves.toBe("completed");
    expect(execute).toHaveBeenCalledTimes(11);
  });

  it("closes the task objectively without subjective feedback when evaluation is disabled", async () => {
    const job: FocusTimerJob = {
      id: "job-final-no-evaluation", focusSessionId: "session-final-no-evaluation", kind: "segment_transition",
      expectedSessionVersion: 7, dueAt: now, attempts: 1
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [job] })
      .mockResolvedValueOnce({ rows: [{ id: "session-final-no-evaluation", taskId: "task-final-no-evaluation", state: "running", version: 7,
        startedAt: new Date("2026-07-29T01:00:00.000Z"), activeSinceAt: new Date("2026-07-29T01:00:00.000Z"),
        plannedEndAt: new Date("2026-07-29T02:00:00.000Z"), rawActiveSeconds: 0,
        focusStructureId: "structure-final-no-evaluation", currentSegmentPosition: 1 }] })
      .mockResolvedValueOnce({ rows: [{ totalStartAt: new Date("2026-07-29T01:00:00.000Z") }] })
      .mockResolvedValueOnce({ rows: [{ position: 0, segmentType: "focus", durationMinutes: 55 }, { position: 1, segmentType: "break", durationMinutes: 5 }] })
      .mockResolvedValueOnce({ rows: [{ startedAt: new Date("2026-07-29T01:55:00.000Z"), plannedDurationSeconds: 5 * 60 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ focusSeconds: 55 * 60 }] })
      .mockResolvedValueOnce({ rows: [{ id: "session-final-no-evaluation", version: 8 }] })
      .mockResolvedValueOnce({ rows: [{ id: "task-final-no-evaluation" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ desktopFocusEnabled: true, focusEvaluationEnabled: false }] })
      .mockResolvedValueOnce({ rows: [{ id: "session-final-no-evaluation" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "task-final-no-evaluation" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const worker = new FocusTimerWorker({ execute, transaction: async (callback: (db: unknown) => unknown) => callback({ execute }) } as unknown as AppDatabase);

    await expect(worker.processNext(now)).resolves.toBe("completed");
    expect(execute).toHaveBeenCalledTimes(16);
  });
});
