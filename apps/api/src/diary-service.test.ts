import { describe, expect, it } from "vitest";
import { buildDiaryDayData } from "./diary-service.js";

const task = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, title: `task-${id}`, sourceInboxEntryId: null, lifecycleStatus: "open", scheduleKind: "none", currentOutcome: null,
  localDate: "2026-07-30", daypart: null, startAt: null, endAt: null, timeZone: "Asia/Shanghai",
  notes: null,
  version: 1, scheduleRevision: 1, deletedAt: null, createdAt: new Date("2026-07-30T01:00:00Z"), updatedAt: new Date("2026-07-30T01:00:00Z"),
  ...overrides
});

const session = (id: string, taskId: string, rawActiveSeconds: number, effectiveFocusSeconds: number) => ({
  id, taskId, state: "evaluated", plannedStartAt: null, remindedAt: null, preparingEndsAt: null, startedAt: null,
  activeSinceAt: null, pausedAt: null, endedAt: new Date("2026-07-30T02:00:00Z"), stoppedReason: null,
  rawActiveSeconds, effectiveFocusSeconds, version: 1, createdAt: new Date("2026-07-30T01:00:00Z"), updatedAt: new Date("2026-07-30T02:00:00Z")
});

const outcome = (id: string, taskId: string, value: "partial" | "complete", recordedAt: string) => ({
  id, taskId, focusSessionId: null, outcome: value, progressPercent: value === "complete" ? 100 : 50,
  source: "app", note: null, recordedAt: new Date(recordedAt)
});

describe("buildDiaryDayData", () => {
  it("derives focus, latest outcomes, state tone, radar and tree from persisted rows", () => {
    const result = buildDiaryDayData(
      [task("a", { lifecycleStatus: "closed" }), task("b", { lifecycleStatus: "cancelled" })] as never,
      [session("s1", "a", 4200, 3600)] as never,
      [outcome("o1", "a", "partial", "2026-07-30T02:00:00Z"), outcome("o2", "a", "complete", "2026-07-30T03:00:00Z")] as never,
      [{ id: "f1", taskId: "a", focusSessionId: "s1", satisfaction: "satisfied", note: null, createdAt: new Date() }] as never,
      true
    );

    expect(result).toMatchObject({ plannedTasks: 1, closedTasks: 1, rawFocusMinutes: 70, effectiveFocusMinutes: 60, stateTone: "bright" });
    expect(result.tasks[0]).toMatchObject({ focusMinutes: 60, rawFocusMinutes: 70, latestOutcome: "complete" });
    expect(result.tree).toMatchObject({ kind: "常青树", quality: 100, points: 100 });
    expect(result.radar.find((metric) => metric.key === "reflection")?.value).toBe(100);
  });

  it("returns a quiet seed state when the day has no activity", () => {
    const result = buildDiaryDayData([], [], [], [], false);
    expect(result).toMatchObject({ stateTone: "quiet", plannedTasks: 0, effectiveFocusMinutes: 0, tree: { kind: "种子", points: 0, quality: 0 } });
  });
});
