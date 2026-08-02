import { afterAll, describe, expect, it } from "vitest";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { longRangePlanMilestones, longRangePlans } from "@personal-ai/db/schema";
import { eq } from "drizzle-orm";
import { LongRangePlanService, LongRangePlanVersionConflictError } from "./long-range-plan-service.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
const service = new LongRangePlanService(connection.db);

afterAll(async () => { await connection.client.end(); });

describe("long-range plan persistence", () => {
  it("creates, version-updates, archives, and restores a manual plan with milestones", async () => {
    const created = await service.create({
      scope: "month",
      title: "2099 年 4 月主线",
      periodStart: "2099-04-01",
      periodEnd: "2099-04-30",
      description: "只保存用户主动维护的主线。",
      milestones: [
        { title: "确认资料范围", targetDate: "2099-04-08", notes: "保持适中的拆分粒度" },
        { title: "复核阶段成果", targetDate: "2099-04-25", notes: null }
      ]
    });
    try {
      expect(created).toMatchObject({ scope: "month", status: "active", version: 1 });
      expect(created.milestones).toHaveLength(2);

      const restored = await service.get(created.id);
      expect(restored.milestones.map((milestone) => milestone.title)).toEqual(["确认资料范围", "复核阶段成果"]);

      const updated = await service.update(created.id, {
        expectedVersion: created.version,
        scope: "month",
        title: "2099 年 4 月主线（修订）",
        periodStart: "2099-04-01",
        periodEnd: "2099-04-30",
        description: "用户明确修订后的内容。",
        milestones: [{ title: "复核阶段成果", targetDate: "2099-04-25", notes: "保留手动决定" }]
      });
      expect(updated).toMatchObject({ title: "2099 年 4 月主线（修订）", version: 2 });
      expect(updated.milestones).toHaveLength(1);

      await expect(service.update(created.id, {
        expectedVersion: 1,
        scope: "month",
        title: "过期写入",
        periodStart: "2099-04-01",
        periodEnd: "2099-04-30",
        description: null,
        milestones: []
      })).rejects.toBeInstanceOf(LongRangePlanVersionConflictError);

      const archived = await service.setStatus(created.id, updated.version, "archived");
      expect(archived).toMatchObject({ status: "archived", version: 3 });
      expect((await service.list("month")).some((plan) => plan.id === created.id)).toBe(false);
      expect((await service.list("month", true)).find((plan) => plan.id === created.id)?.status).toBe("archived");

      const reactivated = await service.setStatus(created.id, archived.version, "active");
      expect(reactivated).toMatchObject({ status: "active", version: 4, archivedAt: null });
    } finally {
      await connection.db.transaction(async (transaction) => {
        await transaction.delete(longRangePlanMilestones).where(eq(longRangePlanMilestones.longRangePlanId, created.id));
        await transaction.delete(longRangePlans).where(eq(longRangePlans.id, created.id));
      });
    }
  });
});
