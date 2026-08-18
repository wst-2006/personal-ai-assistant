import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { appConversationMessages, appConversations, focusSessionSegmentRuns, focusSessions, focusStructures, reviewMessages, reviewSessions, taskFeedback, taskOutcomes, tasks } from "@personal-ai/db/schema";
import { eq, inArray } from "drizzle-orm";
import { ReviewReplyUnavailableError, ReviewService, type ReviewResponderInput } from "./review-service.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
const service = new ReviewService(connection.db);
const reviewIds: string[] = [];
const conversationIds: string[] = [];
const taskIds: string[] = [];

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
  if (taskIds.length) {
    const ids = taskIds.splice(0);
    await connection.db.delete(taskFeedback).where(inArray(taskFeedback.taskId, ids));
    await connection.db.delete(taskOutcomes).where(inArray(taskOutcomes.taskId, ids));
    const sessionRows = await connection.db.select({ id: focusSessions.id }).from(focusSessions).where(inArray(focusSessions.taskId, ids));
    if (sessionRows.length) await connection.db.delete(focusSessionSegmentRuns).where(inArray(focusSessionSegmentRuns.focusSessionId, sessionRows.map((row) => row.id)));
    await connection.db.delete(focusSessions).where(inArray(focusSessions.taskId, ids));
    await connection.db.delete(focusStructures).where(inArray(focusStructures.taskId, ids));
    await connection.db.delete(tasks).where(inArray(tasks.id, ids));
  }
});

afterAll(async () => { await connection.client.end(); });

describe("ReviewService conversation context", () => {
  it("reports only focus segments for an ended structured session before evaluation", async () => {
    const localDate = "2099-08-04";
    const taskId = randomUUID();
    const focusId = randomUUID();
    const structureId = randomUUID();
    taskIds.push(taskId);
    await connection.db.insert(tasks).values({
      id: taskId,
      title: "尚未评价但已经结束",
      lifecycleStatus: "awaiting_outcome",
      scheduleKind: "none",
      localDate,
      timeZone: "Asia/Shanghai"
    });
    await connection.db.insert(focusStructures).values({
      id: structureId,
      taskId,
      taskScheduleRevision: 1,
      state: "superseded",
      source: "manual",
      mode: "segmented",
      totalStartAt: new Date("2099-08-04T01:00:00.000Z"),
      totalEndAt: new Date("2099-08-04T02:00:00.000Z")
    });
    await connection.db.insert(focusSessions).values({
      id: focusId,
      taskId,
      focusStructureId: structureId,
      focusStructureVersion: 1,
      focusStructureScheduleRevision: 1,
      state: "ended",
      rawActiveSeconds: 3435,
      effectiveFocusSeconds: 0,
      endedAt: new Date("2099-08-04T02:00:00.000Z")
    });
    await connection.db.insert(focusSessionSegmentRuns).values([
      { id: randomUUID(), focusSessionId: focusId, position: 0, segmentType: "focus", plannedDurationSeconds: 3300, elapsedSeconds: 3300 },
      { id: randomUUID(), focusSessionId: focusId, position: 1, segmentType: "break", plannedDurationSeconds: 300, elapsedSeconds: 135 }
    ]);

    const loaded = await service.getOrOpen(localDate);
    reviewIds.push(loaded.session.id);

    expect(loaded.context.focusSessions[0]).toMatchObject({
      state: "ended",
      rawActiveSeconds: 3435,
      effectiveFocusSeconds: 3300
    });
  });

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

  it("persists user and AI review turns, passes explicit daily context, and recovers after provider failure", async () => {
    const localDate = "2099-08-07";
    const taskId = randomUUID();
    const focusId = randomUUID();
    const conversationId = randomUUID();
    taskIds.push(taskId);
    conversationIds.push(conversationId);
    await connection.db.transaction(async (transaction) => {
      await transaction.insert(tasks).values({
        id: taskId,
        title: "复盘上下文任务",
        lifecycleStatus: "closed",
        currentOutcome: "partial",
        scheduleKind: "none",
        localDate,
        timeZone: "Asia/Shanghai",
      });
      await transaction.insert(focusSessions).values({
        id: focusId,
        taskId,
        state: "evaluated",
        rawActiveSeconds: 3_600,
        effectiveFocusSeconds: 3_000,
      });
      await transaction.insert(taskOutcomes).values({
        id: randomUUID(),
        taskId,
        focusSessionId: focusId,
        outcome: "partial",
        progressPercent: 60,
        source: "app",
        note: "保留了主要进展",
      });
      await transaction.insert(taskFeedback).values({
        id: randomUUID(),
        taskId,
        focusSessionId: focusId,
        satisfaction: "satisfied",
        note: "节奏合适",
      });
      await transaction.insert(appConversations).values({ id: conversationId, localDate });
      await transaction.insert(appConversationMessages).values({
        id: randomUUID(), conversationId, role: "user", content: "今天临时调整过一次顺序。",
      });
    });

    const opened = await service.getOrOpen(localDate);
    reviewIds.push(opened.session.id);
    await service.addUserMessage(opened.session.id, "今天完成了核心部分，还想判断明天如何衔接。");
    let captured: ReviewResponderInput | null = null;
    const replied = await service.replyLast(opened.session.id, {
      async reply(input) {
        captured = input;
        return "核心部分已经留下，可以先明确明天最小的承接动作。";
      },
    });

    expect(replied.session.state).toBe("review_has_message");
    expect(replied.messages.map((message) => message.source)).toEqual(["app", "ai"]);
    expect(captured).not.toBeNull();
    expect(captured!.localDate).toBe(localDate);
    expect(captured!.context.tasks[0]).toMatchObject({ id: taskId, title: "复盘上下文任务", lifecycleStatus: "closed" });
    expect(captured!.context.outcomes[0]).toMatchObject({ taskId, outcome: "partial", progressPercent: 60 });
    expect(captured!.context.focusSessions[0]).toMatchObject({ taskId, rawActiveSeconds: 3_600, effectiveFocusSeconds: 3_000 });
    expect(captured!.context.feedback[0]).toMatchObject({ taskId, satisfaction: "satisfied", note: "节奏合适" });
    expect(captured!.context.conversationMessages[0]).toMatchObject({ role: "user", content: "今天临时调整过一次顺序。" });

    await service.addUserMessage(opened.session.id, "这条在接口失败时也必须保留。");
    await expect(service.replyLast(opened.session.id, { async reply() { throw new Error("provider unavailable"); } }))
      .rejects.toBeInstanceOf(ReviewReplyUnavailableError);
    const afterFailure = await service.getOrOpen(localDate);
    expect(afterFailure.messages.at(-1)).toMatchObject({ source: "app", content: "这条在接口失败时也必须保留。" });

    const retried = await service.replyLast(opened.session.id, { async reply() { return "已经恢复回复。"; } });
    expect(retried.messages.at(-1)).toMatchObject({ source: "ai", content: "已经恢复回复。" });
  });
});
