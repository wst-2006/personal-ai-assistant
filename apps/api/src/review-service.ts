import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { dailyBriefs, focusSessions, reviewMessages, reviewSessions, taskFeedback, taskOutcomes, tasks } from "@personal-ai/db/schema";

export class ReviewNotFoundError extends Error {}

export class ReviewService {
  constructor(private readonly db: AppDatabase) {}

  async getOrOpen(localDate: string) {
    return this.db.transaction(async (transaction) => {
      const [existing] = await transaction.select().from(reviewSessions).where(eq(reviewSessions.localDate, localDate)).limit(1);
      const session = existing ?? (await transaction.insert(reviewSessions).values({ id: randomUUID(), localDate, state: "review_open" }).returning())[0]!;
      const messages = await transaction.select().from(reviewMessages).where(eq(reviewMessages.reviewSessionId, session.id)).orderBy(asc(reviewMessages.createdAt));
      const taskRows = await transaction.select().from(tasks).where(and(eq(tasks.localDate, localDate), isNull(tasks.deletedAt))).orderBy(asc(tasks.createdAt));
      const taskIds = taskRows.map((task) => task.id);
      const outcomes = taskIds.length ? await transaction.select().from(taskOutcomes).where(inArray(taskOutcomes.taskId, taskIds)) : [];
      const focus = taskIds.length ? await transaction.select().from(focusSessions).where(inArray(focusSessions.taskId, taskIds)) : [];
      const feedback = taskIds.length ? await transaction.select().from(taskFeedback).where(inArray(taskFeedback.taskId, taskIds)) : [];
      const briefs = await transaction.select().from(dailyBriefs).where(eq(dailyBriefs.reviewSessionId, session.id)).orderBy(asc(dailyBriefs.createdAt));
      return { session, messages, briefs, context: { tasks: taskRows, outcomes, focusSessions: focus, feedback } };
    });
  }

  async addMessage(sessionId: string, content: string, source: "app" | "ai") {
    return this.db.transaction(async (transaction) => {
      const [session] = await transaction.select().from(reviewSessions).where(eq(reviewSessions.id, sessionId)).limit(1);
      if (!session) throw new ReviewNotFoundError();
      const message = (await transaction.insert(reviewMessages).values({ id: randomUUID(), reviewSessionId: sessionId, source, content }).returning())[0]!;
      const [updated] = await transaction.update(reviewSessions).set({ state: "review_has_message", updatedAt: new Date() }).where(eq(reviewSessions.id, sessionId)).returning();
      return { session: updated!, message };
    });
  }
}
