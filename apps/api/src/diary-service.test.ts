import { describe, expect, it } from "vitest";
import { buildDiaryDayData } from "./diary-service.js";

const task = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, title: `task-${id}`, sourceInboxEntryId: null, sourceLongRangePlanId: null, recordKind: "formal", lifecycleStatus: "open", scheduleKind: "none", currentOutcome: null,
  localDate: "2026-07-30", daypart: null, startAt: null, endAt: null, timeZone: "Asia/Shanghai",
  notes: null,
  version: 1, scheduleRevision: 1, deletedAt: null, createdAt: new Date("2026-07-30T01:00:00Z"), updatedAt: new Date("2026-07-30T01:00:00Z"),
  ...overrides
});

const session = (id: string, taskId: string, rawActiveSeconds: number, effectiveFocusSeconds: number, overrides: Record<string, unknown> = {}) => ({
  id, taskId, state: "evaluated", plannedStartAt: null, remindedAt: null, preparingEndsAt: null, startedAt: null,
  activeSinceAt: null, pausedAt: null, endedAt: new Date("2026-07-30T02:00:00Z"), stoppedReason: null,
  rawActiveSeconds, effectiveFocusSeconds, version: 1, createdAt: new Date("2026-07-30T01:00:00Z"), updatedAt: new Date("2026-07-30T02:00:00Z"),
  ...overrides
});

const outcome = (id: string, taskId: string, value: "partial" | "complete", recordedAt: string) => ({
  id, taskId, focusSessionId: null, outcome: value, progressPercent: value === "complete" ? 100 : 50,
  source: "app", note: null, recordedAt: new Date(recordedAt)
});

describe("buildDiaryDayData", () => {
  it("derives focus, latest outcomes, state tone, radar and tree from persisted rows", () => {
    const result = buildDiaryDayData(
      [task("a", { lifecycleStatus: "closed", sourceLongRangePlanId: "plan-a" }), task("b", { lifecycleStatus: "cancelled" })] as never,
      [session("s1", "a", 4200, 3600)] as never,
      [outcome("o1", "a", "partial", "2026-07-30T02:00:00Z"), outcome("o2", "a", "complete", "2026-07-30T03:00:00Z")] as never,
      [{ id: "f1", taskId: "a", focusSessionId: "s1", satisfaction: "satisfied", note: null, createdAt: new Date() }] as never,
      true
    );

    expect(result).toMatchObject({ plannedTasks: 1, closedTasks: 1, rawFocusMinutes: 70, effectiveFocusMinutes: 60, stateTone: "bright" });
    expect(result.tasks[0]).toMatchObject({ focusMinutes: 60, rawFocusMinutes: 70, latestOutcome: "complete" });
    expect(result.tree).toMatchObject({
      kind: "常青树",
      quality: 100,
      points: 83,
      pointsBreakdown: { execution: 45, focus: 8, satisfaction: 20, review: 10 }
    });
    expect(result.radar.find((metric) => metric.key === "mainlineProgress")?.value).toBe(100);
    expect(result.radar.find((metric) => metric.key === "energyState")?.value).toBeNull();
  });

  it("returns a quiet seed state when the day has no activity", () => {
    const result = buildDiaryDayData([], [], [], [], false);
    expect(result).toMatchObject({ stateTone: "quiet", plannedTasks: 0, effectiveFocusMinutes: 0, tree: { kind: "种子", points: 0, quality: 0 } });
  });

  it("counts an ended, unevaluated session immediately instead of displaying zero", () => {
    const result = buildDiaryDayData(
      [task("ended", { lifecycleStatus: "awaiting_outcome" })] as never,
      [session("ended-session", "ended", 3435, 0, { state: "ended" })] as never,
      [],
      [],
      false
    );

    expect(result).toMatchObject({ rawFocusMinutes: 57, effectiveFocusMinutes: 57 });
    expect(result.tasks[0]).toMatchObject({ focusMinutes: 57, rawFocusMinutes: 57 });
  });

  it("counts only executed focus segments for a structured 55 + 5 minute session", () => {
    const result = buildDiaryDayData(
      [task("structured", { lifecycleStatus: "awaiting_outcome" })] as never,
      [session("structured-session", "structured", 3435, 0, { state: "ended", focusStructureId: "structure-1" })] as never,
      [],
      [],
      false,
      [
        { focusSessionId: "structured-session", segmentType: "focus", elapsedSeconds: 3300 },
        { focusSessionId: "structured-session", segmentType: "break", elapsedSeconds: 135 }
      ] as never
    );

    expect(result).toMatchObject({ rawFocusMinutes: 57, effectiveFocusMinutes: 55 });
    expect(result.tasks[0]).toMatchObject({ focusMinutes: 55, rawFocusMinutes: 57 });
  });

  it("does not erase recorded focus when an evaluated task was not completed", () => {
    const result = buildDiaryDayData(
      [task("not-completed", { lifecycleStatus: "closed", currentOutcome: "not_completed" })] as never,
      [session("not-completed-session", "not-completed", 1800, 0)] as never,
      [],
      [],
      false
    );

    expect(result).toMatchObject({ rawFocusMinutes: 30, effectiveFocusMinutes: 30 });
  });

  it("retains backfill as a factual diary record without crediting formal progress, focus, feedback, or points", () => {
    const result = buildDiaryDayData(
      [
        task("formal", { lifecycleStatus: "closed", currentOutcome: "partial" }),
        task("fact", {
          recordKind: "backfill",
          lifecycleStatus: "closed",
          currentOutcome: "complete",
          scheduleKind: "exact",
          startAt: new Date("2026-07-30T01:00:00Z"),
          endAt: new Date("2026-07-30T02:00:00Z")
        })
      ] as never,
      [session("formal-session", "formal", 3600, 3600), session("fact-session", "fact", 7200, 7200)] as never,
      [outcome("formal-outcome", "formal", "partial", "2026-07-30T03:00:00Z"), outcome("fact-outcome", "fact", "complete", "2026-07-30T04:00:00Z")] as never,
      [
        { id: "formal-feedback", taskId: "formal", focusSessionId: null, satisfaction: "neutral", note: null, createdAt: new Date("2026-07-30T03:00:00Z") },
        { id: "fact-feedback", taskId: "fact", focusSessionId: null, satisfaction: "satisfied", note: "补录仍是当天事实材料", createdAt: new Date("2026-07-30T04:00:00Z") }
      ] as never,
      false
    );

    expect(result).toMatchObject({ plannedTasks: 1, closedTasks: 1, rawFocusMinutes: 60, effectiveFocusMinutes: 60, satisfaction: { satisfied: 0, neutral: 1, dissatisfied: 0 } });
    expect(result.tree).toMatchObject({ points: 43, pointsBreakdown: { execution: 23, focus: 8, satisfaction: 12, review: 0 } });
    expect(result.tasks.find((item) => item.id === "fact")).toMatchObject({
      recordKind: "backfill",
      focusMinutes: 0,
      rawFocusMinutes: 0,
      latestOutcome: "complete",
      latestSatisfaction: "satisfied",
      latestFeedbackNote: "补录仍是当天事实材料"
    });
  });

  it("uses subjective feedback rather than focus minutes for the daily state color", () => {
    const result = buildDiaryDayData(
      [task("a", { lifecycleStatus: "closed" })] as never,
      [session("s1", "a", 7200, 7200)] as never,
      [outcome("o1", "a", "complete", "2026-07-30T03:00:00Z")] as never,
      [{ id: "f1", taskId: "a", focusSessionId: "s1", satisfaction: "dissatisfied", note: null, createdAt: new Date() }] as never,
      true
    );
    expect(result.stateTone).toBe("strained");
  });

  it("does not award more execution points merely because the same progress is split into more tasks", () => {
    const oneTask = buildDiaryDayData(
      [task("one", { lifecycleStatus: "closed" })] as never,
      [],
      [outcome("one-outcome", "one", "partial", "2026-07-30T03:00:00Z")] as never,
      [],
      false
    );
    const threeTasks = buildDiaryDayData(
      [task("a", { lifecycleStatus: "closed" }), task("b", { lifecycleStatus: "closed" }), task("c", { lifecycleStatus: "closed" })] as never,
      [],
      [
        outcome("a-outcome", "a", "partial", "2026-07-30T03:00:00Z"),
        outcome("b-outcome", "b", "partial", "2026-07-30T03:00:00Z"),
        outcome("c-outcome", "c", "partial", "2026-07-30T03:00:00Z")
      ] as never,
      [],
      false
    );
    expect(oneTask.tree.pointsBreakdown.execution).toBe(23);
    expect(threeTasks.tree.pointsBreakdown.execution).toBe(23);
    expect(oneTask.tree.points).toBe(threeTasks.tree.points);
  });

  it("keeps weak, ordinary, and strong days visibly distinct within a 0-100 range", () => {
    const weak = buildDiaryDayData(
      [task("weak", { lifecycleStatus: "closed" })] as never,
      [],
      [{ ...outcome("weak-outcome", "weak", "partial", "2026-07-30T03:00:00Z"), progressPercent: 20 }] as never,
      [{ id: "weak-feedback", taskId: "weak", focusSessionId: null, satisfaction: "dissatisfied", note: null, createdAt: new Date() }] as never,
      false
    );
    const ordinary = buildDiaryDayData(
      [task("ordinary", { lifecycleStatus: "closed" })] as never,
      [session("ordinary-session", "ordinary", 5400, 5400)] as never,
      [{ ...outcome("ordinary-outcome", "ordinary", "partial", "2026-07-30T03:00:00Z"), progressPercent: 60 }] as never,
      [{ id: "ordinary-feedback", taskId: "ordinary", focusSessionId: null, satisfaction: "neutral", note: null, createdAt: new Date() }] as never,
      true
    );
    const strong = buildDiaryDayData(
      [task("strong", { lifecycleStatus: "closed" })] as never,
      [session("strong-session", "strong", 10800, 10800)] as never,
      [outcome("strong-outcome", "strong", "complete", "2026-07-30T03:00:00Z")] as never,
      [{ id: "strong-feedback", taskId: "strong", focusSessionId: null, satisfaction: "satisfied", note: null, createdAt: new Date() }] as never,
      true
    );
    expect(weak.tree.points).toBe(13);
    expect(ordinary.tree.points).toBe(62);
    expect(strong.tree.points).toBe(100);
  });
});
