import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { appConversationMessages, appConversations, reviewMessages, reviewSessions } from "@personal-ai/db/schema";
import { eq, inArray } from "drizzle-orm";
import { ReviewService } from "./review-service.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
const service = new ReviewService(connection.db);
const reviewIds: string[] = [];
const conversationIds: string[] = [];

afterEach(async () => {
  if (reviewIds.length) {
    const ids = reviewIds.splice(0);
    await connection.db.delete(reviewMessages).where(inArray(reviewMessages.reviewSessionId, ids));
    await connection.db.delete(reviewSessions).where(inArray(reviewSessions.id, ids));
  }
  if (conversationIds.length) {
    const ids = conversationIds.splice(0);
    await connection.db.delete(appConversationMessages).where(inArray(appConversationMessages.conversationId, ids));
    await connection.db.delete(appConversations).where(inArray(appConversations.id, ids));
  }
});

afterAll(async () => { await connection.client.end(); });

describe("ReviewService conversation context", () => {
  it("exposes only same-day app conversations as separate read-only review context", async () => {
    const localDate = "2099-08-05";
    const todayConversationId = randomUUID();
    const anotherDayConversationId = randomUUID();
    conversationIds.push(todayConversationId, anotherDayConversationId);
    await connection.db.transaction(async (transaction) => {
      await transaction.insert(appConversations).values([
        { id: todayConversationId, localDate },
        { id: anotherDayConversationId, localDate: "2099-08-06" }
      ]);
      await transaction.insert(appConversationMessages).values([
        { id: randomUUID(), conversationId: todayConversationId, role: "user", content: "今天和 AI 商量的内容", createdAt: new Date("2099-08-05T10:00:00.000Z") },
        { id: randomUUID(), conversationId: todayConversationId, role: "assistant", content: "这是建议，不会修改任务。", createdAt: new Date("2099-08-05T10:00:01.000Z") },
        { id: randomUUID(), conversationId: anotherDayConversationId, role: "user", content: "不应出现在今天复盘", createdAt: new Date("2099-08-06T10:00:00.000Z") }
      ]);
    });

    const loaded = await service.getOrOpen(localDate);
    reviewIds.push(loaded.session.id);

    expect(loaded.messages).toEqual([]);
    expect(loaded.context.conversations.map((conversation) => conversation.id)).toEqual([todayConversationId]);
    expect(loaded.context.conversationMessages.map((message) => message.content)).toEqual([
      "今天和 AI 商量的内容",
      "这是建议，不会修改任务。"
    ]);
    expect(loaded.session.state).toBe("review_open");
  });
});
