import { inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { appConversationMessages, appConversations } from "@personal-ai/db/schema";
import {
  ConversationReplyUnavailableError,
  ConversationService,
  type ConversationResponder
} from "./conversation-service.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
const service = new ConversationService(connection.db);
const conversationIds: string[] = [];

afterEach(async () => {
  if (!conversationIds.length) return;
  const ids = conversationIds.splice(0);
  await connection.db.transaction(async (transaction) => {
    await transaction.delete(appConversationMessages).where(inArray(appConversationMessages.conversationId, ids));
    await transaction.delete(appConversations).where(inArray(appConversations.id, ids));
  });
});

afterAll(async () => { await connection.client.end(); });

function responder(content: string): ConversationResponder {
  return { reply: vi.fn().mockResolvedValue(content) };
}

describe("ConversationService", () => {
  it("persists a user/assistant exchange and restores the full local history", async () => {
    const localDate = "2099-08-03";
    const opened = await service.getOrOpen(localDate);
    conversationIds.push(opened.conversation.id);
    const result = await service.send(opened.conversation.id, "今天临时有变化，帮我理清风险。", responder("先确认你希望保留什么，再由你决定是否调整时间轴。"));

    expect(result.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "今天临时有变化，帮我理清风险。"],
      ["assistant", "先确认你希望保留什么，再由你决定是否调整时间轴。"]
    ]);
    const restored = await service.getOrOpen(localDate);
    expect(restored.conversation.id).toBe(opened.conversation.id);
    expect(restored.messages).toHaveLength(2);
  });

  it("keeps the user message when the provider is unavailable and can explicitly retry it", async () => {
    const localDate = "2099-08-04";
    const opened = await service.getOrOpen(localDate);
    conversationIds.push(opened.conversation.id);
    const unavailable: ConversationResponder = { reply: vi.fn().mockRejectedValue(new Error("network")) };

    await expect(service.send(opened.conversation.id, "我想晚一点开始。", unavailable)).rejects.toBeInstanceOf(ConversationReplyUnavailableError);
    expect((await service.getOrOpen(localDate)).messages.map((message) => message.role)).toEqual(["user"]);

    const retried = await service.retryLast(opened.conversation.id, responder("可以先看时间轴中的可用区间，再由你选择。"));
    expect(retried.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });
});
