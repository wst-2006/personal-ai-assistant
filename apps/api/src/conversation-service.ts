import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { appConversationMessages, appConversations } from "@personal-ai/db/schema";

export type ConversationPromptMessage = {
  role: "user" | "assistant";
  content: string;
};

export interface ConversationResponder {
  reply(input: { localDate: string; messages: ConversationPromptMessage[] }): Promise<string>;
}

export class ConversationNotFoundError extends Error {}
export class ConversationNoPendingReplyError extends Error {}

export class ConversationReplyUnavailableError extends Error {
  constructor(readonly conversationId: string, readonly userMessageId: string) {
    super("The user message was saved, but the AI reply is unavailable.");
  }
}

function promptMessages(rows: Array<typeof appConversationMessages.$inferSelect>): ConversationPromptMessage[] {
  return rows.map((message) => {
    if (message.role !== "user" && message.role !== "assistant") throw new Error("Unexpected saved conversation role.");
    return { role: message.role, content: message.content };
  });
}

export class ConversationService {
  constructor(private readonly db: AppDatabase) {}

  async getOrOpen(localDate: string) {
    return this.db.transaction(async (transaction) => {
      let [conversation] = await transaction.select().from(appConversations).where(eq(appConversations.localDate, localDate)).limit(1);
      if (!conversation) {
        const [created] = await transaction.insert(appConversations)
          .values({ id: randomUUID(), localDate })
          .onConflictDoNothing()
          .returning();
        conversation = created ?? (await transaction.select().from(appConversations).where(eq(appConversations.localDate, localDate)).limit(1))[0];
      }
      if (!conversation) throw new Error("Conversation creation did not return a session.");
      const messages = await transaction.select().from(appConversationMessages)
        .where(eq(appConversationMessages.conversationId, conversation.id))
        .orderBy(asc(appConversationMessages.createdAt), asc(appConversationMessages.id));
      return { conversation, messages };
    });
  }

  async send(conversationId: string, content: string, responder: ConversationResponder) {
    const userState = await this.appendUserMessage(conversationId, content);
    let reply: string;
    try {
      reply = await responder.reply({
        localDate: userState.conversation.localDate,
        messages: promptMessages(userState.messages)
      });
    } catch {
      throw new ConversationReplyUnavailableError(userState.conversation.id, userState.userMessage.id);
    }
    return this.appendAssistantReply(userState.conversation.id, userState.userMessage.id, reply);
  }

  async retryLast(conversationId: string, responder: ConversationResponder) {
    const state = await this.read(conversationId);
    const last = state.messages.at(-1);
    if (!last || last.role !== "user") throw new ConversationNoPendingReplyError();
    let reply: string;
    try {
      reply = await responder.reply({ localDate: state.conversation.localDate, messages: promptMessages(state.messages) });
    } catch {
      throw new ConversationReplyUnavailableError(state.conversation.id, last.id);
    }
    return this.appendAssistantReply(state.conversation.id, last.id, reply);
  }

  private async read(conversationId: string) {
    return this.db.transaction(async (transaction) => {
      const [conversation] = await transaction.select().from(appConversations).where(eq(appConversations.id, conversationId)).limit(1);
      if (!conversation) throw new ConversationNotFoundError();
      const messages = await transaction.select().from(appConversationMessages)
        .where(eq(appConversationMessages.conversationId, conversationId))
        .orderBy(asc(appConversationMessages.createdAt), asc(appConversationMessages.id));
      return { conversation, messages };
    });
  }

  private async appendUserMessage(conversationId: string, content: string) {
    return this.db.transaction(async (transaction) => {
      const [conversation] = await transaction.select().from(appConversations).where(eq(appConversations.id, conversationId)).limit(1);
      if (!conversation) throw new ConversationNotFoundError();
      const [userMessage] = await transaction.insert(appConversationMessages).values({
        id: randomUUID(), conversationId, role: "user", content
      }).returning();
      const [updatedConversation] = await transaction.update(appConversations)
        .set({ updatedAt: new Date() })
        .where(eq(appConversations.id, conversationId))
        .returning();
      const messages = await transaction.select().from(appConversationMessages)
        .where(eq(appConversationMessages.conversationId, conversationId))
        .orderBy(asc(appConversationMessages.createdAt), asc(appConversationMessages.id));
      return { conversation: updatedConversation!, userMessage: userMessage!, messages };
    });
  }

  private async appendAssistantReply(conversationId: string, userMessageId: string, content: string) {
    return this.db.transaction(async (transaction) => {
      const [conversation] = await transaction.select().from(appConversations).where(eq(appConversations.id, conversationId)).limit(1);
      if (!conversation) throw new ConversationNotFoundError();
      const messages = await transaction.select().from(appConversationMessages)
        .where(eq(appConversationMessages.conversationId, conversationId))
        .orderBy(asc(appConversationMessages.createdAt), asc(appConversationMessages.id));
      const last = messages.at(-1);
      if (!last || last.id !== userMessageId || last.role !== "user") throw new ConversationNoPendingReplyError();
      const [assistantMessage] = await transaction.insert(appConversationMessages).values({
        id: randomUUID(), conversationId, role: "assistant", content
      }).returning();
      const [updatedConversation] = await transaction.update(appConversations)
        .set({ updatedAt: new Date() })
        .where(eq(appConversations.id, conversationId))
        .returning();
      return { conversation: updatedConversation!, messages: [...messages, assistantMessage!] };
    });
  }
}
