import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { cyberDiaries, dailyBriefs, focusSessions, reviewMessages, reviewSessions, taskFeedback, taskOutcomes, tasks } from "@personal-ai/db/schema";
import type { z } from "zod";
import type { cyberDiaryContentSchema } from "@personal-ai/domain/diary";

type DiaryContent = z.infer<typeof cyberDiaryContentSchema>;
type TaskRow = typeof tasks.$inferSelect;
type FocusRow = typeof focusSessions.$inferSelect;
type OutcomeRow = typeof taskOutcomes.$inferSelect;
type FeedbackRow = typeof taskFeedback.$inferSelect;

export function buildDiaryDayData(taskRows: TaskRow[], sessions: FocusRow[], outcomes: OutcomeRow[], feedback: FeedbackRow[], hasReviewMessage: boolean) {
  const focusByTask = new Map<string, { rawSeconds: number; effectiveSeconds: number }>();
  for (const session of sessions) {
    const current = focusByTask.get(session.taskId) ?? { rawSeconds: 0, effectiveSeconds: 0 };
    current.rawSeconds += session.rawActiveSeconds;
    current.effectiveSeconds += session.effectiveFocusSeconds;
    focusByTask.set(session.taskId, current);
  }
  const latestOutcomeByTask = new Map<string, OutcomeRow>();
  for (const outcome of outcomes) {
    const previous = latestOutcomeByTask.get(outcome.taskId);
    if (!previous || outcome.recordedAt > previous.recordedAt) latestOutcomeByTask.set(outcome.taskId, outcome);
  }
  const closedTasks = taskRows.filter((task) => task.lifecycleStatus === "closed").length;
  const plannedTasks = taskRows.filter((task) => task.lifecycleStatus !== "cancelled").length;
  const rawFocusSeconds = sessions.reduce((sum, session) => sum + session.rawActiveSeconds, 0);
  const effectiveFocusSeconds = sessions.reduce((sum, session) => sum + session.effectiveFocusSeconds, 0);
  const satisfaction = {
    satisfied: feedback.filter((item) => item.satisfaction === "satisfied").length,
    neutral: feedback.filter((item) => item.satisfaction === "neutral").length,
    dissatisfied: feedback.filter((item) => item.satisfaction === "dissatisfied").length
  };
  const outcomeCount = latestOutcomeByTask.size;
  const completeCount = [...latestOutcomeByTask.values()].filter((outcome) => outcome.outcome === "complete").length;
  const percentage = (value: number, total: number) => total ? Math.round(value / total * 100) : 0;
  const completion = percentage(closedTasks, plannedTasks);
  const quality = percentage(completeCount, outcomeCount);
  const balance = percentage(satisfaction.satisfied + satisfaction.neutral, feedback.length);
  const focusMinutes = Math.round(effectiveFocusSeconds / 60);
  const deepFocusMinutes = taskRows.filter((task) => task.requiresContinuousFocus).reduce((sum, task) => sum + Math.round((focusByTask.get(task.id)?.effectiveSeconds ?? 0) / 60), 0);
  const radar = [
    { key: "focus", label: "专注", value: Math.min(100, Math.round(focusMinutes / 60 * 100)) },
    { key: "completion", label: "完成", value: completion },
    { key: "depth", label: "深度", value: Math.min(100, Math.round(deepFocusMinutes / 45 * 100)) },
    { key: "quality", label: "质量", value: quality },
    { key: "balance", label: "感受", value: balance },
    { key: "reflection", label: "复盘", value: hasReviewMessage ? 100 : 0 }
  ];
  const treeKind = quality >= 80 ? "常青树" : quality >= 45 ? "银杏" : outcomeCount > 0 ? "苔藓" : "种子";
  return {
    tasks: taskRows.map((task) => ({
      id: task.id, title: task.title, lifecycleStatus: task.lifecycleStatus, scheduleKind: task.scheduleKind,
      startAt: task.startAt, endAt: task.endAt, plannedEffortMinutes: task.plannedEffortMinutes, currentOutcome: task.currentOutcome,
      focusMinutes: Math.round((focusByTask.get(task.id)?.effectiveSeconds ?? 0) / 60),
      rawFocusMinutes: Math.round((focusByTask.get(task.id)?.rawSeconds ?? 0) / 60),
      latestOutcome: latestOutcomeByTask.get(task.id)?.outcome ?? null
    })),
    plannedTasks, closedTasks, rawFocusMinutes: Math.round(rawFocusSeconds / 60), effectiveFocusMinutes: focusMinutes, satisfaction,
    radar, stateTone: focusMinutes >= 60 && closedTasks > 0 ? "bright" as const : focusMinutes > 0 || closedTasks > 0 ? "steady" as const : "quiet" as const,
    tree: { kind: treeKind, points: focusMinutes + closedTasks * 20 + completeCount * 20, growthPercent: Math.min(100, Math.round(focusMinutes / 90 * 100)), quality }
  };
}

export class DiaryPrerequisiteError extends Error {
  constructor(readonly code: "review_message_required" | "confirmed_brief_required" | "invalid_diary_links") {
    super(code);
  }
}

export class DiaryNotFoundError extends Error {}

export class DiaryService {
  constructor(private readonly db: AppDatabase) {}

  async getByLocalDate(localDate: string) {
    return this.db.transaction(async (transaction) => {
      const [review] = await transaction.select().from(reviewSessions).where(eq(reviewSessions.localDate, localDate)).limit(1);
      if (!review) return { diary: null, review: null, confirmedBrief: null, hasReviewMessage: false };
      const messages = await transaction.select({ id: reviewMessages.id }).from(reviewMessages).where(eq(reviewMessages.reviewSessionId, review.id)).limit(1);
      const [confirmedBrief] = await transaction.select().from(dailyBriefs).where(and(eq(dailyBriefs.reviewSessionId, review.id), eq(dailyBriefs.state, "confirmed"))).orderBy(desc(dailyBriefs.updatedAt)).limit(1);
      const [diary] = await transaction.select().from(cyberDiaries).where(eq(cyberDiaries.localDate, localDate)).limit(1);
      const taskRows = await transaction.select().from(tasks).where(and(eq(tasks.localDate, localDate), isNull(tasks.deletedAt))).orderBy(tasks.createdAt);
      const taskIds = taskRows.map((task) => task.id);
      const sessions = taskIds.length ? await transaction.select().from(focusSessions).where(inArray(focusSessions.taskId, taskIds)) : [];
      const outcomes = taskIds.length ? await transaction.select().from(taskOutcomes).where(inArray(taskOutcomes.taskId, taskIds)) : [];
      const feedback = taskIds.length ? await transaction.select().from(taskFeedback).where(inArray(taskFeedback.taskId, taskIds)) : [];
      const dayData = buildDiaryDayData(taskRows, sessions, outcomes, feedback, messages.length > 0);
      return { diary: diary ?? null, review, confirmedBrief: confirmedBrief ?? null, hasReviewMessage: messages.length > 0, dayData };
    });
  }

  async save(localDate: string, reviewSessionId: string, briefId: string, content: DiaryContent) {
    return this.db.transaction(async (transaction) => {
      const [review] = await transaction.select().from(reviewSessions).where(eq(reviewSessions.id, reviewSessionId)).limit(1);
      if (!review || review.localDate !== localDate) throw new DiaryPrerequisiteError("invalid_diary_links");
      const messages = await transaction.select({ id: reviewMessages.id }).from(reviewMessages).where(eq(reviewMessages.reviewSessionId, review.id)).limit(1);
      if (messages.length === 0) throw new DiaryPrerequisiteError("review_message_required");
      const [brief] = await transaction.select().from(dailyBriefs).where(eq(dailyBriefs.id, briefId)).limit(1);
      if (!brief || brief.reviewSessionId !== review.id || brief.state !== "confirmed") throw new DiaryPrerequisiteError("confirmed_brief_required");
      const [existing] = await transaction.select().from(cyberDiaries).where(eq(cyberDiaries.localDate, localDate)).limit(1);
      if (existing) {
        return (await transaction.update(cyberDiaries).set({ reviewSessionId, briefId, content, updatedAt: new Date() }).where(eq(cyberDiaries.id, existing.id)).returning())[0]!;
      }
      return (await transaction.insert(cyberDiaries).values({ id: randomUUID(), localDate, reviewSessionId, briefId, content }).returning())[0]!;
    });
  }
}
