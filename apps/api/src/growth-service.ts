import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { focusSessions, reviewMessages, reviewSessions, taskFeedback, tasks } from "@personal-ai/db/schema";

type Day = { localDate: string; focusMinutes: number; closedTasks: number; plannedTasks: number; tone: "quiet" | "steady" | "bright" };

function datesEndingAt(end: string, count: number) {
  const cursor = new Date(`${end}T00:00:00.000Z`);
  return Array.from({ length: count }, () => {
    const value = cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    return value;
  }).reverse();
}

export class GrowthService {
  constructor(private readonly db: AppDatabase) {}

  async getSummary(endLocalDate: string, dayCount: 7 | 30 = 7) {
    const dates = datesEndingAt(endLocalDate, dayCount);
    const start = dates[0]!;
    const taskRows = await this.db.select().from(tasks).where(and(isNull(tasks.deletedAt), gte(tasks.localDate, start), lte(tasks.localDate, endLocalDate)));
    const taskIds = taskRows.map((task) => task.id);
    const sessions = taskIds.length ? await this.db.select().from(focusSessions).where(inArray(focusSessions.taskId, taskIds)) : [];
    const feedback = taskIds.length ? await this.db.select().from(taskFeedback).where(inArray(taskFeedback.taskId, taskIds)) : [];
    const reviews = await this.db.select().from(reviewSessions).where(and(gte(reviewSessions.localDate, start), lte(reviewSessions.localDate, endLocalDate)));
    const reviewIds = reviews.map((review) => review.id);
    const messages = reviewIds.length ? await this.db.select({ reviewSessionId: reviewMessages.reviewSessionId }).from(reviewMessages).where(and(inArray(reviewMessages.reviewSessionId, reviewIds), eq(reviewMessages.source, "app"))) : [];
    const reviewDates = new Map(reviews.map((review) => [review.id, review.localDate]));
    const minutesByTask = new Map<string, number>();
    for (const session of sessions) minutesByTask.set(session.taskId, (minutesByTask.get(session.taskId) ?? 0) + Math.round(session.effectiveFocusSeconds / 60));
    const days: Day[] = dates.map((localDate) => {
      const dayTasks = taskRows.filter((task) => task.localDate === localDate);
      const focusMinutes = dayTasks.reduce((sum, task) => sum + (minutesByTask.get(task.id) ?? 0), 0);
      const closedTasks = dayTasks.filter((task) => task.lifecycleStatus === "closed").length;
      const plannedTasks = dayTasks.filter((task) => task.lifecycleStatus !== "cancelled").length;
      return { localDate, focusMinutes, closedTasks, plannedTasks, tone: focusMinutes >= 60 && closedTasks > 0 ? "bright" : focusMinutes > 0 || closedTasks > 0 ? "steady" : "quiet" };
    });
    const focusMinutes = days.reduce((sum, day) => sum + day.focusMinutes, 0);
    const plannedTasks = days.reduce((sum, day) => sum + day.plannedTasks, 0);
    const closedTasks = days.reduce((sum, day) => sum + day.closedTasks, 0);
    const outcomes = taskRows.filter((task) => task.currentOutcome !== null);
    const complete = outcomes.filter((task) => task.currentOutcome === "complete").length;
    const satisfied = feedback.filter((item) => item.satisfaction === "satisfied").length;
    const neutral = feedback.filter((item) => item.satisfaction === "neutral").length;
    const dissatisfied = feedback.filter((item) => item.satisfaction === "dissatisfied").length;
    const activeDays = days.filter((day) => day.focusMinutes > 0).length;
    const reviewedDays = new Set(messages.map((message) => reviewDates.get(message.reviewSessionId)).filter((localDate): localDate is string => Boolean(localDate))).size;
    const deepFocusMinutes = focusMinutes;
    const percentage = (value: number, total: number) => total ? Math.round(value / total * 100) : 0;
    const completion = percentage(closedTasks, plannedTasks);
    const quality = percentage(complete, outcomes.length);
    const balance = percentage(satisfied + neutral, feedback.length);
    const treeKind = quality >= 80 ? "常青树" : quality >= 45 ? "银杏" : outcomes.length > 0 ? "苔藓" : "种子";
    return {
      range: { start, end: endLocalDate }, days, focusMinutes, plannedTasks, closedTasks,
      satisfaction: { satisfied, neutral, dissatisfied },
      radar: [
        { key: "focus", label: "专注", value: Math.min(100, Math.round(focusMinutes / 300 * 100)) },
        { key: "completion", label: "完成", value: completion },
        { key: "consistency", label: "连续", value: Math.round(activeDays / dates.length * 100) },
        { key: "depth", label: "深度", value: Math.min(100, Math.round(deepFocusMinutes / 180 * 100)) },
        { key: "review", label: "复盘", value: Math.round(reviewedDays / dates.length * 100) },
        { key: "balance", label: "感受", value: balance }
      ],
      garden: { points: focusMinutes + closedTasks * 20 + complete * 20, growthPercent: Math.min(100, Math.round(focusMinutes / 600 * 100)), treeKind, quality }
    };
  }
}
