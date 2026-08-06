import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { cyberDiaryContentSchema } from "@personal-ai/domain/diary";
import { cyberDiaries, focusSessions, reviewMessages, reviewSessions, taskFeedback, taskOutcomes, tasks } from "@personal-ai/db/schema";
import { buildDiaryDayData, type DailyStateTone } from "./diary-service.js";

type RadarKey = "mainlineProgress" | "overallExecution" | "focusQuality" | "energyState" | "wellbeing" | "growthGain";
type Day = {
  localDate: string;
  focusMinutes: number;
  closedTasks: number;
  plannedTasks: number;
  tone: DailyStateTone;
  radar: Array<{ key: RadarKey; label: string; value: number | null; source: "system" | "user" }>;
  points: number;
  hasData: boolean;
};

const radarOrder: RadarKey[] = ["mainlineProgress", "overallExecution", "focusQuality", "energyState", "wellbeing", "growthGain"];

function datesEndingAt(end: string, count: number) {
  const cursor = new Date(`${end}T00:00:00.000Z`);
  return Array.from({ length: count }, () => {
    const value = cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    return value;
  }).reverse();
}

function average(values: number[]) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

export class GrowthService {
  constructor(private readonly db: AppDatabase) {}

  async getSummary(endLocalDate: string, dayCount: 7 | 30 = 7) {
    const dates = datesEndingAt(endLocalDate, dayCount);
    const start = dates[0]!;
    const taskRows = await this.db.select().from(tasks).where(and(isNull(tasks.deletedAt), gte(tasks.localDate, start), lte(tasks.localDate, endLocalDate)));
    const taskIds = taskRows.map((task) => task.id);
    const [sessions, feedback, outcomes, reviews, diaryRows] = await Promise.all([
      taskIds.length ? this.db.select().from(focusSessions).where(inArray(focusSessions.taskId, taskIds)) : Promise.resolve([]),
      taskIds.length ? this.db.select().from(taskFeedback).where(inArray(taskFeedback.taskId, taskIds)) : Promise.resolve([]),
      taskIds.length ? this.db.select().from(taskOutcomes).where(inArray(taskOutcomes.taskId, taskIds)) : Promise.resolve([]),
      this.db.select().from(reviewSessions).where(and(gte(reviewSessions.localDate, start), lte(reviewSessions.localDate, endLocalDate))),
      this.db.select().from(cyberDiaries).where(and(gte(cyberDiaries.localDate, start), lte(cyberDiaries.localDate, endLocalDate)))
    ]);
    const reviewIds = reviews.map((review) => review.id);
    const messages = reviewIds.length
      ? await this.db.select({ reviewSessionId: reviewMessages.reviewSessionId }).from(reviewMessages).where(and(inArray(reviewMessages.reviewSessionId, reviewIds), eq(reviewMessages.source, "app")))
      : [];
    const reviewDates = new Map(reviews.map((review) => [review.id, review.localDate]));
    const reviewedDateSet = new Set(messages.map((message) => reviewDates.get(message.reviewSessionId)).filter((localDate): localDate is string => Boolean(localDate)));
    const savedRadarByDate = new Map(diaryRows.flatMap((diary) => {
      const parsed = cyberDiaryContentSchema.safeParse(diary.content);
      return parsed.success && parsed.data.radar ? [[diary.localDate, parsed.data.radar] as const] : [];
    }));

    const days: Day[] = dates.map((localDate) => {
      const dayTasks = taskRows.filter((task) => task.localDate === localDate);
      const dayTaskIds = new Set(dayTasks.map((task) => task.id));
      const dayData = buildDiaryDayData(
        dayTasks,
        sessions.filter((session) => dayTaskIds.has(session.taskId)),
        outcomes.filter((outcome) => dayTaskIds.has(outcome.taskId)),
        feedback.filter((item) => dayTaskIds.has(item.taskId)),
        reviewedDateSet.has(localDate)
      );
      const saved = savedRadarByDate.get(localDate);
      return {
        localDate,
        focusMinutes: dayData.effectiveFocusMinutes,
        closedTasks: dayData.closedTasks,
        plannedTasks: dayData.plannedTasks,
        tone: dayData.stateTone,
        radar: dayData.radar.map((metric) => ({
          ...metric,
          key: metric.key as RadarKey,
          value: saved ? saved[metric.key as RadarKey] : metric.value
        })),
        points: dayData.tree.points,
        hasData: dayData.plannedTasks > 0 || dayData.rawFocusMinutes > 0 || reviewedDateSet.has(localDate)
      };
    });
    const focusMinutes = days.reduce((sum, day) => sum + day.focusMinutes, 0);
    const plannedTasks = days.reduce((sum, day) => sum + day.plannedTasks, 0);
    const closedTasks = days.reduce((sum, day) => sum + day.closedTasks, 0);
    const satisfied = feedback.filter((item) => item.satisfaction === "satisfied").length;
    const neutral = feedback.filter((item) => item.satisfaction === "neutral").length;
    const dissatisfied = feedback.filter((item) => item.satisfaction === "dissatisfied").length;
    const latestOutcomeByTask = new Map<string, (typeof outcomes)[number]>();
    for (const outcome of outcomes) {
      const previous = latestOutcomeByTask.get(outcome.taskId);
      if (!previous || outcome.recordedAt > previous.recordedAt) latestOutcomeByTask.set(outcome.taskId, outcome);
    }
    const latestOutcomes = [...latestOutcomeByTask.values()];
    const quality = latestOutcomes.length ? Math.round(latestOutcomes.reduce((sum, outcome) => sum + outcome.progressPercent, 0) / latestOutcomes.length) : 0;
    const treeKind = quality >= 80 ? "常青树" : quality >= 45 ? "银杏" : latestOutcomes.length > 0 ? "苔藓" : "种子";
    const firstRadar = days[0]?.radar ?? [];
    const radar = radarOrder.map((key) => {
      const definition = firstRadar.find((metric) => metric.key === key)!;
      const values = days.flatMap((day) => {
        const value = day.radar.find((metric) => metric.key === key)?.value;
        if (definition.source === "system" && !day.hasData) return [];
        return typeof value === "number" ? [value] : [];
      });
      return { key, label: definition.label, source: definition.source, value: average(values), sampleDays: values.length };
    });
    return {
      range: { start, end: endLocalDate },
      days: days.map(({ radar: _radar, points: _points, hasData: _hasData, ...day }) => day),
      focusMinutes,
      plannedTasks,
      closedTasks,
      reviewedDays: reviewedDateSet.size,
      satisfaction: { satisfied, neutral, dissatisfied },
      radar,
      garden: {
        points: days.reduce((sum, day) => sum + day.points, 0),
        growthPercent: Math.min(100, Math.round(focusMinutes / 600 * 100)),
        treeKind,
        quality
      }
    };
  }
}
