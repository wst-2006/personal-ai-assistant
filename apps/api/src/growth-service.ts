import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { cyberDiaryContentSchema } from "@personal-ai/domain/diary";
import { reviewRadarSnapshotSchema, type ReviewRadar } from "@personal-ai/domain/review";
import { cyberDiaries, focusSessionSegmentRuns, focusSessions, reviewMessages, reviewSessions, taskFeedback, taskOutcomes, tasks } from "@personal-ai/db/schema";
import { buildDiaryDayData, type DailyGrowthBreakdown, type DailyStateTone } from "./diary-service.js";

type RadarKey = "mainlineProgress" | "overallExecution" | "focusQuality" | "energyState" | "wellbeing" | "growthGain";
export type GrowthWindowDays = 1 | 7 | 30 | 90 | 365;
type Day = {
  localDate: string;
  focusMinutes: number;
  closedTasks: number;
  completedTasks: number;
  plannedTasks: number;
  tone: DailyStateTone;
  radar: Array<{ key: RadarKey; label: string; value: number | null; source: "system" | "user" }>;
  points: number;
  pointsBreakdown: DailyGrowthBreakdown;
  executionPercent: number;
  satisfactionPercent: number;
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

function datesBetween(start: string, end: string) {
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const endDate = new Date(`${end}T00:00:00.000Z`);
  const dates: string[] = [];
  while (cursor <= endDate) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function growthRange(endLocalDate: string, dayCount: GrowthWindowDays) {
  if (dayCount === 7) {
    const anchor = new Date(`${endLocalDate}T00:00:00.000Z`);
    const day = anchor.getUTCDay();
    const mondayOffset = day === 0 ? 6 : day - 1;
    anchor.setUTCDate(anchor.getUTCDate() - mondayOffset);
    const start = anchor.toISOString().slice(0, 10);
    anchor.setUTCDate(anchor.getUTCDate() + 6);
    const end = anchor.toISOString().slice(0, 10);
    return { start, end, dates: datesBetween(start, end) };
  }
  if (dayCount === 30) {
    const [year, month] = endLocalDate.slice(0, 7).split("-").map(Number);
    const start = `${endLocalDate.slice(0, 7)}-01`;
    const end = new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10);
    return { start, end, dates: datesBetween(start, end) };
  }
  const dates = datesEndingAt(endLocalDate, dayCount);
  return { start: dates[0]!, end: dates.at(-1)!, dates };
}

function average(values: number[]) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function parseRadarMessage(content: string): ReviewRadar | null {
  try {
    return reviewRadarSnapshotSchema.parse(JSON.parse(content)).radar;
  } catch {
    return null;
  }
}

function averageBreakdown(days: Day[]): DailyGrowthBreakdown {
  const activeDays = days.filter((day) => day.hasData);
  if (activeDays.length === 0) return { execution: 0, focus: 0, satisfaction: 0, review: 0 };
  return {
    execution: average(activeDays.map((day) => day.pointsBreakdown.execution)) ?? 0,
    focus: average(activeDays.map((day) => day.pointsBreakdown.focus)) ?? 0,
    satisfaction: average(activeDays.map((day) => day.pointsBreakdown.satisfaction)) ?? 0,
    review: average(activeDays.map((day) => day.pointsBreakdown.review)) ?? 0
  };
}

function satisfactionPercent(satisfaction: { satisfied: number; neutral: number; dissatisfied: number }) {
  const count = satisfaction.satisfied + satisfaction.neutral + satisfaction.dissatisfied;
  if (count === 0) return 0;
  return Math.round((satisfaction.satisfied * 100 + satisfaction.neutral * 60 + satisfaction.dissatisfied * 20) / count);
}

function taskCountGrowthCap(plannedTasks: number) {
  if (plannedTasks <= 0) return 0;
  if (plannedTasks <= 2) return 45;
  if (plannedTasks <= 4) return 75;
  return 100;
}

function dailyGrowthScore(day: Day) {
  const growthCap = taskCountGrowthCap(day.plannedTasks);
  const baseGrowthScore = Math.round(day.executionPercent * 0.7 + day.satisfactionPercent * 0.3);
  return {
    growthCap,
    baseGrowthScore,
    growthPercent: Math.min(growthCap, Math.round(baseGrowthScore * growthCap / 100))
  };
}

export function bambooCountForPlannedTasks(plannedTasks: number) {
  if (plannedTasks <= 0) return 0;
  if (plannedTasks <= 2) return 1;
  if (plannedTasks <= 4) return 2;
  return 4;
}

function weekKey(localDate: string) {
  const date = new Date(`${localDate}T00:00:00.000Z`);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1));
  return date.toISOString().slice(0, 10);
}

function buildFocusTrend(days: Day[], dayCount: GrowthWindowDays) {
  const granularity = dayCount === 365 ? "month" : dayCount === 90 ? "week" : "day";
  const buckets = new Map<string, { startDate: string; endDate: string; focusMinutes: number }>();
  for (const day of days) {
    const key = granularity === "month" ? day.localDate.slice(0, 7) : granularity === "week" ? weekKey(day.localDate) : day.localDate;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.endDate = day.localDate;
      bucket.focusMinutes += day.focusMinutes;
    } else {
      buckets.set(key, { startDate: day.localDate, endDate: day.localDate, focusMinutes: day.focusMinutes });
    }
  }
  return { granularity, points: [...buckets.values()] };
}

export class GrowthService {
  constructor(private readonly db: AppDatabase) {}

  async getSummary(endLocalDate: string, dayCount: GrowthWindowDays = 7) {
    const range = growthRange(endLocalDate, dayCount);
    const { start, end, dates } = range;
    const taskRows = await this.db.select().from(tasks).where(and(eq(tasks.recordKind, "formal"), isNull(tasks.deletedAt), gte(tasks.localDate, start), lte(tasks.localDate, end)));
    const taskIds = taskRows.map((task) => task.id);
    const [sessions, feedback, outcomes, reviews, diaryRows] = await Promise.all([
      taskIds.length ? this.db.select().from(focusSessions).where(inArray(focusSessions.taskId, taskIds)) : Promise.resolve([]),
      taskIds.length ? this.db.select().from(taskFeedback).where(inArray(taskFeedback.taskId, taskIds)) : Promise.resolve([]),
      taskIds.length ? this.db.select().from(taskOutcomes).where(inArray(taskOutcomes.taskId, taskIds)) : Promise.resolve([]),
      this.db.select().from(reviewSessions).where(and(gte(reviewSessions.localDate, start), lte(reviewSessions.localDate, end))),
      this.db.select().from(cyberDiaries).where(and(gte(cyberDiaries.localDate, start), lte(cyberDiaries.localDate, end)))
    ]);
    const reviewIds = reviews.map((review) => review.id);
    const sessionIds = sessions.map((session) => session.id);
    const segmentRuns = sessionIds.length
      ? await this.db.select().from(focusSessionSegmentRuns).where(inArray(focusSessionSegmentRuns.focusSessionId, sessionIds))
      : [];
    const taskIdBySessionId = new Map(sessions.map((session) => [session.id, session.taskId]));
    const segmentRunsByTaskId = new Map<string, typeof segmentRuns>();
    for (const run of segmentRuns) {
      const taskId = taskIdBySessionId.get(run.focusSessionId);
      if (!taskId) continue;
      const taskRuns = segmentRunsByTaskId.get(taskId) ?? [];
      taskRuns.push(run);
      segmentRunsByTaskId.set(taskId, taskRuns);
    }
    const messages = reviewIds.length
      ? await this.db.select({ reviewSessionId: reviewMessages.reviewSessionId }).from(reviewMessages).where(and(inArray(reviewMessages.reviewSessionId, reviewIds), eq(reviewMessages.source, "app")))
      : [];
    const radarMessages = reviewIds.length
      ? await this.db.select({ reviewSessionId: reviewMessages.reviewSessionId, content: reviewMessages.content, createdAt: reviewMessages.createdAt }).from(reviewMessages).where(and(inArray(reviewMessages.reviewSessionId, reviewIds), eq(reviewMessages.source, "radar"))).orderBy(reviewMessages.createdAt)
      : [];
    const reviewDates = new Map(reviews.map((review) => [review.id, review.localDate]));
    const reviewedDateSet = new Set(messages.map((message) => reviewDates.get(message.reviewSessionId)).filter((localDate): localDate is string => Boolean(localDate)));
    const savedRadarByDate = new Map(diaryRows.flatMap((diary) => {
      const parsed = cyberDiaryContentSchema.safeParse(diary.content);
      return parsed.success && parsed.data.radar ? [[diary.localDate, parsed.data.radar] as const] : [];
    }));
    for (const message of radarMessages) {
      const localDate = reviewDates.get(message.reviewSessionId);
      const radar = parseRadarMessage(message.content);
      if (localDate && radar) savedRadarByDate.set(localDate, radar);
    }

    const latestFeedbackByTask = new Map<string, (typeof feedback)[number]>();
    for (const item of feedback) {
      const previous = latestFeedbackByTask.get(item.taskId);
      if (!previous || item.createdAt > previous.createdAt) latestFeedbackByTask.set(item.taskId, item);
    }
    const latestFeedback = [...latestFeedbackByTask.values()];

    const days: Day[] = dates.map((localDate) => {
      const dayTasks = taskRows.filter((task) => task.localDate === localDate);
      const dayTaskIds = new Set(dayTasks.map((task) => task.id));
      const dayData = buildDiaryDayData(
        dayTasks,
        sessions.filter((session) => dayTaskIds.has(session.taskId)),
        outcomes.filter((outcome) => dayTaskIds.has(outcome.taskId)),
         feedback.filter((item) => dayTaskIds.has(item.taskId)),
         reviewedDateSet.has(localDate),
         dayTasks.flatMap((task) => segmentRunsByTaskId.get(task.id) ?? [])
       );
      const saved = savedRadarByDate.get(localDate);
      const executionPercent = dayData.radar.find((metric) => metric.key === "overallExecution")?.value ?? 0;
      return {
        localDate,
        focusMinutes: dayData.effectiveFocusMinutes,
        closedTasks: dayData.closedTasks,
        completedTasks: dayData.completedTasks,
        plannedTasks: dayData.plannedTasks,
        tone: dayData.stateTone,
        radar: dayData.radar.map((metric) => ({
          ...metric,
          key: metric.key as RadarKey,
          value: saved ? saved[metric.key as RadarKey] : metric.value
        })),
        points: dayData.tree.points,
        pointsBreakdown: dayData.tree.pointsBreakdown,
        executionPercent,
        satisfactionPercent: satisfactionPercent(dayData.satisfaction),
        hasData: dayData.plannedTasks > 0 || dayData.rawFocusMinutes > 0 || reviewedDateSet.has(localDate)
      };
    });
    const focusMinutes = days.reduce((sum, day) => sum + day.focusMinutes, 0);
    const plannedTasks = days.reduce((sum, day) => sum + day.plannedTasks, 0);
    const closedTasks = days.reduce((sum, day) => sum + day.closedTasks, 0);
    const completedTasks = days.reduce((sum, day) => sum + day.completedTasks, 0);
    const currentDay = days.find((day) => day.localDate === endLocalDate) ?? days.at(-1);
    const activeDays = days.filter((day) => day.hasData);
    const currentDayScore = currentDay ? dailyGrowthScore(currentDay) : { growthCap: 0, baseGrowthScore: 0, growthPercent: 0 };
    const periodGrowthScore = dayCount === 1
      ? currentDayScore
      : {
          growthCap: average(activeDays.map((day) => dailyGrowthScore(day).growthCap)) ?? 0,
          baseGrowthScore: average(activeDays.map((day) => dailyGrowthScore(day).baseGrowthScore)) ?? 0,
          growthPercent: average(activeDays.map((day) => dailyGrowthScore(day).growthPercent)) ?? 0
        };
    const executionPercent = currentDay?.executionPercent ?? 0;
    const currentSatisfactionPercent = currentDay?.satisfactionPercent ?? 0;
    const currentBambooCount = bambooCountForPlannedTasks(currentDay?.plannedTasks ?? 0);
    const satisfied = latestFeedback.filter((item) => item.satisfaction === "satisfied").length;
    const neutral = latestFeedback.filter((item) => item.satisfaction === "neutral").length;
    const dissatisfied = latestFeedback.filter((item) => item.satisfaction === "dissatisfied").length;
    const latestOutcomeByTask = new Map<string, (typeof outcomes)[number]>();
    for (const outcome of outcomes) {
      const previous = latestOutcomeByTask.get(outcome.taskId);
      if (!previous || outcome.recordedAt > previous.recordedAt) latestOutcomeByTask.set(outcome.taskId, outcome);
    }
    const latestOutcomes = [...latestOutcomeByTask.values()];
    const quality = latestOutcomes.length ? Math.round(latestOutcomes.reduce((sum, outcome) => sum + outcome.progressPercent, 0) / latestOutcomes.length) : 0;
    const treeKind = currentDayScore.growthPercent >= 80 ? "竹林" : currentDayScore.growthPercent >= 50 ? "新竹" : currentDayScore.growthPercent > 0 ? "竹笋" : "空庭";
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
    const pointsBreakdown = averageBreakdown(days);
    return {
      range: { start, end },
      selectedDate: endLocalDate,
      days: days.map(({ radar: _radar, executionPercent: _executionPercent, satisfactionPercent: _satisfactionPercent, hasData: _hasData, ...day }) => day),
      focusTrend: buildFocusTrend(days, dayCount),
      focusMinutes,
      plannedTasks,
      closedTasks,
      completedTasks,
      periodGrowthPercent: periodGrowthScore.growthPercent,
      reviewedDays: reviewedDateSet.size,
      satisfaction: { satisfied, neutral, dissatisfied },
      radar,
      currentRadar: currentDay?.radar ?? [],
      currentRadarSaved: savedRadarByDate.has(endLocalDate),
      garden: {
        points: average(activeDays.map((day) => day.points)) ?? 0,
        pointsBreakdown,
        scoredDays: activeDays.length,
        growthPercent: currentDayScore.growthPercent,
        growthCap: currentDayScore.growthCap,
        baseGrowthScore: currentDayScore.baseGrowthScore,
        executionPercent,
        satisfactionPercent: currentSatisfactionPercent,
        bambooCount: currentBambooCount,
        treeKind,
        quality
      }
    };
  }
}
