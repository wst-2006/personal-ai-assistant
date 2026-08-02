import { describe, expect, it } from "vitest";
import {
  allocateContinuousFocusStructure,
  allocateTemplateFocusStructure,
  calculateEffectiveFocusSeconds,
  createFocusSessionSchema,
  evaluateFocusSessionSchema,
  validateSegmentedFocusStructure
} from "./focus.js";

describe("focus input contracts", () => {
  it("accepts preparation/reminder starts but rejects manual restart", () => {
    expect(createFocusSessionSchema.safeParse({
      taskId: "00000000-0000-4000-8000-000000000001", expectedTaskVersion: 2, mode: "prepare"
    }).success).toBe(true);
    expect(createFocusSessionSchema.safeParse({
      taskId: "00000000-0000-4000-8000-000000000001", expectedTaskVersion: 2, mode: "restart"
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
    [30, "09:30", 30, 0],
    [60, "10:00", 55, 5],
    [90, "10:30", 85, 5],
    [120, "11:00", 115, 5]
  ] as const)("allocates %i minutes as %i focus + %i rest", (total, endTime, focus, rest) => {
    const result = allocateContinuousFocusStructure({
      totalStartAt: start,
      totalEndAt: `2026-07-27T${endTime}:00+08:00`
    });
    expect(result.totalMinutes).toBe(total);
    expect(result.effectiveFocusMinutes).toBe(focus);
    expect(result.breakMinutes).toBe(rest);
    expect(result.segments).toEqual(rest === 0
      ? [{ segmentType: "focus", durationMinutes: focus }]
      : [{ segmentType: "focus", durationMinutes: focus }, { segmentType: "break", durationMinutes: rest }]);
  });

  it("accepts an explicit zero break for a 30-minute task", () => {
    const result = allocateContinuousFocusStructure({
      totalStartAt: start,
      totalEndAt: "2026-07-27T09:30:00+08:00",
      breakMinutes: 0
    });
    expect(result.segments).toEqual([{ segmentType: "focus", durationMinutes: 30 }]);
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

  it.each([0, 4, 16])("rejects a rest value outside 5-15 minutes for long tasks", (breakMinutes) => {
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
      totalEndAt: "2026-07-27T10:00:00+08:00",
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
});
