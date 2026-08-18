import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { dailyBriefs, feishuIntakeCandidates, inboxEntries, reminderJobs, taskLifecycleEvents, tasks } from "@personal-ai/db/schema";
import { localDateAtTimeZone, type NaturalLanguageTaskCandidate } from "@personal-ai/domain/task";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { TaskParser } from "./ai/task-parser.js";
import { FeishuIntakeService } from "./feishu-intake-service.js";
import { BriefService } from "./brief-service.js";
import type { HealthConversationResponder, HealthConversationService } from "./health-conversation-service.js";
import { PostgresTaskStore } from "./task-repository.js";
import { TaskService } from "./task-service.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
const taskService = new TaskService(new PostgresTaskStore(connection.db));
const owner = "ou_feishu_intake_test";
const createdCandidateIds: string[] = [];
const createdTaskIds: string[] = [];
const createdInboxIds: string[] = [];
const createdBriefIds: string[] = [];

function exactCandidate(title: string, startAt = "2099-12-28T09:00:00+08:00"): NaturalLanguageTaskCandidate {
  const endAt = new Date(new Date(startAt).getTime() + 60 * 60 * 1000).toISOString();
  return {
    title,
    entryType: "task",
    date: "2099-12-28",
    startAt,
    endAt,
    schedulePrecision: "exact",
    notes: "来自飞书测试",
    // Notes are optional for a formal task and must not force a desktop-only path.
    missingFields: ["notes"]
  };
}

function intake(candidate: NaturalLanguageTaskCandidate) {
  const parser: TaskParser = { parse: async () => candidate };
  return new FeishuIntakeService({ targetOpenId: owner, timeZone: "Asia/Shanghai" }, connection.db, taskService, parser);
}

async function storedCandidate(sourceMessageId: string) {
  const [candidate] = await connection.db.select().from(feishuIntakeCandidates)
    .where(eq(feishuIntakeCandidates.sourceMessageId, sourceMessageId));
  if (!candidate) throw new Error("Expected Feishu intake candidate.");
  createdCandidateIds.push(candidate.id);
  return candidate;
}

describe("Feishu text intake", () => {
  it("imports an allowlisted Work Buddy post as one deduplicated standalone draft", async () => {
    const suffix = randomUUID();
    const workBuddySender = `ou_work_buddy_${suffix}`;
    const title = `Work Buddy 每日简报 ${suffix}`;
    const parser: TaskParser = { parse: vi.fn().mockRejectedValue(new Error("Work Buddy briefs must not reach task parsing")) };
    const briefService = new BriefService(connection.db);
    const service = new FeishuIntakeService(
      { targetOpenId: owner, timeZone: "Asia/Shanghai", workBuddySenderIds: [workBuddySender] },
      connection.db,
      taskService,
      parser,
      undefined,
      undefined,
      briefService
    );
    const message = {
      messageId: `om_work_buddy_${suffix}`,
      chatId: `oc_work_buddy_${suffix}`,
      operatorOpenId: workBuddySender,
      messageType: "post",
      text: `# ${title}\n\nAI 与科技今日有新的公开资料。\nhttps://example.com/work-buddy-source`
    };

    await expect(service.receive(message)).resolves.toEqual({
      kind: "text",
      text: expect.stringContaining("待确认")
    });
    await expect(service.receive(message)).resolves.toEqual({
      kind: "text",
      text: expect.stringContaining("已经导入过")
    });
    expect(parser.parse).not.toHaveBeenCalled();
    const localDate = localDateAtTimeZone(new Date(), "Asia/Shanghai");
    const stored = (await briefService.listStandalone(localDate)).find((brief) => (brief.content as { title?: string }).title === title);
    expect(stored).toMatchObject({ reviewSessionId: null, state: "draft" });
    expect(stored?.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "external_brief", provider: "work_buddy" }),
      expect.objectContaining({ url: "https://example.com/work-buddy-source" })
    ]));
    if (stored) createdBriefIds.push(stored.id);
  });

  it("routes an explicit health reply into the health-week ledger before task parsing", async () => {
    const suffix = randomUUID();
    const conversationId = randomUUID();
    const parser: TaskParser = { parse: vi.fn().mockRejectedValue(new Error("health text must not reach task parsing")) };
    const healthService = {
      hasExternalMessage: vi.fn().mockResolvedValue(false),
      getOrOpen: vi.fn().mockResolvedValue({ conversation: { id: conversationId, weekStart: "2026-08-16" }, messages: [] }),
      saveUserMessage: vi.fn().mockResolvedValue({ conversation: { id: conversationId, weekStart: "2026-08-16" }, messages: [] }),
      retryLast: vi.fn().mockResolvedValue({
        conversation: { id: conversationId, weekStart: "2026-08-16" },
        messages: [{ role: "assistant", content: "已经记入本周健康交流，可以回到健康栏目生成候选。" }]
      })
    } as unknown as HealthConversationService;
    const responder = { reply: vi.fn() } as unknown as HealthConversationResponder;
    const service = new FeishuIntakeService(
      { targetOpenId: owner, timeZone: "Asia/Shanghai" },
      connection.db,
      taskService,
      parser,
      undefined,
      { service: healthService, responder }
    );
    const message = {
      messageId: `om_health_${suffix}`,
      chatId: "oc_health",
      operatorOpenId: owner,
      messageType: "text",
      text: "健康：这周力量训练安排在周一、周三和周五"
    };

    await expect(service.receive(message)).resolves.toEqual({
      kind: "text",
      text: "已经记入本周健康交流，可以回到健康栏目生成候选。"
    });
    expect(parser.parse).not.toHaveBeenCalled();
    expect(healthService.saveUserMessage).toHaveBeenCalledWith(
      conversationId,
      "这周力量训练安排在周一、周三和周五",
      "feishu",
      message.messageId
    );
  });

  it("persists the parser failure reason for diagnosis without creating data", async () => {
    const suffix = randomUUID();
    const parser: TaskParser = {
      parse: async () => { throw new Error("candidate title was null"); }
    };
    const service = new FeishuIntakeService(
      { targetOpenId: owner, timeZone: "Asia/Shanghai" },
      connection.db,
      taskService,
      parser
    );
    const message = {
      messageId: `om_failed_${suffix}`,
      chatId: "oc_test",
      operatorOpenId: owner,
      messageType: "text",
      text: "想法：诊断失败候选"
    };

    await expect(service.receive(message)).resolves.toMatchObject({
      kind: "text",
      text: expect.stringContaining("没有被写入任务")
    });
    const candidate = await storedCandidate(message.messageId);
    expect(candidate).toMatchObject({
      state: "failed",
      lastError: "AI 整理失败：candidate title was null",
      targetTaskId: null,
      targetInboxEntryId: null
    });
  });

  it("persists a parsed candidate, then creates exactly one task only after confirmation", async () => {
    const suffix = randomUUID();
    const service = intake(exactCandidate(`飞书确认任务 ${suffix}`));
    const message = {
      messageId: `om_task_${suffix}`,
      chatId: "oc_test",
      operatorOpenId: owner,
      messageType: "text",
      text: "12月28日上午九点安排测试任务"
    };

    const reply = await service.receive(message);
    expect(reply.kind).toBe("card");
    await expect(service.receive(message)).resolves.toEqual({ kind: "none" });

    const candidate = await storedCandidate(message.messageId);
    expect(candidate.state).toBe("pending");
    expect(candidate.targetTaskId).toBeNull();
    expect(await connection.db.select().from(tasks).where(eq(tasks.title, `飞书确认任务 ${suffix}`))).toHaveLength(0);

    const first = await service.handleCardAction(owner, {
      action: "intake_confirm", candidateId: candidate.id, expectedVersion: candidate.version
    });
    expect(first).toMatchObject({ type: "success" });
    expect(first.message).toContain("12月28日 09:00-10:00");
    expect(first.message).toContain(`飞书确认任务 ${suffix}`);
    expect(first.message).not.toContain("今日时间轴");

    const [confirmed] = await connection.db.select().from(feishuIntakeCandidates).where(eq(feishuIntakeCandidates.id, candidate.id));
    expect(confirmed?.state).toBe("confirmed");
    expect(confirmed?.targetTaskId).toBeTruthy();
    if (confirmed?.targetTaskId) createdTaskIds.push(confirmed.targetTaskId);
    const task = await connection.db.select().from(tasks).where(eq(tasks.id, confirmed!.targetTaskId!));
    expect(task).toHaveLength(1);
    expect(task[0]).toMatchObject({ title: `飞书确认任务 ${suffix}`, scheduleKind: "exact", lifecycleStatus: "open" });

    await expect(service.handleCardAction(owner, {
      action: "intake_confirm", candidateId: candidate.id, expectedVersion: candidate.version
    })).resolves.toMatchObject({ type: "success", message: expect.stringContaining("已创建") });
    expect(await connection.db.select().from(tasks).where(eq(tasks.title, `飞书确认任务 ${suffix}`))).toHaveLength(1);
  });

  it("asks for a missing duration and only then produces the confirmation card", async () => {
    const suffix = randomUUID();
    const partial: NaturalLanguageTaskCandidate = {
      title: `飞书补时长任务 ${suffix}`,
      entryType: "task",
      date: "2099-12-28",
      startAt: "2099-12-28T09:00:00+08:00",
      endAt: null,
      schedulePrecision: "exact",
      notes: null,
      missingFields: ["endAt"]
    };
    const complete = exactCandidate(partial.title);
    const parser: TaskParser = { parse: vi.fn().mockResolvedValueOnce(partial).mockResolvedValueOnce(complete) };
    const service = new FeishuIntakeService(
      { targetOpenId: owner, timeZone: "Asia/Shanghai" },
      connection.db,
      taskService,
      parser
    );
    const firstMessage = {
      messageId: `om_duration_start_${suffix}`,
      chatId: `oc_duration_${suffix}`,
      operatorOpenId: owner,
      messageType: "text",
      text: "12月28日上午九点整理材料"
    };
    await expect(service.receive(firstMessage)).resolves.toEqual({
      kind: "text",
      text: expect.stringContaining("准备做多久")
    });
    const stored = await storedCandidate(firstMessage.messageId);
    expect(stored.state).toBe("awaiting_duration");

    const durationMessage = {
      ...firstMessage,
      messageId: `om_duration_reply_${suffix}`,
      text: "1 小时"
    };
    await expect(service.receive(durationMessage)).resolves.toMatchObject({ kind: "card" });
    const [updated] = await connection.db.select().from(feishuIntakeCandidates).where(eq(feishuIntakeCandidates.id, stored.id));
    expect(updated).toMatchObject({ state: "pending", lastSourceMessageId: durationMessage.messageId });
    expect(parser.parse).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("用户补充时长：1 小时")
    }));
    await expect(service.receive(durationMessage)).resolves.toEqual({ kind: "none" });
  });

  it("keeps ideas out of the task lifecycle after confirmation", async () => {
    const suffix = randomUUID();
    const service = intake({
      title: `飞书想法 ${suffix}`,
      entryType: "idea",
      date: null,
      startAt: null,
      endAt: null,
      schedulePrecision: null,
      notes: "先记录，之后再决定是否转为任务",
      missingFields: []
    });
    const message = { messageId: `om_idea_${suffix}`, chatId: "oc_test", operatorOpenId: owner, messageType: "text", text: "记一个想法" };
    expect((await service.receive(message)).kind).toBe("card");
    const candidate = await storedCandidate(message.messageId);

    await expect(service.handleCardAction(owner, {
      action: "intake_confirm", candidateId: candidate.id, expectedVersion: candidate.version
    })).resolves.toMatchObject({ type: "success", message: expect.stringContaining("想法") });

    const [confirmed] = await connection.db.select().from(feishuIntakeCandidates).where(eq(feishuIntakeCandidates.id, candidate.id));
    expect(confirmed?.targetTaskId).toBeNull();
    expect(confirmed?.targetInboxEntryId).toBeTruthy();
    if (confirmed?.targetInboxEntryId) createdInboxIds.push(confirmed.targetInboxEntryId);
    expect(await connection.db.select().from(tasks).where(eq(tasks.title, `飞书想法 ${suffix}`))).toHaveLength(0);
    expect(await connection.db.select().from(inboxEntries).where(eq(inboxEntries.id, confirmed!.targetInboxEntryId!))).toHaveLength(1);
  });

  it("does not silently keep a time conflict from Feishu", async () => {
    const suffix = randomUUID();
    const existing = await taskService.create({
      title: `飞书冲突基线 ${suffix}`,
      scheduleKind: "exact",
      startAt: "2099-12-28T13:00:00+08:00",
      endAt: "2099-12-28T14:00:00+08:00",
      timeZone: "Asia/Shanghai",
      conflictDecision: "reject"
    });
    createdTaskIds.push(existing.task.id);
    const service = intake(exactCandidate(`飞书冲突候选 ${suffix}`, "2099-12-28T13:00:00+08:00"));
    const message = { messageId: `om_conflict_${suffix}`, chatId: "oc_test", operatorOpenId: owner, messageType: "text", text: "13点安排冲突测试" };
    expect((await service.receive(message)).kind).toBe("card");
    const candidate = await storedCandidate(message.messageId);

    await expect(service.handleCardAction(owner, {
      action: "intake_confirm", candidateId: candidate.id, expectedVersion: candidate.version
    })).resolves.toMatchObject({ type: "error", message: expect.stringContaining("桌面软件") });
    const [afterConflict] = await connection.db.select().from(feishuIntakeCandidates).where(eq(feishuIntakeCandidates.id, candidate.id));
    expect(afterConflict?.state).toBe("needs_desktop");
    expect(await connection.db.select().from(tasks).where(eq(tasks.title, `飞书冲突候选 ${suffix}`))).toHaveLength(0);
  });

  it("recovers an interrupted confirmation without duplicating its intended task", async () => {
    const suffix = randomUUID();
    const candidateId = randomUUID();
    const targetTaskId = randomUUID();
    const parsed = exactCandidate(`飞书恢复任务 ${suffix}`, "2099-12-28T15:00:00+08:00");
    createdCandidateIds.push(candidateId);
    createdTaskIds.push(targetTaskId);
    await connection.db.insert(feishuIntakeCandidates).values({
      id: candidateId,
      chatId: "oc_test",
      operatorOpenId: owner,
      sourceMessageId: `om_recovery_${suffix}`,
      rawText: "恢复中的快捷录入",
      candidate: parsed,
      state: "confirming",
      version: 3,
      targetTaskId,
      targetInboxEntryId: null
    });
    const service = intake(parsed);
    await service.recoverInterruptedConfirmations();
    const [recovered] = await connection.db.select().from(feishuIntakeCandidates).where(eq(feishuIntakeCandidates.id, candidateId));
    expect(recovered).toMatchObject({ state: "pending", version: 4, targetTaskId });

    await expect(service.handleCardAction(owner, {
      action: "intake_confirm", candidateId, expectedVersion: 2
    })).resolves.toMatchObject({ type: "success" });
    expect(await connection.db.select().from(tasks).where(eq(tasks.id, targetTaskId))).toHaveLength(1);
  });
});

afterAll(async () => {
  for (const taskId of createdTaskIds) {
    await connection.db.delete(reminderJobs).where(eq(reminderJobs.taskId, taskId));
    await connection.db.delete(taskLifecycleEvents).where(eq(taskLifecycleEvents.taskId, taskId));
    await connection.db.delete(tasks).where(eq(tasks.id, taskId));
  }
  for (const entryId of createdInboxIds) await connection.db.delete(inboxEntries).where(eq(inboxEntries.id, entryId));
  for (const candidateId of createdCandidateIds) await connection.db.delete(feishuIntakeCandidates).where(eq(feishuIntakeCandidates.id, candidateId));
  for (const briefId of createdBriefIds) await connection.db.delete(dailyBriefs).where(eq(dailyBriefs.id, briefId));
  await connection.client.end();
});
