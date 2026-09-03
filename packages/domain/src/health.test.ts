import { describe, expect, it } from "vitest";
import { createManualHealthPlanCandidateSchema, generatedHealthPlanContentSchema, healthPlanContentSchema, healthSleepRevisionCandidateSchema, healthWeekStartSchema, localDatesForHealthWeek, saveHealthDailyActualSchema, sleepImageAnalysisRequestSchema, sleepImageAnalysisSchema } from "./health.js";

const day = {
  nutritionDirection: "正常餐盘结构，优先蛋白质和两类蔬菜。",
  proteinRangeGrams: { minimum: 90, maximum: 120 },
  plateGuidance: ["每餐包含一种主要蛋白质来源。"],
  seasonalVegetables: ["番茄"],
  movement: { category: "recovery", durationMinutes: { minimum: 30, maximum: 45 }, intensity: "low", highIntensity: false, safetyReminder: "以舒适为限，避免膝部不适时勉强加量。" }
};

const generatedDay = {
  ...day,
  nutritionTargets: {
    carbohydrateGrams: { minimum: 200, maximum: 260 },
    fatGrams: { minimum: 50, maximum: 70 },
    fiberGrams: { minimum: 25, maximum: 30 },
    hydrationLiters: { minimum: 2, maximum: 2.5 },
    macroRatioPercent: { protein: 25, carbohydrate: 50, fat: 25 }
  },
  hydrationGuidance: ["2.5L 水约等于 10 个 250ml 纸杯，只是便于理解的估算。", "起床后和三餐之间分散补水。"],
  mealExamples: { breakfast: ["鸡蛋与燕麦"], lunch: ["牛肉、米饭和蔬菜"], dinner: ["鸡肉、南瓜和绿叶菜"], snack: ["无糖酸奶"] },
  proteinRotationSources: ["鸡蛋", "牛肉"],
  foodReference: {
    proteinOptions: ["约 15 个鸡蛋", "约 650 克牛肉", "约 550 克鸡胸肉"],
    fiberOptions: ["约 1000 克白菜"],
    carbOptions: ["约 5 碗熟米饭"],
    fatOptions: ["约 4 汤匙食用油"]
  },
  fruitOptions: ["1 个苹果", "200 克草莓"]
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

  it("accepts one daily total for protein, fiber, and water without meal splitting", () => {
    expect(saveHealthDailyActualSchema.safeParse({ proteinGrams: 96, fiberGrams: 28, waterMilliliters: 2300 }).success).toBe(true);
    expect(saveHealthDailyActualSchema.safeParse({ proteinGrams: null, fiberGrams: null, waterMilliliters: null }).success).toBe(true);
    expect(saveHealthDailyActualSchema.safeParse({ proteinGrams: 96.5, fiberGrams: 28, waterMilliliters: 2300 }).success).toBe(false);
  });

  it("requires executable fields only for newly AI-generated plans while preserving old stored records", () => {
    const legacy = { overview: "旧记录", supplements: ["查看标签。"], days: Array.from({ length: 7 }, () => day) };
    const generated = { overview: "新生成参考", supplements: ["查看标签。"], days: Array.from({ length: 7 }, () => generatedDay) };
    expect(healthPlanContentSchema.safeParse(legacy).success).toBe(true);
    expect(generatedHealthPlanContentSchema.safeParse(legacy).success).toBe(false);
    expect(generatedHealthPlanContentSchema.safeParse(generated).success).toBe(true);
  });

  it("requires fruit portions and concrete food and water conversions for generated plans", () => {
    const content = { overview: "新生成参考", supplements: ["自然食物优先，必要时再查看补充剂标签。"], days: Array.from({ length: 7 }, () => generatedDay) };
    expect(generatedHealthPlanContentSchema.safeParse({
      ...content,
      days: content.days.map((item) => ({ ...item, fruitOptions: undefined }))
    }).success).toBe(false);
    expect(generatedHealthPlanContentSchema.safeParse({
      ...content,
      days: content.days.map((item) => ({ ...item, hydrationGuidance: ["全天分次饮水。"] }))
    }).success).toBe(false);
    expect(generatedHealthPlanContentSchema.safeParse({
      ...content,
      days: content.days.map((item) => ({ ...item, foodReference: { ...item.foodReference, proteinOptions: ["鸡蛋", "牛肉"] } }))
    }).success).toBe(false);
    expect(generatedHealthPlanContentSchema.safeParse({
      ...content,
      days: content.days.map((item) => ({ ...item, foodReference: { ...item.foodReference, carbOptions: ["米饭"] } }))
    }).success).toBe(false);
  });

  it("rejects incomplete nutrition ranges and misleading macro totals", () => {
    const reversedRange = {
      overview: "范围错误",
      supplements: ["查看标签。"],
      days: Array.from({ length: 7 }, () => ({
        ...generatedDay,
        nutritionTargets: { ...generatedDay.nutritionTargets, fiberGrams: { minimum: 35, maximum: 20 } }
      }))
    };
    const invalidMacroTotal = {
      overview: "比例错误",
      supplements: ["查看标签。"],
      days: Array.from({ length: 7 }, () => ({
        ...generatedDay,
        nutritionTargets: { ...generatedDay.nutritionTargets, macroRatioPercent: { protein: 20, carbohydrate: 20, fat: 20 } }
      }))
    };
    expect(healthPlanContentSchema.safeParse(reversedRange).success).toBe(false);
    expect(generatedHealthPlanContentSchema.safeParse(invalidMacroTotal).success).toBe(false);
  });

  it("accepts walking and legitimate decimal macro ratios", () => {
    const walkingDay = {
      ...generatedDay,
      nutritionTargets: { ...generatedDay.nutritionTargets, macroRatioPercent: { protein: 22.5, carbohydrate: 52.5, fat: 25 } },
      movement: { ...generatedDay.movement, category: "walking" }
    };
    expect(generatedHealthPlanContentSchema.safeParse({
      overview: "以步行和规律饮食作为可选择的本周参考。",
      supplements: ["查看标签，避免成分重复。"],
      days: Array.from({ length: 7 }, () => walkingDay)
    }).success).toBe(true);
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

  it("requires a complete valid week when the user creates a manual candidate", () => {
    const content = { overview: "由用户手动调整的本周参考。", supplements: ["查看产品标签。"], days: Array.from({ length: 7 }, () => day) };
    expect(createManualHealthPlanCandidateSchema.safeParse({ weekStart: "2026-08-02", content }).success).toBe(true);
    expect(createManualHealthPlanCandidateSchema.safeParse({ weekStart: "2026-08-02", content: { ...content, days: [day] } }).success).toBe(false);
  });
});
