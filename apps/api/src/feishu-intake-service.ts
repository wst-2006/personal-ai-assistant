import type { AppDatabase } from "@personal-ai/db/client";
import { feishuIntakeCandidates, inboxEntries, tasks } from "@personal-ai/db/schema";
import {
  localDateAtTimeZone,
  naturalLanguageTaskCandidateSchema,
  type NaturalLanguageTaskCandidate,
  type TaskInput
} from "@personal-ai/domain/task";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { TaskParser } from "./ai/task-parser.js";
import {
  ConflictSetChangedError,
  TaskScheduleWindowError,
  TaskTimeConflictError,
  type TaskService
} from "./task-service.js";

export type FeishuIntakeConfig = { targetOpenId: string; timeZone: "Asia/Shanghai" };
export type FeishuIntakeState = "parsing" | "pending" | "confirming" | "confirmed" | "cancelled" | "needs_desktop" | "failed";
export type StoredFeishuIntakeCandidate = typeof feishuIntakeCandidates.$inferSelect;

export type FeishuTextMessage = {
  messageId: string;
  chatId: string;
  operatorOpenId: string;
  text: string;
  messageType: string;
};

export type FeishuIntakeReply =
  | { kind: "none" }
  | { kind: "text"; text: string }
  | { kind: "card"; card: object };

export type FeishuIntakeAction = {
  action: "intake_confirm" | "intake_cancel";
  candidateId: string;
  expectedVersion: number;
};

export type FeishuIntakeActionResult = { type: "success" | "error"; message: string };

const actionSchema = z.object({
  action: z.enum(["intake_confirm", "intake_cancel"]),
  candidateId: z.string().uuid(),
  expectedVersion: z.number().int().positive()
}).strict();

export class FeishuIntakeAuthError extends Error {}
export class FeishuIntakePayloadError extends Error {}

export class FeishuIntakeService {
  constructor(
    private readonly config: FeishuIntakeConfig,
    private readonly db: AppDatabase,
    private readonly taskService: TaskService,
    private readonly parser: TaskParser
  ) {}

  async receive(message: FeishuTextMessage): Promise<FeishuIntakeReply> {
    if (message.operatorOpenId !== this.config.targetOpenId) return { kind: "none" };
    if (message.messageType !== "text") {
      return { kind: "text", text: "目前飞书快捷录入只处理文本消息。" };
    }
    const text = message.text.trim();
    if (!text) return { kind: "text", text: "没有读到可整理的文本，请直接发送任务、想法或问题。" };

    const received = await this.createReceived(message, text);
    if (!received) return { kind: "none" };

    try {
      const candidate = await this.parser.parse({
        text,
        referenceDate: localDateAtTimeZone(new Date(), this.config.timeZone),
        timeZone: this.config.timeZone
      });
      const state = requiresDesktop(candidate) ? "needs_desktop" : "pending";
      const stored = await this.saveParsed(received.id, candidate, state);
      if (!stored) return { kind: "none" };
      if (state === "needs_desktop") {
        return { kind: "text", text: "这条内容已整理为待完善候选；请在桌面软件中补全日期或排期后再创建，当前没有自动写入任务。" };
      }
      return { kind: "card", card: candidateCard(stored, candidate) };
    } catch (error) {
      await this.markFailed(received.id, intakeFailureDetail(error));
      return { kind: "text", text: "AI 暂时无法整理这条内容，原始消息没有被写入任务；请稍后重发，或在桌面软件中手动录入。" };
    }
  }

  /** Recover only an interrupted confirmation; this never creates a task by itself. */
  async recoverInterruptedConfirmations(): Promise<void> {
    const interrupted = await this.db.select().from(feishuIntakeCandidates)
      .where(eq(feishuIntakeCandidates.state, "confirming"));
    for (const candidate of interrupted) {
      const targetExists = candidate.targetTaskId
        ? await this.getTask(candidate.targetTaskId)
        : candidate.targetInboxEntryId
          ? await this.getInboxEntry(candidate.targetInboxEntryId)
          : null;
      if (targetExists) {
        await this.transition(candidate.id, candidate.version, "confirming", "confirmed", { resolvedAt: new Date() });
      } else {
        await this.transition(candidate.id, candidate.version, "confirming", "pending", {
          lastError: "应用在确认过程中退出；可再次确认",
          resolvedAt: undefined
        });
      }
    }
  }

  async handleCardAction(operatorOpenId: string | undefined, value: unknown): Promise<FeishuIntakeActionResult> {
    if (operatorOpenId !== this.config.targetOpenId) throw new FeishuIntakeAuthError("card operator does not match the configured single user");
    const action = actionSchema.safeParse(value);
    if (!action.success) throw new FeishuIntakePayloadError("invalid Feishu intake action payload");
    const current = await this.get(action.data.candidateId);
    if (!current || current.operatorOpenId !== operatorOpenId) return { type: "error", message: "这条录入候选不存在或不属于当前用户。" };

    if (action.data.action === "intake_cancel") {
      if (current.state === "cancelled") return { type: "success", message: "这条候选已放弃，没有创建任何任务。" };
      if (current.state !== "pending" || current.version !== action.data.expectedVersion) {
        return { type: "error", message: stateMessage(current.state) };
      }
      const cancelled = await this.transition(current.id, current.version, "pending", "cancelled", {});
      return cancelled
        ? { type: "success", message: "已放弃这条候选，没有创建任何任务。" }
        : { type: "error", message: "候选状态已变化，请打开软件查看。" };
    }

    if (current.state === "confirmed") return confirmedMessage(current);
    if (current.state === "needs_desktop" || current.state === "failed" || current.state === "cancelled") {
      return { type: "error", message: stateMessage(current.state) };
    }

    let confirming = current;
    if (current.state === "pending") {
      const resumable = Boolean(current.targetTaskId || current.targetInboxEntryId);
      if (current.version !== action.data.expectedVersion && !resumable) {
        return { type: "error", message: "候选内容已经变化，请在软件中查看最新内容。" };
      }
      const target = resumable
        ? { targetTaskId: current.targetTaskId, targetInboxEntryId: current.targetInboxEntryId }
        : targetsFor(current);
      const claimed = await this.claim(current.id, current.version, target);
      if (!claimed) {
        const afterClaim = await this.get(current.id);
        if (!afterClaim) return { type: "error", message: "候选不存在，请在软件中重新录入。" };
        if (afterClaim.state === "confirmed") return confirmedMessage(afterClaim);
        if (afterClaim.state !== "confirming") return { type: "error", message: stateMessage(afterClaim.state) };
        confirming = afterClaim;
      } else {
        confirming = claimed;
      }
    }

    if (confirming.state !== "confirming") return { type: "error", message: stateMessage(confirming.state) };
    return this.completeConfirmation(confirming);
  }

  private async completeConfirmation(current: StoredFeishuIntakeCandidate): Promise<FeishuIntakeActionResult> {
    const candidate = parseCandidate(current.candidate);
    if (!candidate) {
      await this.transition(current.id, current.version, "confirming", "failed", { lastError: "候选内容无法读取", resolvedAt: new Date() });
      return { type: "error", message: "候选内容无法读取，请在桌面软件中重新录入。" };
    }

    try {
      if (candidate.entryType === "task") {
        const input = candidateToTaskInput(candidate, this.config.timeZone);
        if (!input || !current.targetTaskId) return this.needsDesktop(current, "任务排期不完整");
        const existing = await this.getTask(current.targetTaskId);
        if (!existing) await this.taskService.createFromFeishu(input, current.targetTaskId);
        const confirmed = await this.transition(current.id, current.version, "confirming", "confirmed", { resolvedAt: new Date() });
        return confirmed ? confirmedMessage(confirmed) : this.confirmationStateAfterRace(current.id);
      }

      if (!current.targetInboxEntryId) return this.needsDesktop(current, "想法或问题缺少保存目标");
      const existing = await this.getInboxEntry(current.targetInboxEntryId);
      if (!existing) await this.taskService.createInboxFromFeishu(candidate.entryType, candidate.title, candidate.notes, current.targetInboxEntryId);
      const confirmed = await this.transition(current.id, current.version, "confirming", "confirmed", { resolvedAt: new Date() });
      return confirmed ? { type: "success", message: candidate.entryType === "idea" ? "已保存为想法，尚未创建任务。" : "已保存为待处理问题，尚未创建任务。" } : this.confirmationStateAfterRace(current.id);
    } catch (error) {
      if (error instanceof TaskTimeConflictError || error instanceof ConflictSetChangedError || error instanceof TaskScheduleWindowError) {
        return this.needsDesktop(current, "排期需要在桌面端确认");
      }
      if (isUniqueViolation(error)) {
        return this.completeConfirmation(await this.require(current.id));
      }
      await this.transition(current.id, current.version, "confirming", "failed", {
        lastError: "创建记录时发生异常",
        resolvedAt: new Date()
      });
      return { type: "error", message: "保存未完成，原始内容没有被自动写入任务；请在桌面软件中重新录入。" };
    }
  }

  private async confirmationStateAfterRace(id: string): Promise<FeishuIntakeActionResult> {
    const current = await this.get(id);
    return current?.state === "confirmed"
      ? confirmedMessage(current)
      : { type: "error", message: "保存状态正在同步，请在软件中查看结果。" };
  }

  private async needsDesktop(current: StoredFeishuIntakeCandidate, reason: string): Promise<FeishuIntakeActionResult> {
    await this.transition(current.id, current.version, "confirming", "needs_desktop", { lastError: reason, resolvedAt: new Date() });
    return { type: "error", message: "这条任务需要在桌面软件中补全或明确保留冲突；飞书不会替你自动保存。" };
  }

  private async require(id: string): Promise<StoredFeishuIntakeCandidate> {
    const current = await this.get(id);
    if (!current) throw new Error("Feishu intake candidate disappeared.");
    return current;
  }

  private async createReceived(message: FeishuTextMessage, text: string): Promise<StoredFeishuIntakeCandidate | null> {
    const [created] = await this.db.insert(feishuIntakeCandidates).values({
      id: randomUUID(),
      chatId: message.chatId,
      operatorOpenId: message.operatorOpenId,
      sourceMessageId: message.messageId,
      rawText: text,
      state: "parsing",
      version: 1
    }).onConflictDoNothing().returning();
    return created ?? null;
  }

  private async get(id: string): Promise<StoredFeishuIntakeCandidate | null> {
    const [candidate] = await this.db.select().from(feishuIntakeCandidates).where(eq(feishuIntakeCandidates.id, id)).limit(1);
    return candidate ?? null;
  }

  private async getTask(id: string) {
    const [task] = await this.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).limit(1);
    return task ?? null;
  }

  private async getInboxEntry(id: string) {
    const [entry] = await this.db.select({ id: inboxEntries.id }).from(inboxEntries).where(eq(inboxEntries.id, id)).limit(1);
    return entry ?? null;
  }

  private async saveParsed(id: string, candidate: NaturalLanguageTaskCandidate, state: "pending" | "needs_desktop") {
    const [saved] = await this.db.update(feishuIntakeCandidates).set({
      candidate,
      state,
      version: sql`${feishuIntakeCandidates.version} + 1`,
      updatedAt: new Date()
    }).where(and(eq(feishuIntakeCandidates.id, id), eq(feishuIntakeCandidates.state, "parsing"))).returning();
    return saved ?? null;
  }

  private async markFailed(id: string, error: string): Promise<void> {
    await this.db.update(feishuIntakeCandidates).set({
      state: "failed",
      lastError: error,
      resolvedAt: new Date(),
      version: sql`${feishuIntakeCandidates.version} + 1`,
      updatedAt: new Date()
    }).where(and(eq(feishuIntakeCandidates.id, id), eq(feishuIntakeCandidates.state, "parsing")));
  }

  private async claim(id: string, expectedVersion: number, target: { targetTaskId: string | null; targetInboxEntryId: string | null }) {
    const [claimed] = await this.db.update(feishuIntakeCandidates).set({
      ...target,
      state: "confirming",
      version: expectedVersion + 1,
      updatedAt: new Date()
    }).where(and(
      eq(feishuIntakeCandidates.id, id),
      eq(feishuIntakeCandidates.state, "pending"),
      eq(feishuIntakeCandidates.version, expectedVersion)
    )).returning();
    return claimed ?? null;
  }

  private async transition(
    id: string,
    expectedVersion: number,
    from: FeishuIntakeState,
    state: FeishuIntakeState,
    changes: { lastError?: string; resolvedAt?: Date }
  ) {
    const [updated] = await this.db.update(feishuIntakeCandidates).set({
      state,
      version: expectedVersion + 1,
      updatedAt: new Date(),
      ...changes
    }).where(and(
      eq(feishuIntakeCandidates.id, id),
      eq(feishuIntakeCandidates.version, expectedVersion),
      eq(feishuIntakeCandidates.state, from)
    )).returning();
    return updated ?? null;
  }
}

export function loadFeishuIntakeConfig(env: NodeJS.ProcessEnv): FeishuIntakeConfig | null {
  const targetOpenId = env.FEISHU_TARGET_OPEN_ID?.trim();
  return targetOpenId ? { targetOpenId, timeZone: "Asia/Shanghai" } : null;
}

function requiresDesktop(candidate: NaturalLanguageTaskCandidate): boolean {
  if (candidate.entryType !== "task") return false;
  return !candidateToTaskInput(candidate, "Asia/Shanghai");
}

function intakeFailureDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : "Unknown AI parser failure";
  return `AI 整理失败：${detail.replace(/\s+/g, " ").trim().slice(0, 900)}`;
}

function candidateToTaskInput(candidate: NaturalLanguageTaskCandidate, timeZone: "Asia/Shanghai"): TaskInput | null {
  if (candidate.entryType !== "task") return null;
  if (candidate.schedulePrecision === "exact" && candidate.startAt && candidate.endAt) {
    return {
      title: candidate.title,
      scheduleKind: "exact",
      startAt: candidate.startAt,
      endAt: candidate.endAt,
      timeZone,
      notes: candidate.notes,
      conflictDecision: "reject"
    };
  }
  if (candidate.date && (candidate.schedulePrecision === "morning" || candidate.schedulePrecision === "afternoon" || candidate.schedulePrecision === "evening")) {
    return {
      title: candidate.title,
      scheduleKind: "daypart",
      localDate: candidate.date,
      daypart: candidate.schedulePrecision,
      timeZone,
      notes: candidate.notes,
      conflictDecision: "reject"
    };
  }
  return null;
}

function targetsFor(candidate: StoredFeishuIntakeCandidate) {
  const parsed = parseCandidate(candidate.candidate);
  if (!parsed) throw new FeishuIntakePayloadError("candidate content is invalid");
  return parsed.entryType === "task"
    ? { targetTaskId: randomUUID(), targetInboxEntryId: null }
    : { targetTaskId: null, targetInboxEntryId: randomUUID() };
}

function parseCandidate(value: unknown): NaturalLanguageTaskCandidate | null {
  const parsed = naturalLanguageTaskCandidateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function candidateCard(record: StoredFeishuIntakeCandidate, candidate: NaturalLanguageTaskCandidate) {
  return {
    config: { wide_screen_mode: true },
    header: { template: candidate.entryType === "task" ? "blue" : "turquoise", title: { tag: "plain_text", content: "确认快捷录入" } },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: candidateSummary(candidate) } },
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: candidate.entryType === "task" ? "确认创建任务" : "确认保存" }, type: "primary", value: { action: "intake_confirm", candidateId: record.id, expectedVersion: record.version } },
          { tag: "button", text: { tag: "plain_text", content: "放弃" }, value: { action: "intake_cancel", candidateId: record.id, expectedVersion: record.version } }
        ]
      }
    ]
  };
}

function candidateSummary(candidate: NaturalLanguageTaskCandidate): string {
  const kind = candidate.entryType === "task" ? "任务" : candidate.entryType === "idea" ? "想法" : "待处理问题";
  const schedule = candidate.entryType === "task"
    ? candidate.schedulePrecision === "exact" && candidate.startAt && candidate.endAt
      ? `精确时间：${formatRange(candidate.startAt, candidate.endAt)}`
      : (candidate.schedulePrecision === "morning" || candidate.schedulePrecision === "afternoon" || candidate.schedulePrecision === "evening") && candidate.date
        ? `安排：${candidate.date} ${daypartLabel(candidate.schedulePrecision)}`
        : "安排：未完整识别"
    : "不会进入任务生命周期";
  return `${kind}\n${candidate.title}\n${schedule}${candidate.notes ? `\n备注：${candidate.notes}` : ""}`;
}

function formatRange(startAt: string, endAt: string): string {
  const formatter = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${formatter.format(new Date(startAt))} - ${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(endAt))}`;
}

function daypartLabel(value: "morning" | "afternoon" | "evening"): string {
  return value === "morning" ? "上午" : value === "afternoon" ? "下午" : "晚上";
}

function stateMessage(state: string): string {
  if (state === "confirmed") return "这条候选已经保存。";
  if (state === "cancelled") return "这条候选已经放弃。";
  if (state === "needs_desktop") return "这条内容需要在桌面软件中补全或处理冲突，飞书没有自动创建任务。";
  if (state === "failed") return "这条候选未能保存，请在桌面软件中手动录入。";
  return "这条候选正在处理，请稍后查看软件。";
}

function confirmedMessage(candidate: StoredFeishuIntakeCandidate): FeishuIntakeActionResult {
  if (!candidate.targetTaskId) return { type: "success", message: "该想法或问题已经保存；尚未创建任务。" };
  const parsed = parseCandidate(candidate.candidate);
  if (!parsed || parsed.entryType !== "task") return { type: "success", message: "该任务已经创建；请在软件中查看对应日期。" };
  const schedule = confirmedSchedule(parsed);
  return {
    type: "success",
    message: `已创建：${schedule} · ${parsed.title}\n请在软件中切换到 ${confirmedDateLabel(parsed)} 查看。`
  };
}

function confirmedSchedule(candidate: NaturalLanguageTaskCandidate): string {
  if (candidate.schedulePrecision === "exact" && candidate.startAt && candidate.endAt) {
    const date = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric" }).format(new Date(candidate.startAt));
    const time = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
    return `${date} ${time.format(new Date(candidate.startAt))}-${time.format(new Date(candidate.endAt))}`;
  }
  if (candidate.date && (candidate.schedulePrecision === "morning" || candidate.schedulePrecision === "afternoon" || candidate.schedulePrecision === "evening")) {
    return `${dateLabel(candidate.date)} ${daypartLabel(candidate.schedulePrecision)}`;
  }
  return candidate.date ? dateLabel(candidate.date) : "未排期";
}

function confirmedDateLabel(candidate: NaturalLanguageTaskCandidate): string {
  if (candidate.date) return dateLabel(candidate.date);
  if (candidate.startAt) {
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric" }).format(new Date(candidate.startAt));
  }
  return "任务列表";
}

function dateLabel(value: string): string {
  const [, month, day] = value.split("-").map(Number);
  return `${month}月${day}日`;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
