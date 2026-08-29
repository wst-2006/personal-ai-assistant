import { randomUUID } from "node:crypto";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import {
  healthProfiles,
  healthWeekConversationMessages,
  healthWeekConversations,
  healthWeekPlans
} from "@personal-ai/db/schema";
import { healthProfileSchema, type HealthProfile } from "@personal-ai/domain/health";
import { primaryHealthProfileId } from "./health-service.js";

export type HealthConversationPromptMessage = { role: "user" | "assistant"; content: string };
export type HealthConversationReply = { content: string; needsClarification: boolean };

export interface HealthConversationResponder {
  reply(input: {
    weekStart: string;
    profile: HealthProfile;
    activePlan: { overview: string; supplements: string[] } | null;
    messages: HealthConversationPromptMessage[];
  }): Promise<HealthConversationReply>;
}

export interface HealthConversationNotifier {
  notifyClarification(input: { weekStart: string; content: string }): Promise<void>;
}

export class HealthConversationNotFoundError extends Error {}
export class HealthConversationNoPendingReplyError extends Error {}
export class HealthConversationReplyPendingError extends Error {}
export class HealthConversationReplyUnavailableError extends Error {
  constructor(readonly conversationId: string, readonly userMessageId: string) {
    super("The health collaboration message was saved, but the AI reply is unavailable.");
  }
}

function promptMessages(rows: Array<typeof healthWeekConversationMessages.$inferSelect>): HealthConversationPromptMessage[] {
  return rows.map((message) => {
    if (message.role !== "user" && message.role !== "assistant") throw new Error("Unexpected health collaboration role.");
    return { role: message.role, content: message.content };
  });
}

export class HealthConversationService {
  private readonly replyInFlight = new Map<string, Promise<Awaited<ReturnType<HealthConversationService["appendAssistantReply"]>>>>();

  constructor(private readonly db: AppDatabase, private readonly notifier?: HealthConversationNotifier) {}

  async getOrOpen(weekStart: string) {
    return this.db.transaction(async (transaction) => {
      let [conversation] = await transaction.select().from(healthWeekConversations)
        .where(eq(healthWeekConversations.weekStart, weekStart)).limit(1);
      if (!conversation) {
        const [created] = await transaction.insert(healthWeekConversations)
          .values({ id: randomUUID(), weekStart })
          .onConflictDoNothing()
          .returning();
        conversation = created ?? (await transaction.select().from(healthWeekConversations)
          .where(eq(healthWeekConversations.weekStart, weekStart)).limit(1))[0];
      }
      if (!conversation) throw new Error("Health collaboration creation did not return a conversation.");
      return {
        conversation,
        messages: await this.messages(transaction as AppDatabase, conversation.id),
        replyInFlight: this.replyInFlight.has(conversation.id)
      };
    });
  }

  async send(conversationId: string, content: string, responder: HealthConversationResponder, source: "app" | "feishu" = "app") {
    await this.saveUserMessage(conversationId, content, source);
    return this.retryLast(conversationId, responder);
  }

  async saveUserMessage(conversationId: string, content: string, source: "app" | "feishu" = "app", externalMessageId: string | null = null) {
    return this.appendUserMessage(conversationId, content, source, externalMessageId);
  }

  async hasExternalMessage(externalMessageId: string) {
    const [message] = await this.db.select({ id: healthWeekConversationMessages.id }).from(healthWeekConversationMessages)
      .where(eq(healthWeekConversationMessages.externalMessageId, externalMessageId)).limit(1);
    return Boolean(message);
  }

  retryLast(conversationId: string, responder: HealthConversationResponder) {
    const existing = this.replyInFlight.get(conversationId);
    if (existing) return existing;
    const pending = this.replyLastOnce(conversationId, responder).finally(() => {
      if (this.replyInFlight.get(conversationId) === pending) this.replyInFlight.delete(conversationId);
    });
    this.replyInFlight.set(conversationId, pending);
    return pending;
  }

  private async replyLastOnce(conversationId: string, responder: HealthConversationResponder) {
    const state = await this.read(conversationId);
    const last = state.messages.at(-1);
    if (!last || last.role !== "user") throw new HealthConversationNoPendingReplyError();
    let reply: HealthConversationReply;
    try {
      reply = await responder.reply(await this.responderInput(state.conversation.weekStart, state.messages));
    } catch {
      throw new HealthConversationReplyUnavailableError(state.conversation.id, last.id);
    }
    const result = await this.appendAssistantReply(state.conversation.id, last.id, reply.content, reply.needsClarification);
    if (reply.needsClarification && last.source !== "feishu" && this.notifier) {
      await this.notifier.notifyClarification({ weekStart: state.conversation.weekStart, content: reply.content }).catch(() => undefined);
    }
    return result;
  }

  async contextForWeek(weekStart: string, maxCharacters = 8_000): Promise<string | null> {
    const [conversation] = await this.db.select().from(healthWeekConversations)
      .where(eq(healthWeekConversations.weekStart, weekStart)).limit(1);
    if (!conversation) return null;
    const rows = await this.messages(this.db, conversation.id);
    const selected: string[] = [];
    let remaining = maxCharacters;
    for (const row of [...rows].reverse()) {
      if (remaining <= 0) break;
      const prefix = row.role === "user" ? "用户" : "健康助手";
      const line = `${prefix}：${row.content}`;
      const bounded = line.length > remaining ? line.slice(-remaining) : line;
      selected.push(bounded);
      remaining -= bounded.length;
    }
    return selected.length ? selected.reverse().join("\n") : null;
  }

  private async responderInput(weekStart: string, messages: Array<typeof healthWeekConversationMessages.$inferSelect>) {
    const [profileRow, activePlan] = await Promise.all([
      this.db.select().from(healthProfiles).where(eq(healthProfiles.id, primaryHealthProfileId)).limit(1),
      this.db.select({ overview: healthWeekPlans.overview, supplements: healthWeekPlans.supplements }).from(healthWeekPlans)
        .where(eq(healthWeekPlans.weekStart, weekStart)).orderBy(desc(healthWeekPlans.updatedAt)).limit(1)
    ]);
    const profile = profileRow[0];
    if (!profile) throw new Error("health_profile_required");
    return {
      weekStart,
      profile: healthProfileSchema.parse(profile.profile),
      activePlan: activePlan[0] ? { overview: activePlan[0].overview, supplements: activePlan[0].supplements as string[] } : null,
      messages: promptMessages(messages)
    };
  }

  private async read(conversationId: string) {
    const [conversation] = await this.db.select().from(healthWeekConversations)
      .where(eq(healthWeekConversations.id, conversationId)).limit(1);
    if (!conversation) throw new HealthConversationNotFoundError();
    return { conversation, messages: await this.messages(this.db, conversationId) };
  }

  private async appendUserMessage(conversationId: string, content: string, source: "app" | "feishu", externalMessageId: string | null) {
    return this.db.transaction(async (transaction) => {
      await transaction.execute(sql`select id from health_week_conversations where id = ${conversationId} for update`);
      const [conversation] = await transaction.select().from(healthWeekConversations)
        .where(eq(healthWeekConversations.id, conversationId)).limit(1);
      if (!conversation) throw new HealthConversationNotFoundError();
      const existingMessages = await this.messages(transaction as AppDatabase, conversationId);
      if (externalMessageId) {
        const duplicate = existingMessages.find((message) => message.externalMessageId === externalMessageId);
        if (duplicate) return { conversation, userMessage: duplicate, messages: existingMessages };
      }
      if (existingMessages.at(-1)?.role === "user") throw new HealthConversationReplyPendingError();
      const [userMessage] = await transaction.insert(healthWeekConversationMessages).values({
        id: randomUUID(), conversationId, role: "user", source, content, externalMessageId
      }).returning();
      const [updatedConversation] = await transaction.update(healthWeekConversations)
        .set({ updatedAt: new Date() }).where(eq(healthWeekConversations.id, conversationId)).returning();
      return { conversation: updatedConversation!, userMessage: userMessage!, messages: [...existingMessages, userMessage!], replyInFlight: false };
    });
  }

  private async appendAssistantReply(conversationId: string, userMessageId: string, content: string, needsClarification: boolean) {
    return this.db.transaction(async (transaction) => {
      await transaction.execute(sql`select id from health_week_conversations where id = ${conversationId} for update`);
      const [conversation] = await transaction.select().from(healthWeekConversations)
        .where(eq(healthWeekConversations.id, conversationId)).limit(1);
      if (!conversation) throw new HealthConversationNotFoundError();
      const messages = await this.messages(transaction as AppDatabase, conversationId);
      const last = messages.at(-1);
      if (!last || last.id !== userMessageId || last.role !== "user") throw new HealthConversationNoPendingReplyError();
      const [assistantMessage] = await transaction.insert(healthWeekConversationMessages).values({
        id: randomUUID(), conversationId, role: "assistant", source: "ai", content, needsClarification
      }).returning();
      const [updatedConversation] = await transaction.update(healthWeekConversations)
        .set({ updatedAt: new Date() }).where(eq(healthWeekConversations.id, conversationId)).returning();
      return { conversation: updatedConversation!, messages: [...messages, assistantMessage!], replyInFlight: false };
    });
  }

  private messages(db: AppDatabase, conversationId: string) {
    return db.select().from(healthWeekConversationMessages)
      .where(eq(healthWeekConversationMessages.conversationId, conversationId))
      .orderBy(asc(healthWeekConversationMessages.createdAt), asc(healthWeekConversationMessages.id));
  }
}
