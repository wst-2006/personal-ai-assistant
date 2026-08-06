import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { cyberDiaries, dailyBriefs, focusSessions, reviewMessages, reviewSessions, taskFeedback, taskOutcomes, tasks } from "@personal-ai/db/schema";
import { eq } from "drizzle-orm";
import { GrowthService } from "./growth-service.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());

afterAll(async () => { await connection.client.end(); });

describe("GrowthService", () => {
  it("aggregates saved diary ratings and derives state color from subjective feedback", async () => {
    const localDate = "2099-10-15";
    const ids = { review: randomUUID(), message: randomUUID(), brief: randomUUID(), diary: randomUUID(), task: randomUUID(), session: randomUUID(), outcome: randomUUID(), feedback: randomUUID() };
    try {
      await connection.db.transaction(async (transaction) => {
        await transaction.insert(reviewSessions).values({ id: ids.review, localDate, state: "review_has_message" });
        await transaction.insert(reviewMessages).values({ id: ids.message, reviewSessionId: ids.review, source: "app", content: "用户主动复盘" });
        await transaction.insert(dailyBriefs).values({
          id: ids.brief, localDate, reviewSessionId: ids.review, state: "confirmed",
          content: { title: "简报", reflection: "复盘", taskSummary: "任务", sections: [] }, sources: []
        });
        await transaction.insert(cyberDiaries).values({
          id: ids.diary, localDate, reviewSessionId: ids.review, briefId: ids.brief,
          content: {
            title: "日记", body: "正文",
            radar: { mainlineProgress: 90, overallExecution: 75, focusQuality: 65, energyState: 80, wellbeing: 60, growthGain: 85 }
          }
        });
        await transaction.insert(tasks).values({ id: ids.task, title: "成长测试", lifecycleStatus: "closed", currentOutcome: "partial", scheduleKind: "none", localDate });
        await transaction.insert(focusSessions).values({ id: ids.session, taskId: ids.task, state: "evaluated", rawActiveSeconds: 3600, effectiveFocusSeconds: 3000 });
        await transaction.insert(taskOutcomes).values({ id: ids.outcome, taskId: ids.task, focusSessionId: ids.session, outcome: "partial", progressPercent: 70, source: "app" });
        await transaction.insert(taskFeedback).values({ id: ids.feedback, taskId: ids.task, focusSessionId: ids.session, satisfaction: "dissatisfied" });
      });

      const summary = await new GrowthService(connection.db).getSummary(localDate, 7);
      expect(summary.days.find((day) => day.localDate === localDate)?.tone).toBe("strained");
      expect(summary.reviewedDays).toBe(1);
      expect(summary.radar.find((metric) => metric.key === "mainlineProgress")).toMatchObject({ value: 90, sampleDays: 1, source: "system" });
      expect(summary.radar.find((metric) => metric.key === "energyState")).toMatchObject({ value: 80, sampleDays: 1, source: "user" });
      expect(summary.garden.quality).toBe(70);
    } finally {
      await connection.db.delete(taskFeedback).where(eq(taskFeedback.id, ids.feedback));
      await connection.db.delete(taskOutcomes).where(eq(taskOutcomes.id, ids.outcome));
      await connection.db.delete(focusSessions).where(eq(focusSessions.id, ids.session));
      await connection.db.delete(tasks).where(eq(tasks.id, ids.task));
      await connection.db.delete(cyberDiaries).where(eq(cyberDiaries.id, ids.diary));
      await connection.db.delete(dailyBriefs).where(eq(dailyBriefs.id, ids.brief));
      await connection.db.delete(reviewMessages).where(eq(reviewMessages.id, ids.message));
      await connection.db.delete(reviewSessions).where(eq(reviewSessions.id, ids.review));
    }
  });
});
