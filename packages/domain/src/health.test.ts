import { describe, expect, it } from "vitest";
import { healthPlanContentSchema, healthWeekStartSchema, localDatesForHealthWeek } from "./health.js";

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
});
