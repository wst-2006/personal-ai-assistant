import { afterAll, describe, expect, it } from "vitest";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { healthDailyReferences, healthWeekPlans } from "@personal-ai/db/schema";
import { eq } from "drizzle-orm";
import { HealthService } from "./health-service.js";

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
});
