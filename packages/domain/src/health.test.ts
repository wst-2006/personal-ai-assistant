import { describe, expect, it } from "vitest";
import { healthPlanContentSchema, healthSleepRevisionCandidateSchema, healthWeekStartSchema, localDatesForHealthWeek, sleepImageAnalysisRequestSchema, sleepImageAnalysisSchema } from "./health.js";

const day = {
  nutritionDirection: "正常餐盘结构，优先蛋白质和两类蔬菜。",
  proteinRangeGrams: { minimum: 90, maximum: 120 },
  plateGuidance: ["每餐包含一种主要蛋白质来源。"],
  seasonalVegetables: ["番茄"],
  movement: { category: "recovery", durationMinutes: { minimum: 30, maximum: 45 }, intensity: "low", highIntensity: false, safetyReminder: "以舒适为限，避免膝部不适时勉强加量。" }
};

describe("health reference contracts", () => {
  it("requires Sunday-based, seven-day read-only references", () => {
    expect(healthWeekStartSchema.safeParse("2026-08-02").success).toBe(true);
    expect(healthWeekStartSchema.safeParse("2026-08-03").success).toBe(false);
    expect(localDatesForHealthWeek("2026-08-02")).toEqual(["2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08"]);
  });

  it("rejects malformed daily ranges and only accepts seven entries", () => {
    expect(healthPlanContentSchema.safeParse({ overview: "本周以恢复和稳定饮食为主。", supplements: ["查看标签，避免成分重复。"], days: Array.from({ length: 7 }, () => day) }).success).toBe(true);
    expect(healthPlanContentSchema.safeParse({ overview: "x", supplements: ["x"], days: [day] }).success).toBe(false);
    expect(healthPlanContentSchema.safeParse({ overview: "本周", supplements: ["提示"], days: Array.from({ length: 7 }, () => ({ ...day, proteinRangeGrams: { minimum: 120, maximum: 90 } })) }).success).toBe(false);
  });

  it("accepts only constrained user-uploaded image inputs and visible metrics", () => {
    const png = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")}`;
    expect(sleepImageAnalysisRequestSchema.safeParse({ localDate: "2026-08-02", fileName: "sleep.png", mimeType: "image/png", dataUrl: png }).success).toBe(true);
    expect(sleepImageAnalysisRequestSchema.safeParse({ localDate: "2026-08-02", fileName: "sleep.svg", mimeType: "image/svg+xml", dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }).success).toBe(false);
    expect(sleepImageAnalysisSchema.safeParse({
      totalSleepMinutes: 420, deepSleepMinutes: null, lightSleepMinutes: null, remSleepMinutes: null,
      awakeCount: null, sleepStart: null, wakeTime: "07:30", deviceScore: null, deviceNotes: null,
      visibleMetrics: ["总睡眠 7 小时"], interpretation: ["截图显示总睡眠约 7 小时。"], limitations: ["仅基于截图中可见信息。"]
    }).success).toBe(true);
  });

  it("accepts a sleep revision only with an explicit weekly target and analysis id", () => {
    expect(healthSleepRevisionCandidateSchema.safeParse({
      weekStart: "2026-08-02",
      sleepAnalysisId: "00000000-0000-4000-8000-000000000001"
    }).success).toBe(true);
    expect(healthSleepRevisionCandidateSchema.safeParse({
      weekStart: "2026-08-03",
      sleepAnalysisId: "not-a-uuid"
    }).success).toBe(false);
  });
});
