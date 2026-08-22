import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { cyberDiaries, dailyBriefs, focusSessionSegmentRuns, focusSessions, focusStructures, reviewMessages, reviewSessions, taskFeedback, taskOutcomes, tasks } from "@personal-ai/db/schema";
import { eq } from "drizzle-orm";
import { bambooCountForPlannedTasks, GrowthService } from "./growth-service.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());

afterAll(async () => { await connection.client.end(); });

describe("bamboo count", () => {
  it("follows the planned-task bands", () => {
    expect(bambooCountForPlannedTasks(0)).toBe(0);
    expect(bambooCountForPlannedTasks(1)).toBe(1);
    expect(bambooCountForPlannedTasks(2)).toBe(1);
    expect(bambooCountForPlannedTasks(3)).toBe(2);
    expect(bambooCountForPlannedTasks(4)).toBe(2);
    expect(bambooCountForPlannedTasks(5)).toBe(4);
  });
});

function uniqueFutureDate(): string {
  const offset = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 6), 16) % 6_000;
  return new Date(Date.UTC(2080, 0, 1 + offset)).toISOString().slice(0, 10);
}

describe("GrowthService", () => {
  it("reports 55 focus minutes for an ended 55 + 5 structured session before evaluation", async () => {
    const localDate = "2099-10-14";
    const taskId = randomUUID();
    const sessionId = randomUUID();
    const structureId = randomUUID();
    const focusRunId = randomUUID();
    const breakRunId = randomUUID();
    try {
      await connection.db.insert(tasks).values({
        id: taskId,
        title: "已结束但尚未评价的专注",
        lifecycleStatus: "awaiting_outcome",
        scheduleKind: "none",
        localDate
      });
      await connection.db.insert(focusStructures).values({
        id: structureId,
        taskId,
        taskScheduleRevision: 1,
        state: "superseded",
        source: "manual",
        mode: "segmented",
        totalStartAt: new Date("2099-10-14T01:00:00.000Z"),
        totalEndAt: new Date("2099-10-14T02:00:00.000Z")
      });
      await connection.db.insert(focusSessions).values({
        id: sessionId,
        taskId,
        focusStructureId: structureId,
        focusStructureVersion: 1,
        focusStructureScheduleRevision: 1,
        state: "ended",
        rawActiveSeconds: 3435,
        effectiveFocusSeconds: 0,
        endedAt: new Date("2099-10-14T02:00:00.000Z")
      });
      await connection.db.insert(focusSessionSegmentRuns).values([
        { id: focusRunId, focusSessionId: sessionId, position: 0, segmentType: "focus", plannedDurationSeconds: 3300, elapsedSeconds: 3300 },
        { id: breakRunId, focusSessionId: sessionId, position: 1, segmentType: "break", plannedDurationSeconds: 300, elapsedSeconds: 135 }
      ]);

      const summary = await new GrowthService(connection.db).getSummary(localDate, 7);

      expect(summary.focusMinutes).toBe(55);
      expect(summary.days.find((day) => day.localDate === localDate)?.focusMinutes).toBe(55);
      expect(summary.garden.growthPercent).toBe(0);
    } finally {
      await connection.db.delete(focusSessionSegmentRuns).where(eq(focusSessionSegmentRuns.focusSessionId, sessionId));
      await connection.db.delete(focusSessions).where(eq(focusSessions.id, sessionId));
      await connection.db.delete(focusStructures).where(eq(focusStructures.id, structureId));
      await connection.db.delete(tasks).where(eq(tasks.id, taskId));
    }
  });

  it("aggregates saved diary ratings and derives state color from subjective feedback", async () => {
    const localDate = uniqueFutureDate();
    const ids = {
      review: randomUUID(), message: randomUUID(), brief: randomUUID(), diary: randomUUID(),
      task: randomUUID(), session: randomUUID(), outcome: randomUUID(), feedback: randomUUID(),
      backfillTask: randomUUID(), backfillSession: randomUUID(), backfillOutcome: randomUUID(), backfillFeedback: randomUUID()
    };
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
            radar: { mainlineProgress: 100, overallExecution: 80, focusQuality: 60, energyState: 80, wellbeing: 60, growthGain: 80 }
          }
        });
        await transaction.insert(tasks).values({ id: ids.task, title: "成长测试", lifecycleStatus: "closed", currentOutcome: "partial", scheduleKind: "none", localDate });
        await transaction.insert(focusSessions).values({ id: ids.session, taskId: ids.task, state: "evaluated", rawActiveSeconds: 3600, effectiveFocusSeconds: 3000 });
        await transaction.insert(taskOutcomes).values({ id: ids.outcome, taskId: ids.task, focusSessionId: ids.session, outcome: "partial", progressPercent: 70, source: "app" });
        await transaction.insert(taskFeedback).values({ id: ids.feedback, taskId: ids.task, focusSessionId: ids.session, satisfaction: "dissatisfied" });
        await transaction.insert(tasks).values({ id: ids.backfillTask, title: "不计分的事实补录", recordKind: "backfill", lifecycleStatus: "closed", currentOutcome: "complete", scheduleKind: "none", localDate });
        await transaction.insert(focusSessions).values({ id: ids.backfillSession, taskId: ids.backfillTask, state: "evaluated", rawActiveSeconds: 7200, effectiveFocusSeconds: 7200 });
        await transaction.insert(taskOutcomes).values({ id: ids.backfillOutcome, taskId: ids.backfillTask, focusSessionId: ids.backfillSession, outcome: "complete", progressPercent: 100, source: "app" });
        await transaction.insert(taskFeedback).values({ id: ids.backfillFeedback, taskId: ids.backfillTask, focusSessionId: ids.backfillSession, satisfaction: "satisfied" });
      });

      const summary = await new GrowthService(connection.db).getSummary(localDate, 7);
      expect(summary.days.find((day) => day.localDate === localDate)?.tone).toBe("strained");
      expect(summary.reviewedDays).toBe(1);
      expect(summary.plannedTasks).toBe(1);
      expect(summary.focusMinutes).toBe(50);
      expect(summary.radar.find((metric) => metric.key === "mainlineProgress")).toMatchObject({ value: 100, sampleDays: 1, source: "system" });
      expect(summary.radar.find((metric) => metric.key === "energyState")).toMatchObject({ value: 80, sampleDays: 1, source: "user" });
      expect(summary.garden.quality).toBe(70);
      expect(summary.garden.growthPercent).toBe(25);
      expect(summary.completedTasks).toBe(1);
      expect(summary.garden).toMatchObject({
        points: 52,
        scoredDays: 1,
        pointsBreakdown: { execution: 31, focus: 7, satisfaction: 4, review: 10 }
      });
      expect(summary.days.find((day) => day.localDate === localDate)).toMatchObject({
        points: 52,
        pointsBreakdown: { execution: 31, focus: 7, satisfaction: 4, review: 10 }
      });
      const annual = await new GrowthService(connection.db).getSummary(localDate, 365);
      expect(annual.days).toHaveLength(365);
      expect(annual.focusTrend.granularity).toBe("month");
      expect(annual.focusTrend.points.length).toBeGreaterThanOrEqual(12);
      expect(annual.focusTrend.points.length).toBeLessThanOrEqual(13);
    } finally {
      await connection.db.delete(taskFeedback).where(eq(taskFeedback.id, ids.backfillFeedback));
      await connection.db.delete(taskFeedback).where(eq(taskFeedback.id, ids.feedback));
      await connection.db.delete(taskOutcomes).where(eq(taskOutcomes.id, ids.backfillOutcome));
      await connection.db.delete(taskOutcomes).where(eq(taskOutcomes.id, ids.outcome));
      await connection.db.delete(focusSessions).where(eq(focusSessions.id, ids.backfillSession));
      await connection.db.delete(focusSessions).where(eq(focusSessions.id, ids.session));
      await connection.db.delete(tasks).where(eq(tasks.id, ids.backfillTask));
      await connection.db.delete(tasks).where(eq(tasks.id, ids.task));
      await connection.db.delete(cyberDiaries).where(eq(cyberDiaries.id, ids.diary));
      await connection.db.delete(dailyBriefs).where(eq(dailyBriefs.id, ids.brief));
      await connection.db.delete(reviewMessages).where(eq(reviewMessages.id, ids.message));
      await connection.db.delete(reviewSessions).where(eq(reviewSessions.id, ids.review));
    }
  });
});
