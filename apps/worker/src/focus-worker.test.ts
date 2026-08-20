import { describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "@personal-ai/db/client";
import { FocusTimerWorker, focusTimerLeaseExpiredBefore, type FocusTimerJob } from "./focus-worker.js";

const now = new Date("2026-07-29T02:00:00.000Z");

function queryText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(queryText).join(" ");
  if (!value || typeof value !== "object") return "";
  const record = value as { value?: unknown; queryChunks?: unknown };
  return `${queryText(record.value)} ${queryText(record.queryChunks)}`;
}

describe("FocusTimerWorker", () => {
  it("reclaims processing timer jobs only after the five-minute lease expires", () => {
    expect(focusTimerLeaseExpiredBefore(now)).toEqual(new Date("2026-07-29T01:55:00.000Z"));
  });

  it("reconciles an overdue running session into outcome review even when its final timer job is missing", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "session-overdue", taskId: "task-overdue", state: "running", version: 4,
        startedAt: new Date("2026-07-29T01:30:00.000Z"), activeSinceAt: new Date("2026-07-29T01:55:00.000Z"),
        plannedEndAt: now, rawActiveSeconds: 25 * 60, focusStructureId: "structure-overdue", currentSegmentPosition: 1
      }] })
      .mockResolvedValueOnce({ rows: [{ startedAt: new Date("2026-07-29T01:55:00.000Z"), elapsedSeconds: 0, plannedDurationSeconds: 5 * 60 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ focusSeconds: 25 * 60 }] })
      .mockResolvedValueOnce({ rows: [{ id: "session-overdue", version: 5 }] })
      .mockResolvedValueOnce({ rows: [{ id: "task-overdue" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ desktopFocusEnabled: true, focusEvaluationEnabled: true }] })
      .mockResolvedValueOnce({ rows: [] });
    const worker = new FocusTimerWorker({ execute, transaction: async (callback: (db: unknown) => unknown) => callback({ execute }) } as unknown as AppDatabase);

    await expect(worker.reconcileOverdueSession(now)).resolves.toBe(true);
    expect(execute).toHaveBeenCalledTimes(8);
    expect(queryText(execute.mock.calls[4]?.[0])).toContain("state = 'ended'");
    expect(queryText(execute.mock.calls[5]?.[0])).toContain("lifecycle_status = 'awaiting_outcome'");
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
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "session-2" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const worker = new FocusTimerWorker({ execute, transaction: async (callback: (db: unknown) => unknown) => callback({ execute }) } as unknown as AppDatabase);
    await expect(worker.processNext(now)).resolves.toBe("completed");
    expect(execute).toHaveBeenCalledTimes(8);
  });

  it("refuses to start a second running session", async () => {
    const job: FocusTimerJob = {
      id: "job-blocked", focusSessionId: "session-blocked", kind: "preparation_complete",
      expectedSessionVersion: 2, dueAt: now, attempts: 1
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [job] })
      .mockResolvedValueOnce({ rows: [{ id: "session-blocked", taskId: "task-blocked", state: "armed", version: 2, focusStructureId: null }] })
      .mockResolvedValueOnce({ rows: [{ id: "task-blocked", lifecycleStatus: "open", recordKind: "formal", startAt: now, endAt: new Date("2026-07-29T03:00:00.000Z") }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "another-running-session" }] })
      .mockResolvedValueOnce({ rows: [] });
    const worker = new FocusTimerWorker({ execute, transaction: async (callback: (db: unknown) => unknown) => callback({ execute }) } as unknown as AppDatabase);

    await expect(worker.processNext(now)).resolves.toBe("retry");
    expect(execute).toHaveBeenCalledTimes(6);
    expect(execute.mock.calls.map((call) => queryText(call[0])).join("\n")).not.toContain("SET state = 'running'");
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
      .mockResolvedValueOnce({ rows: [{ id: "job-4" }] });
    const worker = new FocusTimerWorker({ execute, transaction: async (callback: (db: unknown) => unknown) => callback({ execute }) } as unknown as AppDatabase);
    await expect(worker.processNext(now)).resolves.toBe("completed");
    expect(execute).toHaveBeenCalledTimes(9);
    expect(execute.mock.calls.some((call) => queryText(call[0]).includes("state = 'ended'"))).toBe(false);
    expect(execute.mock.calls.some((call) => queryText(call[0]).includes("lifecycle_status = 'awaiting_outcome'"))).toBe(false);
    expect(queryText(execute.mock.calls[8]?.[0])).toContain("SET expected_session_version");
    expect(queryText(execute.mock.calls[8]?.[0])).toContain("status = 'pending'");
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
      .mockResolvedValueOnce({ rows: [{ startedAt: new Date("2026-07-29T01:55:00.000Z"), elapsedSeconds: 0, plannedDurationSeconds: 5 * 60 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ focusSeconds: 55 * 60 }] })
      .mockResolvedValueOnce({ rows: [{ id: "session-final", version: 8 }] })
      .mockResolvedValueOnce({ rows: [{ id: "task-final" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ desktopFocusEnabled: true, focusEvaluationEnabled: true }] })
      .mockResolvedValueOnce({ rows: [] });
    const worker = new FocusTimerWorker({ execute, transaction: async (callback: (db: unknown) => unknown) => callback({ execute }) } as unknown as AppDatabase);
    await expect(worker.processNext(now)).resolves.toBe("completed");
    expect(execute).toHaveBeenCalledTimes(11);
    expect(queryText(execute.mock.calls[7]?.[0])).toContain("effective_focus_seconds");
    expect(queryText(execute.mock.calls[8]?.[0])).toContain("lifecycle_status = 'awaiting_outcome'");
  });

  it("records focus time without inventing an outcome when evaluation is disabled", async () => {
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
      .mockResolvedValueOnce({ rows: [{ startedAt: new Date("2026-07-29T01:55:00.000Z"), elapsedSeconds: 0, plannedDurationSeconds: 5 * 60 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ focusSeconds: 55 * 60 }] })
      .mockResolvedValueOnce({ rows: [{ id: "session-final-no-evaluation", version: 8 }] })
      .mockResolvedValueOnce({ rows: [{ id: "task-final-no-evaluation" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const worker = new FocusTimerWorker({ execute, transaction: async (callback: (db: unknown) => unknown) => callback({ execute }) } as unknown as AppDatabase);

    await expect(worker.processNext(now)).resolves.toBe("completed");
    expect(execute).toHaveBeenCalledTimes(11);
  });
});
