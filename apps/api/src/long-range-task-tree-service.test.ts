import { afterAll, describe, expect, it } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { longRangePlanTaskTreeCandidates, longRangePlans, longRangePlanMilestones, taskLifecycleEvents, tasks } from "@personal-ai/db/schema";
import { LongRangePlanService } from "./long-range-plan-service.js";
import { LongRangeTaskTreeService } from "./long-range-task-tree-service.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
const plans = new LongRangePlanService(connection.db);
const trees = new LongRangeTaskTreeService(connection.db);
afterAll(async () => { await connection.client.end(); });

describe("long-range task-tree candidates", () => {
  it("keeps AI output editable and creates tasks only after explicit confirmation", async () => {
    const plan = await plans.create({ scope: "month", title: "2099 task tree", periodStart: "2099-05-01", periodEnd: "2099-05-31", description: "framework", milestones: [{ title: "资料范围", targetDate: "2099-05-08", notes: null }] });
    try {
      const candidate = await trees.createAiCandidate(plan.id, { expectedPlanVersion: plan.version, instructions: null }, { plan: async () => ({ summary: "先形成框架，再完成核验。", tasks: [{ title: "整理资料范围", targetDate: "2099-05-08", notes: "保留用户判断" }, { title: "复核阶段成果", targetDate: null, notes: null }] }) });
      expect(candidate.state).toBe("candidate");
      expect((await connection.db.select().from(tasks).where(eq(tasks.sourceLongRangePlanId, plan.id)))).toHaveLength(0);

      const edited = await trees.updateCandidate(candidate.id, { expectedVersion: candidate.version, expectedPlanVersion: plan.version, proposal: { summary: "用户已确认拆分边界。", tasks: [{ title: "整理资料范围（确认）", targetDate: "2099-05-09", notes: null }] } });
      const confirmed = await trees.confirmCandidate(candidate.id, { expectedVersion: edited.version, expectedPlanVersion: plan.version });
      expect(confirmed.taskIds).toHaveLength(1);
      expect(confirmed.candidate.state).toBe("confirmed");
      expect((await connection.db.select().from(tasks).where(inArray(tasks.id, confirmed.taskIds)))[0]?.sourceLongRangePlanId).toBe(plan.id);
      const repeated = await trees.confirmCandidate(candidate.id, { expectedVersion: edited.version, expectedPlanVersion: plan.version });
      expect(repeated.taskIds).toEqual(confirmed.taskIds);
    } finally {
      const candidates = await connection.db.select({ id: longRangePlanTaskTreeCandidates.id }).from(longRangePlanTaskTreeCandidates).where(eq(longRangePlanTaskTreeCandidates.longRangePlanId, plan.id));
      const sourceTasks = await connection.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.sourceLongRangePlanId, plan.id));
      await connection.db.transaction(async (transaction) => {
        if (sourceTasks.length) {
          await transaction.delete(taskLifecycleEvents).where(inArray(taskLifecycleEvents.taskId, sourceTasks.map((task) => task.id)));
          await transaction.delete(tasks).where(inArray(tasks.id, sourceTasks.map((task) => task.id)));
        }
        if (candidates.length) await transaction.delete(longRangePlanTaskTreeCandidates).where(inArray(longRangePlanTaskTreeCandidates.id, candidates.map((candidate) => candidate.id)));
        await transaction.delete(longRangePlanMilestones).where(eq(longRangePlanMilestones.longRangePlanId, plan.id));
        await transaction.delete(longRangePlans).where(eq(longRangePlans.id, plan.id));
      });
    }
  });
});
