import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { longRangePlanMilestones, longRangePlans, tasks } from "@personal-ai/db/schema";
import { eq } from "drizzle-orm";
import { LongRangePlanNotFoundError, LongRangePlanScopeLimitError, LongRangePlanService, LongRangePlanVersionConflictError } from "./long-range-plan-service.js";

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
      await service.delete(created.id, reactivated.version);
      await expect(service.get(created.id)).rejects.toBeInstanceOf(LongRangePlanNotFoundError);
    } finally {
      await connection.db.transaction(async (transaction) => {
        await transaction.delete(longRangePlanMilestones).where(eq(longRangePlanMilestones.longRangePlanId, created.id));
        await transaction.delete(longRangePlans).where(eq(longRangePlans.id, created.id));
      });
    }
  });

  it("counts archived plans toward the three-plan limit for each scope", async () => {
    const createdIds: string[] = [];
    try {
      const existing = await service.list("month", true);
      const availableSlots = Math.max(0, 3 - existing.length);
      for (let index = 0; index < availableSlots; index += 1) {
        const created = await service.create({
          scope: "month",
          title: `容量边界验收 ${index + 1}`,
          periodStart: `2098-0${index + 1}-01`,
          periodEnd: `2098-0${index + 1}-28`,
          description: "只用于验证每类最多三项。",
          milestones: []
        });
        createdIds.push(created.id);
      }
      if (createdIds.length > 0) {
        const newest = await service.get(createdIds.at(-1)!);
        await service.setStatus(newest.id, newest.version, "archived");
      }
      const fourthAttempt = service.create({
        scope: "month",
        title: "不应创建的第四项",
        periodStart: "2098-12-01",
        periodEnd: "2098-12-31",
        description: null,
        milestones: []
      }).then((plan) => {
        // Keep an unexpected successful write in the cleanup set so a failed
        // assertion cannot pollute the next database-backed test run.
        createdIds.push(plan.id);
        return plan;
      });
      await expect(fourthAttempt).rejects.toBeInstanceOf(LongRangePlanScopeLimitError);
    } finally {
      for (const id of createdIds) {
        await connection.db.delete(longRangePlanMilestones).where(eq(longRangePlanMilestones.longRangePlanId, id));
        await connection.db.delete(longRangePlans).where(eq(longRangePlans.id, id));
      }
    }
  });

  it("deletes the plan while preserving generated tasks as independent tasks", async () => {
    const planId = randomUUID();
    const taskId = randomUUID();
    try {
      await connection.db.insert(longRangePlans).values({
        id: planId,
        scope: "semester",
        title: "删除规划保留任务验收",
        periodStart: "2097-09-01",
        periodEnd: "2098-01-31",
        description: "规划可以删除，任务不能被连带删除。",
        status: "active",
        version: 1
      });
      await connection.db.insert(tasks).values({
        id: taskId,
        title: "由规划生成但需要保留的任务",
        recordKind: "formal",
        lifecycleStatus: "open",
        scheduleKind: "none",
        localDate: "2097-09-01",
        sourceLongRangePlanId: planId
      });

      await service.delete(planId, 1);

      await expect(service.get(planId)).rejects.toBeInstanceOf(LongRangePlanNotFoundError);
      const [preservedTask] = await connection.db.select().from(tasks).where(eq(tasks.id, taskId));
      expect(preservedTask).toMatchObject({ id: taskId, sourceLongRangePlanId: null });
    } finally {
      await connection.db.delete(tasks).where(eq(tasks.id, taskId));
      await connection.db.delete(longRangePlanMilestones).where(eq(longRangePlanMilestones.longRangePlanId, planId));
      await connection.db.delete(longRangePlans).where(eq(longRangePlans.id, planId));
    }
  });
});
