import { afterAll, describe, expect, it } from "vitest";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { healthDailyReferences, healthSleepAnalyses, healthWeekPlans } from "@personal-ai/db/schema";
import { eq, inArray } from "drizzle-orm";
import { buildApp } from "./app.js";
import { HealthService } from "./health-service.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
const service = new HealthService(connection.db);
const testContent = (overview: string) => ({
  overview,
  supplements: ["仅供测试查看。"],
  days: Array.from({ length: 7 }, () => ({
    nutritionDirection: "维持正常餐盘结构。",
    proteinRangeGrams: { minimum: 90, maximum: 120 },
    plateGuidance: ["每餐有主要蛋白质来源。"],
    seasonalVegetables: ["番茄"],
    seasonalGuidance: null,
    seasonalPoem: null,
    movement: { category: "recovery" as const, durationMinutes: { minimum: 20, maximum: 30 }, intensity: "low" as const, highIntensity: false, safetyReminder: "按实际舒适度决定。" }
  }))
});
const createManual = (weekStart: string, overview: string) => service.createManualCandidate({ weekStart, content: testContent(overview) });
const app = buildApp({
  healthService: service,
  healthPlanner: {
    async plan() {
      return {
        overview: "只作为待确认的睡眠修订候选。",
        supplements: ["不根据一次截图自动改变补充剂。"],
        days: Array.from({ length: 7 }, () => ({
          nutritionDirection: "维持正常餐盘结构。",
          proteinRangeGrams: { minimum: 90, maximum: 120 },
          plateGuidance: ["每餐有主要蛋白质来源。"],
          seasonalVegetables: ["番茄"],
          movement: { category: "recovery", durationMinutes: { minimum: 20, maximum: 30 }, intensity: "low", highIntensity: false, safetyReminder: "按实际舒适度决定。" }
        }))
      };
    }
  },
  sleepImageAnalyzer: {
    async analyze() {
      return {
        totalSleepMinutes: 390, deepSleepMinutes: 90, lightSleepMinutes: null, remSleepMinutes: null,
        awakeCount: 2, sleepStart: "23:40", wakeTime: "06:10", deviceScore: 82,
        deviceNotes: "设备显示睡眠评分。", visibleMetrics: ["总睡眠", "深睡", "评分"],
        interpretation: ["截图中显示总睡眠和设备评分。"], limitations: ["仅基于截图中可见信息，不能替代专业医疗建议。"]
      };
    }
  }
});

afterAll(async () => {
  await app.close();
  await connection.client.end();
});

describe("sleep screenshot routes", () => {
  it("reports visual-analysis capability explicitly", async () => {
    const available = await app.inject({ method: "GET", url: "/api/v1/health/capabilities" });
    expect(available.statusCode).toBe(200);
    expect(available.json()).toEqual({ sleepImageAnalysis: true, sleepImageAnalysisReason: null });

    const withoutVision = buildApp({ healthService: service });
    try {
      const unavailable = await withoutVision.inject({ method: "GET", url: "/api/v1/health/capabilities" });
      expect(unavailable.json()).toEqual({ sleepImageAnalysis: false, sleepImageAnalysisReason: "vision_model_not_configured" });
      const upload = await withoutVision.inject({ method: "POST", url: "/api/v1/health/sleep-analyses", payload: {} });
      expect(upload.statusCode).toBe(503);
      expect(upload.json()).toMatchObject({ error: "sleep_image_analysis_unavailable" });
    } finally {
      await withoutVision.close();
    }
  });

  it("returns only the confirmed daily reference for the Today summary", async () => {
    const weekStart = "2099-05-03";
    const candidate = await createManual(weekStart, "今日摘要测试参考");
    try {
      const before = await app.inject({ method: "GET", url: "/api/v1/health/days/2099-05-04" });
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual({ reference: null });

      const active = await service.confirm(candidate.plan.id, candidate.plan.version);
      const after = await app.inject({ method: "GET", url: "/api/v1/health/days/2099-05-04" });
      expect(after.statusCode).toBe(200);
      expect(after.json()).toMatchObject({ reference: { plan: { id: active.plan.id, state: "active" }, day: { localDate: "2099-05-04", dayIndex: 1 } } });
    } finally {
      await connection.db.transaction(async (transaction) => {
        await transaction.delete(healthDailyReferences).where(eq(healthDailyReferences.healthWeekPlanId, candidate.plan.id));
        await transaction.delete(healthWeekPlans).where(eq(healthWeekPlans.id, candidate.plan.id));
      });
    }
  });

  it("persists structured results and never accepts mismatched image bytes", async () => {
    const dataUrl = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")}`;
    const created = await app.inject({ method: "POST", url: "/api/v1/health/sleep-analyses", payload: {
      localDate: "2099-02-01", fileName: "huawei-sleep.png", mimeType: "image/png", dataUrl
    } });
    expect(created.statusCode).toBe(201);
    const record = created.json().analysis as { id: string; analysis: { totalSleepMinutes: number }; sha256: string };
    expect(record.analysis.totalSleepMinutes).toBe(390);
    expect(record.sha256).toMatch(/^[a-f0-9]{64}$/);

    const listed = await app.inject({ method: "GET", url: "/api/v1/health/sleep-analyses/2099-02-01" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().analyses).toHaveLength(1);

    const invalid = await app.inject({ method: "POST", url: "/api/v1/health/sleep-analyses", payload: {
      localDate: "2099-02-02", fileName: "fake.png", mimeType: "image/png", dataUrl: "data:image/png;base64,ZmFrZQ=="
    } });
    expect(invalid.statusCode).toBe(400);
    await connection.db.delete(healthSleepAnalyses).where(eq(healthSleepAnalyses.id, record.id));
  });

  it("creates a user-requested sleep revision candidate without replacing the active week", async () => {
    const weekStart = "2099-03-08";
    const base = await createManual(weekStart, "睡眠修订测试参考");
    const active = await service.confirm(base.plan.id, base.plan.version);
    const png = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")}`;
    const sleep = await service.analyzeSleepImage({ localDate: "2099-03-09", fileName: "sleep.png", mimeType: "image/png", dataUrl: png }, {
      async analyze() {
        return {
          totalSleepMinutes: 390, deepSleepMinutes: null, lightSleepMinutes: null, remSleepMinutes: null,
          awakeCount: null, sleepStart: null, wakeTime: null, deviceScore: null, deviceNotes: null,
          visibleMetrics: ["总睡眠"], interpretation: ["截图显示总睡眠。"], limitations: ["仅基于截图中可见信息。"]
        };
      }
    });
    let revisionId: string | null = null;
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/health/weeks/sleep-revision-candidates", payload: {
        weekStart,
        sleepAnalysisId: sleep.id
      } });
      expect(response.statusCode).toBe(201);
      const candidate = response.json().plan as { id: string; state: string; basedOnPlanId: string; sourceSleepAnalysisId: string; revisionReason: string };
      revisionId = candidate.id;
      expect(candidate).toMatchObject({ state: "candidate", basedOnPlanId: active.plan.id, sourceSleepAnalysisId: sleep.id });
      expect(candidate.revisionReason).toContain("2099-03-09");
      expect((await service.getWeek(weekStart)).active?.plan.id).toBe(active.plan.id);
    } finally {
      const planIds = [base.plan.id, ...(revisionId ? [revisionId] : [])];
      await connection.db.transaction(async (transaction) => {
        await transaction.delete(healthDailyReferences).where(inArray(healthDailyReferences.healthWeekPlanId, planIds));
        await transaction.delete(healthWeekPlans).where(inArray(healthWeekPlans.id, planIds));
        await transaction.delete(healthSleepAnalyses).where(eq(healthSleepAnalyses.id, sleep.id));
      });
    }
  });

  it("accepts a complete manual candidate and keeps the active plan unchanged before confirmation", async () => {
    const weekStart = "2099-03-22";
    const base = await createManual(weekStart, "手动候选测试参考");
    const active = await service.confirm(base.plan.id, base.plan.version);
    let manualId: string | null = null;
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/health/weeks/manual-candidates", payload: {
        weekStart,
        content: {
          overview: "这是用户手动编辑的候选。",
          supplements: ["仅供查看。"],
          days: Array.from({ length: 7 }, () => ({
            nutritionDirection: "维持正常餐盘结构。",
            proteinRangeGrams: { minimum: 90, maximum: 120 },
            plateGuidance: ["每餐有主要蛋白质来源。"],
            seasonalVegetables: ["番茄"],
            movement: { category: "recovery", durationMinutes: { minimum: 20, maximum: 30 }, intensity: "low", highIntensity: false, safetyReminder: "按当天实际舒适度决定。" }
          }))
        }
      } });
      expect(response.statusCode).toBe(201);
      const manual = response.json().plan as { id: string; source: string; state: string; version: number; basedOnPlanId: string };
      manualId = manual.id;
      expect(manual).toMatchObject({ source: "manual", state: "candidate", basedOnPlanId: active.plan.id });
      expect((await service.getWeek(weekStart)).active?.plan.id).toBe(active.plan.id);
      const updated = await app.inject({ method: "PUT", url: `/api/v1/health/weeks/${manual.id}/manual-candidate`, payload: {
        expectedVersion: manual.version,
        content: {
          overview: "这是用户再次编辑后的候选。",
          supplements: ["仅供查看。"],
          days: Array.from({ length: 7 }, () => ({
            nutritionDirection: "维持正常餐盘结构。",
            proteinRangeGrams: { minimum: 90, maximum: 120 },
            plateGuidance: ["每餐有主要蛋白质来源。"],
            seasonalVegetables: ["番茄"],
            movement: { category: "recovery", durationMinutes: { minimum: 20, maximum: 30 }, intensity: "low", highIntensity: false, safetyReminder: "按当天实际舒适度决定。" }
          }))
        }
      } });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().plan).toMatchObject({ id: manual.id, source: "manual", overview: "这是用户再次编辑后的候选。" });
      const stale = await app.inject({ method: "PUT", url: `/api/v1/health/weeks/${manual.id}/manual-candidate`, payload: {
        expectedVersion: manual.version,
        content: {
          overview: "过期页面不应覆盖最新候选。",
          supplements: ["仅供查看。"],
          days: Array.from({ length: 7 }, () => ({
            nutritionDirection: "维持正常餐盘结构。",
            proteinRangeGrams: { minimum: 90, maximum: 120 },
            plateGuidance: ["每餐有主要蛋白质来源。"],
            seasonalVegetables: ["番茄"],
            movement: { category: "recovery", durationMinutes: { minimum: 20, maximum: 30 }, intensity: "low", highIntensity: false, safetyReminder: "按当天实际舒适度决定。" }
          }))
        }
      } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: "health_plan_version_conflict", plan: { id: manual.id, overview: "这是用户再次编辑后的候选。" } });
    } finally {
      const planIds = [base.plan.id, ...(manualId ? [manualId] : [])];
      await connection.db.transaction(async (transaction) => {
        await transaction.delete(healthDailyReferences).where(inArray(healthDailyReferences.healthWeekPlanId, planIds));
        await transaction.delete(healthWeekPlans).where(inArray(healthWeekPlans.id, planIds));
      });
    }
  });
});
