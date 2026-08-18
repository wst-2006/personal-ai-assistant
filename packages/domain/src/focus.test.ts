import { describe, expect, it } from "vitest";
import {
  allocateContinuousFocusStructure,
  allocateTemplateFocusStructure,
  adjustAdjacentFocusSegments,
  calculateEffectiveFocusSeconds,
  calculateSegmentElapsedSeconds,
  createFocusSessionSchema,
  evaluateFocusSessionSchema,
  formatFocusClock,
  focusStructureInputSchema,
  locateFocusSegment,
  validateSegmentedFocusStructure
} from "./focus.js";

describe("focus input contracts", () => {
  it("shows hour-long focus sessions without truncating the duration", () => {
    expect(formatFocusClock(30 * 60)).toBe("30:00");
    expect(formatFocusClock(90 * 60)).toBe("1:30:00");
    expect(formatFocusClock(120 * 60 + 5)).toBe("2:00:05");
  });

  it("accepts preparation/reminder starts but rejects manual restart", () => {
    expect(createFocusSessionSchema.safeParse({
      taskId: "00000000-0000-4000-8000-000000000001", expectedTaskVersion: 2, mode: "prepare"
    }).success).toBe(true);
    expect(createFocusSessionSchema.safeParse({
      taskId: "00000000-0000-4000-8000-000000000001", expectedTaskVersion: 2, mode: "restart"
    }).success).toBe(false);
  });

  it("accepts an optional UUID command id and rejects arbitrary retry tokens", () => {
    expect(evaluateFocusSessionSchema.safeParse({
      expectedVersion: 1,
      commandId: "00000000-0000-4000-8000-000000000002",
      outcome: "complete",
      progressPercent: 100,
      satisfaction: "satisfied"
    }).success).toBe(true);
    expect(evaluateFocusSessionSchema.safeParse({
      expectedVersion: 1,
      commandId: "retry-me",
      outcome: "complete",
      progressPercent: 100,
      satisfaction: "satisfied"
    }).success).toBe(false);
  });

  it.each([
    ["complete", 100, true], ["complete", 90, false], ["partial", 50, true], ["partial", 0, false], ["not_completed", 0, true]
  ] as const)("validates %s evaluation percentages", (outcome, progressPercent, valid) => {
    const result = evaluateFocusSessionSchema.safeParse({ expectedVersion: 1, outcome, progressPercent, satisfaction: "neutral" });
    expect(result.success).toBe(valid);
  });
});

describe("focus structure allocation", () => {
  const start = "2026-07-27T09:00:00+08:00";

  it.each([
    [30, "09:30", 25, 5],
    [60, "10:00", 55, 5],
    [90, "10:30", 80, 10],
    [120, "11:00", 105, 15]
  ] as const)("allocates %i minutes ending at %s as %i focus + %i rest", (total, endTime, focus, rest) => {
    const result = allocateContinuousFocusStructure({
      totalStartAt: start,
      totalEndAt: `2026-07-27T${endTime}:00+08:00`
    });
    expect(result.totalMinutes).toBe(total);
    expect(result.effectiveFocusMinutes).toBe(focus);
    expect(result.breakMinutes).toBe(rest);
    expect(result.segments).toEqual([
      { segmentType: "focus", durationMinutes: focus },
      { segmentType: "break", durationMinutes: rest }
    ]);
  });

  it("rejects removing the final rest from a 30-minute task", () => {
    expect(() => allocateContinuousFocusStructure({
      totalStartAt: start,
      totalEndAt: "2026-07-27T09:30:00+08:00",
      breakMinutes: 0
    })).toThrow("requires");
  });

  it("counts only focus segments and clips a late start at the fixed end", () => {
    const structure = allocateContinuousFocusStructure({
      totalStartAt: start,
      totalEndAt: "2026-07-27T10:00:00+08:00"
    });
    expect(calculateEffectiveFocusSeconds({
      structureStartAt: structure.totalStartAt,
      actualStartAt: "2026-07-27T09:30:00+08:00",
      fixedEndAt: structure.totalEndAt,
      now: "2026-07-27T10:30:00+08:00",
      segments: structure.segments
    })).toBe(25 * 60);
  });

  it("allows a final rest adjustment from five through fifteen minutes", () => {
    const result = allocateContinuousFocusStructure({
      totalStartAt: start,
      totalEndAt: "2026-07-27T11:00:00+08:00",
      breakMinutes: 15
    });
    expect(result.effectiveFocusMinutes).toBe(105);
    expect(result.breakMinutes).toBe(15);
  });

  it.each([0, 4, 16])("rejects a rest value outside 5-15 minutes", (breakMinutes) => {
    expect(() => allocateContinuousFocusStructure({
      totalStartAt: start,
      totalEndAt: "2026-07-27T10:00:00+08:00",
      breakMinutes
    })).toThrow();
  });

  it("does not allow a segmented structure to overrun its fixed end", () => {
    expect(() => validateSegmentedFocusStructure({
      totalStartAt: start,
      totalEndAt: "2026-07-27T11:00:00+08:00",
      segments: [
        { segmentType: "focus", durationMinutes: 30 },
        { segmentType: "break", durationMinutes: 5 },
        { segmentType: "focus", durationMinutes: 60 }
      ]
    })).toThrow("exactly fill");
  });

  it("accepts alternating segments that exactly fill the task interval", () => {
    const result = validateSegmentedFocusStructure({
      totalStartAt: start,
      totalEndAt: "2026-07-27T11:00:00+08:00",
      segments: [
        { segmentType: "focus", durationMinutes: 55 },
        { segmentType: "break", durationMinutes: 5 },
        { segmentType: "focus", durationMinutes: 55 },
        { segmentType: "break", durationMinutes: 5 }
      ]
    });
    expect(result.effectiveFocusMinutes).toBe(110);
  });

  it("allows a final break in a segmented structure", () => {
    const result = validateSegmentedFocusStructure({
      totalStartAt: start,
      totalEndAt: "2026-07-27T11:00:00+08:00",
      segments: [
        { segmentType: "focus", durationMinutes: 30 },
        { segmentType: "break", durationMinutes: 15 },
        { segmentType: "focus", durationMinutes: 70 },
        { segmentType: "break", durationMinutes: 5 }
      ]
    });
    expect(result.effectiveFocusMinutes).toBe(100);
    expect(result.breakMinutes).toBe(20);
  });

  it.each([
    ["equal", [40, 40]],
    ["increasing", [39, 41]],
    ["decreasing", [41, 39]]
  ] as const)("allocates a deterministic %s two-block template", (distribution, focusDurations) => {
    const result = allocateTemplateFocusStructure({
      totalStartAt: start,
      totalEndAt: "2026-07-27T10:30:00+08:00",
      focusCount: 2,
      distribution,
      breakMinutes: 5
    });
    expect(result.segments).toEqual([
      { segmentType: "focus", durationMinutes: focusDurations[0] },
      { segmentType: "break", durationMinutes: 5 },
      { segmentType: "focus", durationMinutes: focusDurations[1] },
      { segmentType: "break", durationMinutes: 5 }
    ]);
    expect(result.totalMinutes).toBe(90);
  });

  it("puts equal-template remainder minutes at the beginning", () => {
    const result = allocateTemplateFocusStructure({
      totalStartAt: start,
      totalEndAt: "2026-07-27T12:30:00+08:00",
      focusCount: 4,
      distribution: "equal",
      breakMinutes: 5
    });
    expect(result.segments.filter((segment) => segment.segmentType === "focus").map((segment) => segment.durationMinutes))
      .toEqual([48, 48, 47, 47]);
  });

  it("rejects a segment count that cannot fit its minimum focus and rest", () => {
    expect(() => allocateTemplateFocusStructure({
      totalStartAt: start,
      totalEndAt: "2026-07-27T09:30:00+08:00",
      focusCount: 2,
      distribution: "equal",
      breakMinutes: 5
    })).toThrow("cannot contain");
  });

  it("requires every segmented focus block to end with its own break", () => {
    expect(() => validateSegmentedFocusStructure({
      totalStartAt: start,
      totalEndAt: "2026-07-27T11:00:00+08:00",
      segments: [
        { segmentType: "focus", durationMinutes: 30 },
        { segmentType: "break", durationMinutes: 5 },
        { segmentType: "focus", durationMinutes: 85 }
      ]
    })).toThrow("followed by a break");
  });

  it("rejects a one-block segmented payload that tries to bypass the final rest", () => {
    expect(() => validateSegmentedFocusStructure({
      totalStartAt: start,
      totalEndAt: "2026-07-27T10:00:00+08:00",
      segments: [{ segmentType: "focus", durationMinutes: 60 }]
    })).toThrow("followed by a break");
    expect(focusStructureInputSchema.safeParse({
      taskId: "00000000-0000-4000-8000-000000000001",
      taskVersion: 1,
      taskScheduleRevision: 1,
      source: "manual",
      mode: "segmented",
      totalStartAt: start,
      totalEndAt: "2026-07-27T10:00:00+08:00",
      breakMinutes: 0,
      segments: [{ segmentType: "focus", durationMinutes: 60 }]
    }).success).toBe(false);
  });

  it("locates a late start inside the original segment without counting skipped time", () => {
    const position = locateFocusSegment({
      structureStartAt: start,
      now: "2026-07-27T10:20:00+08:00",
      segments: [
        { durationMinutes: 55 },
        { durationMinutes: 5 },
        { durationMinutes: 55 },
        { durationMinutes: 5 }
      ]
    });
    expect(position).toEqual({
      position: 2,
      plannedStartedAt: new Date("2026-07-27T10:00:00+08:00"),
      elapsedSeconds: 20 * 60
    });
    expect(calculateSegmentElapsedSeconds({
      actualStartedAt: "2026-07-27T10:20:00+08:00",
      endedAt: "2026-07-27T10:55:00+08:00",
      plannedDurationSeconds: 55 * 60
    })).toBe(35 * 60);
  });

  it("moves an adjacent boundary without changing total duration", () => {
    const result = adjustAdjacentFocusSegments([
      { segmentType: "focus", durationMinutes: 40 },
      { segmentType: "break", durationMinutes: 5 },
      { segmentType: "focus", durationMinutes: 40 },
      { segmentType: "break", durationMinutes: 5 }
    ], 0, -8);
    expect(result.slice(0, 2)).toEqual([
      { segmentType: "focus", durationMinutes: 32 },
      { segmentType: "break", durationMinutes: 13 }
    ]);
    expect(result.reduce((sum, segment) => sum + segment.durationMinutes, 0)).toBe(90);
  });

  it("clamps a dragged boundary at both segment constraints", () => {
    const result = adjustAdjacentFocusSegments([
      { segmentType: "focus", durationMinutes: 40 },
      { segmentType: "break", durationMinutes: 5 }
    ], 0, -30);
    expect(result).toEqual([
      { segmentType: "focus", durationMinutes: 30 },
      { segmentType: "break", durationMinutes: 15 }
    ]);
  });
});
