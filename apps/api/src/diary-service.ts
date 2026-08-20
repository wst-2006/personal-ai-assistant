import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { cyberDiaries, dailyBriefs, focusSessionSegmentRuns, focusSessions, reviewMessages, reviewSessions, taskFeedback, taskOutcomes, tasks } from "@personal-ai/db/schema";
import type { z } from "zod";
import type { cyberDiaryContentSchema } from "@personal-ai/domain/diary";
import { indexFocusSecondsBySession, recordedFocusSeconds } from "./focus-accounting.js";

type DiaryContent = z.infer<typeof cyberDiaryContentSchema>;
type TaskRow = typeof tasks.$inferSelect;
type FocusRow = typeof focusSessions.$inferSelect;
type FocusSegmentRunRow = typeof focusSessionSegmentRuns.$inferSelect;
type OutcomeRow = typeof taskOutcomes.$inferSelect;
type FeedbackRow = typeof taskFeedback.$inferSelect;
type BriefRow = typeof dailyBriefs.$inferSelect;

type DiarySnapshot = {
  version: 1;
  capturedAt: string;
  dayData: ReturnType<typeof buildDiaryDayData>;
  brief: Pick<BriefRow, "id" | "localDate" | "reviewSessionId" | "content" | "sources">;
  reviewMessages: Array<{ id: string; source: string; content: string; createdAt: string }>;
  taskFeedback: Array<{ id: string; taskId: string; focusSessionId: string | null; satisfaction: string; note: string | null; createdAt: string }>;
};

type StoredDiaryContent = DiaryContent & { snapshot?: DiarySnapshot };

export type DailyStateTone = "quiet" | "steady" | "bright" | "strained";
export type DailyGrowthBreakdown = {
  execution: number;
  focus: number;
  satisfaction: number;
  review: number;
};

const radarDefinitions = [
  { key: "mainlineProgress", label: "主线推进", source: "system" },
  { key: "overallExecution", label: "总体执行", source: "system" },
  { key: "focusQuality", label: "专注质量", source: "system" },
  { key: "energyState", label: "精力状态", source: "user" },
  { key: "wellbeing", label: "身心维护", source: "user" },
  { key: "growthGain", label: "成长获得", source: "user" }
] as const;

function percentage(value: number, total: number) {
  return total ? Math.round(value / total * 100) : 0;
}

function stateTone(feedback: FeedbackRow[]): DailyStateTone {
  if (feedback.length === 0) return "quiet";
  const satisfied = feedback.filter((item) => item.satisfaction === "satisfied").length;
  const dissatisfied = feedback.filter((item) => item.satisfaction === "dissatisfied").length;
  if (dissatisfied / feedback.length >= 0.5) return "strained";
  if (satisfied / feedback.length >= 0.6 && dissatisfied / feedback.length <= 0.2) return "bright";
  return "steady";
}

function progressAverage(taskRows: TaskRow[], latestOutcomeByTask: Map<string, OutcomeRow>) {
  if (taskRows.length === 0) return 0;
  return Math.round(taskRows.reduce((sum, task) => sum + (latestOutcomeByTask.get(task.id)?.progressPercent ?? 0), 0) / taskRows.length);
}

function dailyGrowthBreakdown(overallExecution: number, focusMinutes: number, feedback: FeedbackRow[], hasReviewMessage: boolean): DailyGrowthBreakdown {
  const satisfactionAverage = feedback.length
    ? feedback.reduce((sum, item) => sum + (item.satisfaction === "satisfied" ? 100 : item.satisfaction === "neutral" ? 60 : 20), 0) / feedback.length
    : 0;
  return {
    execution: Math.round(overallExecution / 100 * 45),
    focus: Math.min(25, Math.round(focusMinutes / 180 * 25)),
    satisfaction: Math.round(satisfactionAverage / 100 * 20),
    review: hasReviewMessage ? 10 : 0
  };
}

export function buildDiaryDayData(taskRows: TaskRow[], sessions: FocusRow[], outcomes: OutcomeRow[], feedback: FeedbackRow[], hasReviewMessage: boolean, segmentRuns: FocusSegmentRunRow[] = []) {
  const formalTaskRows = taskRows.filter((task) => task.recordKind !== "backfill");
  const formalTaskIds = new Set(formalTaskRows.map((task) => task.id));
  const formalSessions = sessions.filter((session) => formalTaskIds.has(session.taskId));
  const formalOutcomes = outcomes.filter((outcome) => formalTaskIds.has(outcome.taskId));
  const formalFeedback = feedback.filter((item) => formalTaskIds.has(item.taskId));
  const focusSecondsBySession = indexFocusSecondsBySession(segmentRuns);
  const focusByTask = new Map<string, { rawSeconds: number; effectiveSeconds: number }>();
  for (const session of formalSessions) {
    const current = focusByTask.get(session.taskId) ?? { rawSeconds: 0, effectiveSeconds: 0 };
    current.rawSeconds += session.rawActiveSeconds;
    current.effectiveSeconds += recordedFocusSeconds(session, focusSecondsBySession);
    focusByTask.set(session.taskId, current);
  }
  const latestOutcomeByTask = new Map<string, OutcomeRow>();
  for (const outcome of outcomes) {
    const previous = latestOutcomeByTask.get(outcome.taskId);
    if (!previous || outcome.recordedAt > previous.recordedAt) latestOutcomeByTask.set(outcome.taskId, outcome);
  }
  const latestFeedbackByTask = new Map<string, FeedbackRow>();
  for (const item of feedback) {
    const previous = latestFeedbackByTask.get(item.taskId);
    if (!previous || item.createdAt > previous.createdAt) latestFeedbackByTask.set(item.taskId, item);
  }
  const closedTasks = formalTaskRows.filter((task) => task.lifecycleStatus === "closed").length;
  const plannedTaskRows = formalTaskRows.filter((task) => task.lifecycleStatus !== "cancelled");
  const plannedTasks = plannedTaskRows.length;
  const rawFocusSeconds = formalSessions.reduce((sum, session) => sum + session.rawActiveSeconds, 0);
  const effectiveFocusSeconds = formalSessions.reduce((sum, session) => sum + recordedFocusSeconds(session, focusSecondsBySession), 0);
  const latestFormalFeedback = [...latestFeedbackByTask.entries()]
    .filter(([taskId]) => formalTaskIds.has(taskId))
    .map(([, item]) => item);
  const satisfaction = {
    satisfied: latestFormalFeedback.filter((item) => item.satisfaction === "satisfied").length,
    neutral: latestFormalFeedback.filter((item) => item.satisfaction === "neutral").length,
    dissatisfied: latestFormalFeedback.filter((item) => item.satisfaction === "dissatisfied").length
  };
  const latestFormalOutcomes = [...latestOutcomeByTask.entries()].filter(([taskId]) => formalTaskIds.has(taskId)).map(([, outcome]) => outcome);
  const latestOutcomes = latestFormalOutcomes;
  const outcomeCount = latestOutcomes.length;
  const completeCount = latestOutcomes.filter((outcome) => outcome.outcome === "complete").length;
  const quality = outcomeCount ? Math.round(latestOutcomes.reduce((sum, outcome) => sum + outcome.progressPercent, 0) / outcomeCount) : 0;
  const focusMinutes = Math.round(effectiveFocusSeconds / 60);
  const mainlineProgress = progressAverage(plannedTaskRows.filter((task) => task.sourceLongRangePlanId !== null), latestOutcomeByTask);
  const overallExecution = progressAverage(plannedTaskRows, latestOutcomeByTask);
  const feedbackScore = latestFormalFeedback.length
    ? Math.round(latestFormalFeedback.reduce((sum, item) => sum + (item.satisfaction === "satisfied" ? 100 : item.satisfaction === "neutral" ? 60 : 20), 0) / latestFormalFeedback.length)
    : rawFocusSeconds > 0 ? Math.min(100, percentage(effectiveFocusSeconds, rawFocusSeconds)) : 0;
  const radarValues = { mainlineProgress, overallExecution, focusQuality: feedbackScore, energyState: null, wellbeing: null, growthGain: null };
  const radar = radarDefinitions.map((definition) => ({ ...definition, value: radarValues[definition.key] }));
  const treeKind = quality >= 80 ? "常青树" : quality >= 45 ? "银杏" : outcomeCount > 0 ? "苔藓" : "种子";
  const pointsBreakdown = dailyGrowthBreakdown(overallExecution, focusMinutes, latestFormalFeedback, hasReviewMessage);
  const points = Object.values(pointsBreakdown).reduce((sum, value) => sum + value, 0);
  return {
    tasks: taskRows.map((task) => ({
      id: task.id, title: task.title, recordKind: task.recordKind ?? "formal", lifecycleStatus: task.lifecycleStatus, scheduleKind: task.scheduleKind,
      startAt: task.startAt, endAt: task.endAt, currentOutcome: task.currentOutcome,
      focusMinutes: Math.round((focusByTask.get(task.id)?.effectiveSeconds ?? 0) / 60),
      rawFocusMinutes: Math.round((focusByTask.get(task.id)?.rawSeconds ?? 0) / 60),
      latestOutcome: latestOutcomeByTask.get(task.id)?.outcome ?? null,
      latestSatisfaction: latestFeedbackByTask.get(task.id)?.satisfaction ?? null,
      latestFeedbackNote: latestFeedbackByTask.get(task.id)?.note ?? null
    })),
    plannedTasks, closedTasks, completedTasks: completeCount, outcomeCount, completeCount,
    rawFocusMinutes: Math.round(rawFocusSeconds / 60), effectiveFocusMinutes: focusMinutes, satisfaction,
    radar, stateTone: stateTone(latestFormalFeedback),
    tree: { kind: treeKind, points, pointsBreakdown, growthPercent: Math.min(100, Math.round(focusMinutes / 90 * 100)), quality }
  };
}

function readSnapshot(content: unknown): DiarySnapshot | null {
  if (!content || typeof content !== "object" || !("snapshot" in content)) return null;
  const snapshot = (content as { snapshot?: unknown }).snapshot;
  if (!snapshot || typeof snapshot !== "object" || (snapshot as { version?: unknown }).version !== 1) return null;
  if (!("dayData" in snapshot) || !("brief" in snapshot) || !("reviewMessages" in snapshot) || !("taskFeedback" in snapshot)) return null;
  return snapshot as DiarySnapshot;
}

export class DiaryPrerequisiteError extends Error {
  constructor(readonly code: "review_message_required" | "confirmed_brief_required" | "invalid_diary_links") {
    super(code);
  }
}

export class DiaryNotFoundError extends Error {}

export class DiaryService {
  constructor(private readonly db: AppDatabase) {}

  async listMonth(month: string) {
    const [year, monthNumber] = month.split("-").map(Number);
    const start = `${month}-01`;
    const end = new Date(Date.UTC(year!, monthNumber!, 0)).toISOString().slice(0, 10);
    return this.db.transaction(async (transaction) => {
      const reviewRows = await transaction.select().from(reviewSessions).where(and(gte(reviewSessions.localDate, start), lte(reviewSessions.localDate, end)));
      const reviewIds = reviewRows.map((review) => review.id);
      const messageRows = reviewIds.length ? await transaction.select({ reviewSessionId: reviewMessages.reviewSessionId }).from(reviewMessages).where(and(inArray(reviewMessages.reviewSessionId, reviewIds), eq(reviewMessages.source, "app"))) : [];
      const briefRows = reviewIds.length ? await transaction.select({ reviewSessionId: dailyBriefs.reviewSessionId }).from(dailyBriefs).where(and(inArray(dailyBriefs.reviewSessionId, reviewIds), eq(dailyBriefs.state, "confirmed"))) : [];
      const diaryRows = await transaction.select({ localDate: cyberDiaries.localDate, content: cyberDiaries.content }).from(cyberDiaries).where(and(gte(cyberDiaries.localDate, start), lte(cyberDiaries.localDate, end)));
      const taskRows = await transaction.select().from(tasks).where(and(isNull(tasks.deletedAt), gte(tasks.localDate, start), lte(tasks.localDate, end)));
      const formalTaskIds = taskRows.filter((task) => task.recordKind !== "backfill").map((task) => task.id);
      const sessions = formalTaskIds.length ? await transaction.select().from(focusSessions).where(inArray(focusSessions.taskId, formalTaskIds)) : [];
      const sessionIds = sessions.map((session) => session.id);
      const segmentRuns = sessionIds.length ? await transaction.select().from(focusSessionSegmentRuns).where(inArray(focusSessionSegmentRuns.focusSessionId, sessionIds)) : [];
      const feedbackRows = formalTaskIds.length ? await transaction.select().from(taskFeedback).where(inArray(taskFeedback.taskId, formalTaskIds)) : [];
      const focusSecondsBySession = indexFocusSecondsBySession(segmentRuns);
      const focusByTask = new Map<string, number>();
      for (const session of sessions) focusByTask.set(session.taskId, (focusByTask.get(session.taskId) ?? 0) + recordedFocusSeconds(session, focusSecondsBySession));
      const messagesByReview = new Set(messageRows.map((message) => message.reviewSessionId));
      const briefsByReview = new Set(briefRows.map((brief) => brief.reviewSessionId).filter((id): id is string => Boolean(id)));
      const diaryByDate = new Map(diaryRows.map((diary) => [diary.localDate, diary]));
      const reviewByDate = new Map(reviewRows.map((review) => [review.localDate, review]));
      const days = Array.from({ length: Number(end.slice(8, 10)) }, (_, index) => {
        const localDate = `${month}-${String(index + 1).padStart(2, "0")}`;
        const dayTasks = taskRows.filter((task) => task.localDate === localDate);
        const savedDiary = diaryByDate.get(localDate);
        const savedSnapshot = readSnapshot(savedDiary?.content);
        const focusMinutes = savedSnapshot?.dayData.effectiveFocusMinutes ?? Math.round(dayTasks.reduce((sum, task) => sum + (focusByTask.get(task.id) ?? 0), 0) / 60);
        const formalDayTasks = dayTasks.filter((task) => task.recordKind !== "backfill");
        const closedTasks = savedSnapshot?.dayData.closedTasks ?? formalDayTasks.filter((task) => task.lifecycleStatus === "closed").length;
        const dayTaskIds = new Set(formalDayTasks.map((task) => task.id));
        const dayFeedback = feedbackRows.filter((item) => dayTaskIds.has(item.taskId));
        const review = reviewByDate.get(localDate);
        return {
          localDate, hasDiary: Boolean(savedDiary), hasReview: Boolean(review && messagesByReview.has(review.id)),
          hasConfirmedBrief: Boolean(review && briefsByReview.has(review.id)), taskCount: savedSnapshot?.dayData.tasks.length ?? dayTasks.length, closedTasks, focusMinutes,
          tone: savedSnapshot?.dayData.stateTone ?? stateTone(dayFeedback)
        };
      });
      return { month, days };
    });
  }

  async getByLocalDate(localDate: string) {
    return this.db.transaction(async (transaction) => {
      const [review] = await transaction.select().from(reviewSessions).where(eq(reviewSessions.localDate, localDate)).limit(1);
      if (!review) return { diary: null, review: null, confirmedBrief: null, hasReviewMessage: false };
      const messages = await transaction.select({ id: reviewMessages.id }).from(reviewMessages).where(and(eq(reviewMessages.reviewSessionId, review.id), eq(reviewMessages.source, "app"))).limit(1);
      const [confirmedBrief] = await transaction.select().from(dailyBriefs).where(and(eq(dailyBriefs.reviewSessionId, review.id), eq(dailyBriefs.state, "confirmed"))).orderBy(desc(dailyBriefs.updatedAt)).limit(1);
      const [diary] = await transaction.select().from(cyberDiaries).where(eq(cyberDiaries.localDate, localDate)).limit(1);
      const taskRows = await transaction.select().from(tasks).where(and(eq(tasks.localDate, localDate), isNull(tasks.deletedAt))).orderBy(tasks.createdAt);
      const taskIds = taskRows.map((task) => task.id);
      const sessions = taskIds.length ? await transaction.select().from(focusSessions).where(inArray(focusSessions.taskId, taskIds)) : [];
      const sessionIds = sessions.map((session) => session.id);
      const segmentRuns = sessionIds.length ? await transaction.select().from(focusSessionSegmentRuns).where(inArray(focusSessionSegmentRuns.focusSessionId, sessionIds)) : [];
      const outcomes = taskIds.length ? await transaction.select().from(taskOutcomes).where(inArray(taskOutcomes.taskId, taskIds)) : [];
      const feedback = taskIds.length ? await transaction.select().from(taskFeedback).where(inArray(taskFeedback.taskId, taskIds)) : [];
      const dayData = buildDiaryDayData(taskRows, sessions, outcomes, feedback, messages.length > 0, segmentRuns);
      const snapshot = readSnapshot(diary?.content);
      return {
        diary: diary ?? null,
        review,
        confirmedBrief: snapshot?.brief ?? confirmedBrief ?? null,
        hasReviewMessage: snapshot ? snapshot.reviewMessages.some((message) => message.source === "app") : messages.length > 0,
        dayData: snapshot?.dayData ?? dayData
      };
    });
  }

  async save(localDate: string, reviewSessionId: string, briefId: string, content: DiaryContent) {
    return this.db.transaction(async (transaction) => {
      const [review] = await transaction.select().from(reviewSessions).where(eq(reviewSessions.id, reviewSessionId)).limit(1);
      if (!review || review.localDate !== localDate) throw new DiaryPrerequisiteError("invalid_diary_links");
      const messages = await transaction.select().from(reviewMessages).where(eq(reviewMessages.reviewSessionId, review.id)).orderBy(asc(reviewMessages.createdAt), asc(reviewMessages.id));
      if (!messages.some((message) => message.source === "app")) throw new DiaryPrerequisiteError("review_message_required");
      const [brief] = await transaction.select().from(dailyBriefs).where(eq(dailyBriefs.id, briefId)).limit(1);
      if (!brief || brief.reviewSessionId !== review.id || brief.state !== "confirmed") throw new DiaryPrerequisiteError("confirmed_brief_required");
      const [existing] = await transaction.select().from(cyberDiaries).where(eq(cyberDiaries.localDate, localDate)).limit(1);
      const existingSnapshot = readSnapshot(existing?.content);
      const now = new Date();
      let snapshot = existingSnapshot;
      if (!snapshot) {
        const taskRows = await transaction.select().from(tasks).where(and(eq(tasks.localDate, localDate), isNull(tasks.deletedAt))).orderBy(tasks.createdAt);
        const taskIds = taskRows.map((task) => task.id);
        const sessions = taskIds.length ? await transaction.select().from(focusSessions).where(inArray(focusSessions.taskId, taskIds)) : [];
        const sessionIds = sessions.map((session) => session.id);
        const segmentRuns = sessionIds.length ? await transaction.select().from(focusSessionSegmentRuns).where(inArray(focusSessionSegmentRuns.focusSessionId, sessionIds)) : [];
        const outcomes = taskIds.length ? await transaction.select().from(taskOutcomes).where(inArray(taskOutcomes.taskId, taskIds)) : [];
        const feedback = taskIds.length ? await transaction.select().from(taskFeedback).where(inArray(taskFeedback.taskId, taskIds)) : [];
        snapshot = {
          version: 1,
          capturedAt: now.toISOString(),
          dayData: buildDiaryDayData(taskRows, sessions, outcomes, feedback, true, segmentRuns),
          brief: { id: brief.id, localDate: brief.localDate, reviewSessionId: brief.reviewSessionId, content: brief.content, sources: brief.sources },
          reviewMessages: messages.filter((message) => message.source === "app" || message.source === "ai").map((message) => ({ id: message.id, source: message.source, content: message.content, createdAt: message.createdAt.toISOString() })),
          taskFeedback: feedback.map((item) => ({ id: item.id, taskId: item.taskId, focusSessionId: item.focusSessionId, satisfaction: item.satisfaction, note: item.note, createdAt: item.createdAt.toISOString() }))
        };
      }
      const storedContent: StoredDiaryContent = { ...content, snapshot };
      if (existing) {
        return (await transaction.update(cyberDiaries).set({ reviewSessionId, briefId, content: storedContent, updatedAt: now }).where(eq(cyberDiaries.id, existing.id)).returning())[0]!;
      }
      return (await transaction.insert(cyberDiaries).values({ id: randomUUID(), localDate, reviewSessionId, briefId, content: storedContent }).returning())[0]!;
    });
  }
}
