import { createHash } from "node:crypto";
import { z } from "zod";
import type { FocusService } from "./focus-service.js";
import type { TaskService } from "./task-service.js";
import type { FeishuIntakeService } from "./feishu-intake-service.js";

export type FeishuCardActionConfig = { targetOpenId: string };
export type FeishuCardActionResult = { type: "success" | "error"; message: string; terminal?: boolean; card?: object };

const reminderActionSchema = z.object({
  action: z.enum(["start", "other_arrangement", "cancel_request", "cancel_confirm", "cancel_keep"]),
  taskId: z.string().uuid(),
  scheduleRevision: z.number().int().positive(),
  commandId: z.string().uuid().optional()
}).passthrough();

const intakeActionSchema = z.object({
  action: z.enum(["intake_confirm", "intake_cancel"]),
  candidateId: z.string().uuid(),
  expectedVersion: z.number().int().positive()
}).strict();

export class FeishuActionAuthError extends Error {}
export class FeishuActionPayloadError extends Error {}

export class FeishuCardActionService {
  constructor(
    private readonly config: FeishuCardActionConfig,
    private readonly taskService: TaskService,
    private readonly focusService: FocusService,
    private readonly intakeService?: FeishuIntakeService
  ) {}

  async handle(operatorOpenId: string | undefined, value: unknown): Promise<FeishuCardActionResult> {
    if (operatorOpenId !== this.config.targetOpenId) {
      throw new FeishuActionAuthError("card operator does not match the configured single user");
    }
    const intakeAction = intakeActionSchema.safeParse(value);
    if (intakeAction.success) {
      if (!this.intakeService) throw new FeishuActionPayloadError("Feishu intake is not configured");
      return this.intakeService.handleCardAction(operatorOpenId, intakeAction.data);
    }
    const action = reminderActionSchema.safeParse(value);
    if (!action.success) throw new FeishuActionPayloadError("invalid card action payload");

    try {
      const detail = await this.taskService.get(action.data.taskId);
      if (detail.task.scheduleRevision !== action.data.scheduleRevision) {
        return { type: "error", message: "任务排期已经变化，请在软件中查看最新安排。" };
      }
      const focus = await this.focusService.currentForTask(detail.task.id);
      if (focus && ["armed", "running"].includes(focus.state)) {
        if (action.data.action === "start") return startedResult(detail.task.title, focus.state);
        return {
          type: "success",
          message: "任务已经开始，当前卡片操作已失效。",
          card: statusCard("任务已经开始", detail.task.title, "任务已进入固定时段，不能取消、改期或重复操作。", "green")
        };
      }
      if (action.data.action === "cancel_request") {
        if (detail.task.lifecycleStatus !== "open") {
          return { type: "error", message: "任务已经开始或结束，当前不能取消。" };
        }
        return {
          type: "success",
          message: "请再次确认是否取消任务。",
          card: cancelConfirmationCard(detail.task.id, detail.task.scheduleRevision, detail.task.title)
        };
      }
      if (action.data.action === "cancel_keep") {
        return {
          type: "success",
          message: "已保留任务，原计划不变。",
          card: reminderControlsCard(detail.task)
        };
      }
      if (action.data.action === "cancel_confirm") {
        await this.taskService.cancelAndTrash(detail.task.id, detail.task.version, "飞书二次确认取消任务");
        return {
          type: "success",
          message: "任务已取消并移入回收站。",
          card: statusCard("任务已取消", detail.task.title, "不会再启动或发送后续提醒；如需恢复，请在软件回收站操作。", "red")
        };
      }
      if (action.data.action === "start") {
        const session = await this.focusService.create(detail.task.id, detail.task.version, "prepare", action.data.commandId);
        return startedResult(detail.task.title, session.state);
      }
      if (focus && ["scheduled", "reminded", "preparing", "awaiting_late_start"].includes(focus.state)) {
        await this.focusService.otherArrangement(
          focus.id,
          focus.version,
          "飞书选择另有安排",
          action.data.commandId ? deriveCommandId(action.data.commandId, "respond") : undefined
        );
      }
      await this.taskService.update(detail.task.id, {
        expectedVersion: detail.task.version,
        expectedScheduleRevision: detail.task.scheduleRevision,
        scheduleKind: "none",
        localDate: detail.task.localDate,
        daypart: null,
        startAt: null,
        endAt: null,
        conflictDecision: "reject"
      });
      return {
        type: "success",
        message: "已退回未排期任务。",
        card: statusCard("已退回未排期任务", detail.task.title, "原时间已释放；需要时可重新拖入时间轴安排。", "grey")
      };
    } catch (error) {
      const message = error instanceof Error && error.message.includes("already active")
        ? "当前已有专注会话，请先在软件中处理。"
        : "操作未完成，请打开软件查看任务当前状态。";
      return { type: "error", message };
    }
  }
}

function startedResult(title: string, state: string): FeishuCardActionResult {
  if (state === "armed") {
    return {
      type: "success",
      message: "任务已经开始。到点会自动进入计时，原卡片按钮已失效。",
      card: statusCard("任务已经开始", title, "已记录你的开始意图；到固定开始时刻自动进入专注计时。", "green")
    };
  }
  if (state === "running") {
    return {
      type: "success",
      message: "任务已经开始，正在从现在计时到原定结束时间。",
      card: statusCard("任务已经开始", title, "正在计时；本次专注从实际开始时间计算，并在原定结束时间停止。", "green")
    };
  }
  return { type: "error", message: "任务当前无法开始，请打开软件查看。", terminal: false };
}

function statusCard(
  heading: string,
  title: string,
  detail: string,
  template: "green" | "red" | "grey"
) {
  return {
    config: { wide_screen_mode: true },
    header: { template, title: { tag: "plain_text", content: heading } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `**${title}**\n${detail}` } }
    ]
  };
}

function deriveCommandId(commandId: string, phase: "respond"): string {
  const bytes = createHash("sha256").update(`${commandId}:${phase}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function cancelConfirmationCard(taskId: string, scheduleRevision: number, title: string) {
  return {
    config: { wide_screen_mode: true },
    header: { template: "red", title: { tag: "plain_text", content: "确认取消任务" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `**${title}**\n取消后任务保留在记录中，但不会再启动或提醒。` } },
      { tag: "action", actions: [
        { tag: "button", text: { tag: "plain_text", content: "确认取消" }, type: "danger", value: { action: "cancel_confirm", taskId, scheduleRevision } },
        { tag: "button", text: { tag: "plain_text", content: "保留任务" }, value: { action: "cancel_keep", taskId, scheduleRevision } }
      ] }
    ]
  };
}

function reminderControlsCard(task: Awaited<ReturnType<TaskService["get"]>>["task"]) {
  const now = Date.now();
  const startAt = task.startAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const endAt = task.endAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const actions: Array<Record<string, unknown>> = [];
  if (now >= startAt - 60_000 && now < startAt) {
    actions.push({ tag: "button", text: { tag: "plain_text", content: "开始任务" }, type: "primary", value: { action: "start", taskId: task.id, scheduleRevision: task.scheduleRevision } });
  } else if (now >= startAt && now < endAt) {
    actions.push({ tag: "button", text: { tag: "plain_text", content: "开始任务" }, disabled: true });
  }
  actions.push(
    { tag: "button", text: { tag: "plain_text", content: "另有安排" }, value: { action: "other_arrangement", taskId: task.id, scheduleRevision: task.scheduleRevision } },
    { tag: "button", text: { tag: "plain_text", content: "取消任务" }, type: "danger", value: { action: "cancel_request", taskId: task.id, scheduleRevision: task.scheduleRevision } }
  );
  return {
    config: { wide_screen_mode: true },
    header: { template: "green", title: { tag: "plain_text", content: "任务仍按原计划" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `**${task.title}**\n已撤销取消操作。` } },
      { tag: "action", actions }
    ]
  };
}

export function loadFeishuCardActionConfig(env: NodeJS.ProcessEnv): FeishuCardActionConfig | null {
  const targetOpenId = env.FEISHU_TARGET_OPEN_ID?.trim();
  return targetOpenId ? { targetOpenId } : null;
}
