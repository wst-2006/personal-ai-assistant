import { afterAll, describe, expect, it } from "vitest";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { healthDailyReferences, healthSleepAnalyses, healthWeekPlans } from "@personal-ai/db/schema";
import { eq, inArray } from "drizzle-orm";
import { HealthPlanBaseChangedError, HealthService } from "./health-service.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
const service = new HealthService(connection.db);

afterAll(async () => { await connection.client.end(); });

describe("health reference persistence", () => {
  it("creates a read-only candidate, confirms it explicitly, and keeps seven independent daily references", async () => {
    const candidate = await service.createTemplateCandidate("2099-01-04", "本周有一次长途出行");
    try {
      expect(candidate.plan.state).toBe("candidate");
      expect(candidate.plan.source).toBe("template");
      expect(candidate.days).toHaveLength(7);
      expect(candidate.days[0]?.content).toMatchObject({ proteinRangeGrams: { minimum: 90, maximum: 120 } });

      const confirmed = await service.confirm(candidate.plan.id, candidate.plan.version);
      expect(confirmed.plan.state).toBe("active");
      const restored = await service.getWeek("2099-01-04");
      expect(restored.active?.plan.id).toBe(candidate.plan.id);
      expect(restored.active?.days).toHaveLength(7);
      expect(restored.candidate).toBeNull();
    } finally {
      await connection.db.transaction(async (transaction) => {
        await transaction.delete(healthDailyReferences).where(eq(healthDailyReferences.healthWeekPlanId, candidate.plan.id));
        await transaction.delete(healthWeekPlans).where(eq(healthWeekPlans.id, candidate.plan.id));
      });
    }
  });

  it("stores only a hashed upload and structured visible analysis, never the original image", async () => {
    const png = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")}`;
    const record = await service.analyzeSleepImage({ localDate: "2099-01-05", fileName: "sleep.png", mimeType: "image/png", dataUrl: png }, {
      async analyze() {
        return {
          totalSleepMinutes: 420, deepSleepMinutes: null, lightSleepMinutes: null, remSleepMinutes: null,
          awakeCount: null, sleepStart: null, wakeTime: "07:30", deviceScore: null, deviceNotes: null,
          visibleMetrics: ["总睡眠 7 小时"], interpretation: ["截图显示总睡眠约 7 小时。"], limitations: ["仅基于截图中可见信息。"]
        };
      }
    });
    try {
      expect(record.originalFileName).toBe("sleep.png");
      expect(record.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(record.analysis).toMatchObject({ totalSleepMinutes: 420 });
      expect(JSON.stringify(record)).not.toContain("iVBORw0KGgo");
      expect(await service.listSleepAnalyses("2099-01-05")).toHaveLength(1);
    } finally {
      await connection.db.delete(healthSleepAnalyses).where(eq(healthSleepAnalyses.id, record.id));
    }
  });

  it("creates a sleep-based revision candidate without changing the active week until explicit confirmation", async () => {
    const weekStart = "2099-03-01";
    const base = await service.createTemplateCandidate(weekStart, null);
    const active = await service.confirm(base.plan.id, base.plan.version);
    const png = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")}`;
    const sleep = await service.analyzeSleepImage({ localDate: "2099-03-02", fileName: "sleep.png", mimeType: "image/png", dataUrl: png }, {
      async analyze() {
        return {
          totalSleepMinutes: 360, deepSleepMinutes: 60, lightSleepMinutes: null, remSleepMinutes: null,
          awakeCount: 3, sleepStart: null, wakeTime: null, deviceScore: 72, deviceNotes: null,
          visibleMetrics: ["总睡眠", "深睡", "评分"], interpretation: ["截图中显示睡眠时长。"], limitations: ["仅基于截图中可见信息。"]
        };
      }
    });
    let revisionId: string | null = null;
    try {
      const revision = await service.createSleepRevisionCandidate({ weekStart, sleepAnalysisId: sleep.id, specialContext: "周二只安排轻量活动" }, {
        async plan(input) {
          expect(input.sleepAnalysis).toMatchObject({ localDate: "2099-03-02", analysis: { totalSleepMinutes: 360 } });
          return {
            overview: "本次只生成待确认的睡眠修订候选。",
            supplements: ["不因一次截图改变补充剂。"],
            days: Array.from({ length: 7 }, () => ({
              nutritionDirection: "维持正常餐盘结构。",
              proteinRangeGrams: { minimum: 90, maximum: 120 },
              plateGuidance: ["每餐有主要蛋白质来源。"],
              seasonalVegetables: ["番茄"],
              movement: { category: "recovery", durationMinutes: { minimum: 20, maximum: 30 }, intensity: "low", highIntensity: false, safetyReminder: "按实际舒适度决定。" }
            }))
          };
        }
      });
      revisionId = revision.plan.id;
      expect(revision.plan.state).toBe("candidate");
      expect(revision.plan.basedOnPlanId).toBe(active.plan.id);
      expect(revision.plan.basedOnPlanVersion).toBe(active.plan.version);
      expect(revision.plan.sourceSleepAnalysisId).toBe(sleep.id);
      expect(revision.plan.revisionReason).toContain("2099-03-02");

      const beforeConfirmation = await service.getWeek(weekStart);
      expect(beforeConfirmation.active?.plan.id).toBe(active.plan.id);
      expect(beforeConfirmation.candidate?.plan.id).toBe(revision.plan.id);

      const confirmed = await service.confirm(revision.plan.id, revision.plan.version);
      expect(confirmed.plan.id).toBe(revision.plan.id);
      expect(confirmed.plan.state).toBe("active");
      expect((await service.getWeek(weekStart)).active?.plan.id).toBe(revision.plan.id);
    } finally {
      const planIds = [base.plan.id, ...(revisionId ? [revisionId] : [])];
      await connection.db.transaction(async (transaction) => {
        await transaction.delete(healthDailyReferences).where(inArray(healthDailyReferences.healthWeekPlanId, planIds));
        await transaction.delete(healthWeekPlans).where(inArray(healthWeekPlans.id, planIds));
        await transaction.delete(healthSleepAnalyses).where(eq(healthSleepAnalyses.id, sleep.id));
      });
    }
  });

  it("stores a user-edited weekly reference as a manual candidate before it replaces the active week", async () => {
    const weekStart = "2099-03-15";
    const base = await service.createTemplateCandidate(weekStart, null);
    const active = await service.confirm(base.plan.id, base.plan.version);
    let manualId: string | null = null;
    try {
      const manual = await service.createManualCandidate({
        weekStart,
        content: {
          overview: "这是用户主动编辑的本周参考。",
          supplements: ["用户选择保留为查看参考。"],
          days: Array.from({ length: 7 }, () => ({
            nutritionDirection: "维持正常餐盘结构。",
            proteinRangeGrams: { minimum: 90, maximum: 120 },
            plateGuidance: ["每餐有主要蛋白质来源。"],
            seasonalVegetables: ["番茄"],
            movement: { category: "recovery", durationMinutes: { minimum: 20, maximum: 30 }, intensity: "low", highIntensity: false, safetyReminder: "按当天实际舒适度决定。" }
          }))
        }
      });
      manualId = manual.plan.id;
      expect(manual.plan).toMatchObject({ state: "candidate", source: "manual", basedOnPlanId: active.plan.id, basedOnPlanVersion: active.plan.version });
      expect((await service.getWeek(weekStart)).active?.plan.id).toBe(active.plan.id);
      const updated = await service.updateManualCandidate(manual.plan.id, {
        expectedVersion: manual.plan.version,
        content: {
          overview: "这是经过用户再次手动编辑的本周参考。",
          supplements: ["用户确认保留为查看参考。"],
          days: Array.from({ length: 7 }, () => ({
            nutritionDirection: "维持正常餐盘结构。",
            proteinRangeGrams: { minimum: 90, maximum: 120 },
            plateGuidance: ["每餐有主要蛋白质来源。"],
            seasonalVegetables: ["番茄"],
            movement: { category: "recovery", durationMinutes: { minimum: 20, maximum: 30 }, intensity: "low", highIntensity: false, safetyReminder: "按当天实际舒适度决定。" }
          }))
        }
      });
      expect(updated.plan).toMatchObject({ id: manual.plan.id, state: "candidate", source: "manual", version: manual.plan.version + 1, overview: "这是经过用户再次手动编辑的本周参考。" });
      const confirmed = await service.confirm(updated.plan.id, updated.plan.version);
      expect(confirmed.plan).toMatchObject({ id: updated.plan.id, state: "active", source: "manual" });
    } finally {
      const planIds = [base.plan.id, ...(manualId ? [manualId] : [])];
      await connection.db.transaction(async (transaction) => {
        await transaction.delete(healthDailyReferences).where(inArray(healthDailyReferences.healthWeekPlanId, planIds));
        await transaction.delete(healthWeekPlans).where(inArray(healthWeekPlans.id, planIds));
      });
    }
  });

  it("binds template revisions to the active version and rejects a stale confirmation", async () => {
    const weekStart = "2099-04-12";
    const base = await service.createTemplateCandidate(weekStart, null);
    const active = await service.confirm(base.plan.id, base.plan.version);
    const revision = await service.createTemplateCandidate(weekStart, "周三外出，用餐场景会变化");
    try {
      expect(revision.plan).toMatchObject({
        state: "candidate",
        basedOnPlanId: active.plan.id,
        basedOnPlanVersion: active.plan.version
      });
      expect(revision.plan.revisionReason).toContain("修订候选");
      expect(revision.plan.overview).toContain("周三外出，用餐场景会变化");
      expect(revision.plan.overview).toContain("清明");
      expect((revision.days[0]?.content as { seasonalVegetables: string[] }).seasonalVegetables).toEqual(["菠菜", "芦笋"]);
      await connection.db.update(healthWeekPlans).set({ version: active.plan.version + 1 }).where(eq(healthWeekPlans.id, active.plan.id));
      await expect(service.confirm(revision.plan.id, revision.plan.version)).rejects.toBeInstanceOf(HealthPlanBaseChangedError);
      expect((await service.getWeek(weekStart)).active?.plan.id).toBe(active.plan.id);
    } finally {
      await connection.db.transaction(async (transaction) => {
        await transaction.delete(healthDailyReferences).where(inArray(healthDailyReferences.healthWeekPlanId, [base.plan.id, revision.plan.id]));
        await transaction.delete(healthWeekPlans).where(inArray(healthWeekPlans.id, [base.plan.id, revision.plan.id]));
      });
    }
  });
});
