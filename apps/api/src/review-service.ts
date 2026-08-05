import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import {
  appConversationMessages,
  appConversations,
  dailyBriefs,
  focusSessions,
  reviewMessages,
  reviewSessions,
  taskFeedback,
  taskOutcomes,
  tasks,
} from "@personal-ai/db/schema";

export type ReviewPromptMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ReviewResponderInput = {
  localDate: string;
  messages: ReviewPromptMessage[];
  context: {
    tasks: Array<{
      id: string;
      title: string;
      lifecycleStatus: string;
      startAt: string | null;
      endAt: string | null;
      notes: string | null;
    }>;
    outcomes: Array<{
      taskId: string;
      outcome: string;
      progressPercent: number;
      note: string | null;
    }>;
    focusSessions: Array<{
      taskId: string;
      state: string;
      rawActiveSeconds: number;
      effectiveFocusSeconds: number;
    }>;
    feedback: Array<{
      taskId: string;
      satisfaction: string;
      note: string | null;
    }>;
    conversationMessages: Array<{
      role: "user" | "assistant";
      content: string;
    }>;
  };
};

export interface ReviewResponder {
  reply(input: ReviewResponderInput): Promise<string>;
}

export class ReviewNotFoundError extends Error {}
export class ReviewNoPendingReplyError extends Error {}

export class ReviewReplyUnavailableError extends Error {
  constructor(readonly reviewSessionId: string, readonly userMessageId: string) {
    super("The review message was saved, but the AI reply is unavailable.");
  }
}

function promptMessages(rows: Array<typeof reviewMessages.$inferSelect>): ReviewPromptMessage[] {
  return rows
    .filter((message) => message.source === "app" || message.source === "ai")
    .slice(-20)
    .map((message) => ({
      role: message.source === "ai" ? "assistant" : "user",
      content: message.content,
    }));
}

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
      const conversations = await transaction.select().from(appConversations).where(eq(appConversations.localDate, localDate));
      const conversationIds = conversations.map((conversation) => conversation.id);
      const conversationMessages = conversationIds.length
        ? await transaction.select().from(appConversationMessages).where(inArray(appConversationMessages.conversationId, conversationIds)).orderBy(asc(appConversationMessages.createdAt), asc(appConversationMessages.id))
        : [];
      return { session, messages, briefs, context: { tasks: taskRows, outcomes, focusSessions: focus, feedback, conversations, conversationMessages } };
    });
  }

  async addUserMessage(sessionId: string, content: string) {
    return this.db.transaction(async (transaction) => {
      const [session] = await transaction.select().from(reviewSessions).where(eq(reviewSessions.id, sessionId)).limit(1);
      if (!session) throw new ReviewNotFoundError();
      const [message] = await transaction.insert(reviewMessages).values({ id: randomUUID(), reviewSessionId: sessionId, source: "app", content }).returning();
      const [updated] = await transaction.update(reviewSessions).set({ state: "review_has_message", updatedAt: new Date() }).where(eq(reviewSessions.id, sessionId)).returning();
      return { session: updated!, message: message! };
    });
  }

  async replyLast(sessionId: string, responder: ReviewResponder) {
    const state = await this.readForReply(sessionId);
    const last = state.messages.at(-1);
    if (!last || last.source !== "app") throw new ReviewNoPendingReplyError();
    let content: string;
    try {
      content = await responder.reply({
        localDate: state.session.localDate,
        messages: promptMessages(state.messages),
        context: {
          tasks: state.context.tasks.slice(0, 40).map((task) => ({
            id: task.id,
            title: task.title,
            lifecycleStatus: task.lifecycleStatus,
            startAt: task.startAt?.toISOString() ?? null,
            endAt: task.endAt?.toISOString() ?? null,
            notes: task.notes,
          })),
          outcomes: state.context.outcomes.slice(-60).map((outcome) => ({
            taskId: outcome.taskId,
            outcome: outcome.outcome,
            progressPercent: outcome.progressPercent,
            note: outcome.note,
          })),
          focusSessions: state.context.focusSessions.slice(-60).map((session) => ({
            taskId: session.taskId,
            state: session.state,
            rawActiveSeconds: session.rawActiveSeconds,
            effectiveFocusSeconds: session.effectiveFocusSeconds,
          })),
          feedback: state.context.feedback.slice(-60).map((feedback) => ({
            taskId: feedback.taskId,
            satisfaction: feedback.satisfaction,
            note: feedback.note,
          })),
          conversationMessages: state.context.conversationMessages.slice(-12).map((message) => ({
            role: message.role === "assistant" ? "assistant" : "user",
            content: message.content,
          })),
        },
      });
    } catch {
      throw new ReviewReplyUnavailableError(sessionId, last.id);
    }
    return this.appendAssistantReply(sessionId, last.id, content);
  }

  private async readForReply(sessionId: string) {
    const [session] = await this.db.select().from(reviewSessions).where(eq(reviewSessions.id, sessionId)).limit(1);
    if (!session) throw new ReviewNotFoundError();
    return this.getOrOpen(session.localDate);
  }

  private async appendAssistantReply(sessionId: string, userMessageId: string, content: string) {
    return this.db.transaction(async (transaction) => {
      const [session] = await transaction.select().from(reviewSessions).where(eq(reviewSessions.id, sessionId)).limit(1);
      if (!session) throw new ReviewNotFoundError();
      const messages = await transaction.select().from(reviewMessages).where(eq(reviewMessages.reviewSessionId, sessionId)).orderBy(asc(reviewMessages.createdAt));
      const last = messages.at(-1);
      if (!last || last.id !== userMessageId || last.source !== "app") throw new ReviewNoPendingReplyError();
      const [assistantMessage] = await transaction.insert(reviewMessages).values({
        id: randomUUID(), reviewSessionId: sessionId, source: "ai", content: content.slice(0, 2_000),
      }).returning();
      const [updated] = await transaction.update(reviewSessions).set({ updatedAt: new Date() }).where(eq(reviewSessions.id, sessionId)).returning();
      return { session: updated!, messages: [...messages, assistantMessage!] };
    });
  }
}
