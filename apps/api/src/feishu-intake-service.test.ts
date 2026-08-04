import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { feishuIntakeCandidates, inboxEntries, reminderJobs, taskLifecycleEvents, tasks } from "@personal-ai/db/schema";
import type { NaturalLanguageTaskCandidate } from "@personal-ai/domain/task";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { TaskParser } from "./ai/task-parser.js";
import { FeishuIntakeService } from "./feishu-intake-service.js";
import { PostgresTaskStore } from "./task-repository.js";
import { TaskService } from "./task-service.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
const taskService = new TaskService(new PostgresTaskStore(connection.db));
const owner = "ou_feishu_intake_test";
const createdCandidateIds: string[] = [];
const createdTaskIds: string[] = [];
const createdInboxIds: string[] = [];

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

    const [confirmed] = await connection.db.select().from(feishuIntakeCandidates).where(eq(feishuIntakeCandidates.id, candidate.id));
    expect(confirmed?.state).toBe("confirmed");
    expect(confirmed?.targetTaskId).toBeTruthy();
    if (confirmed?.targetTaskId) createdTaskIds.push(confirmed.targetTaskId);
    const task = await connection.db.select().from(tasks).where(eq(tasks.id, confirmed!.targetTaskId!));
    expect(task).toHaveLength(1);
    expect(task[0]).toMatchObject({ title: `飞书确认任务 ${suffix}`, scheduleKind: "exact", lifecycleStatus: "open" });

    await expect(service.handleCardAction(owner, {
      action: "intake_confirm", candidateId: candidate.id, expectedVersion: candidate.version
    })).resolves.toMatchObject({ type: "success", message: expect.stringContaining("已经创建") });
    expect(await connection.db.select().from(tasks).where(eq(tasks.title, `飞书确认任务 ${suffix}`))).toHaveLength(1);
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
  await connection.client.end();
});
