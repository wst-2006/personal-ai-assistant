import { z } from "zod";
import type { FocusService } from "./focus-service.js";
import type { TaskService } from "./task-service.js";
import type { FeishuIntakeService } from "./feishu-intake-service.js";

export type FeishuCardActionConfig = { targetOpenId: string };
export type FeishuCardActionResult = { type: "success" | "error"; message: string };

const reminderActionSchema = z.object({
  action: z.enum(["start", "other_arrangement"]),
  taskId: z.string().uuid(),
  scheduleRevision: z.number().int().positive()
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
      if (action.data.action === "start") {
        await this.focusService.create(detail.task.id, detail.task.version, "prepare");
        return { type: "success", message: "已进入 1 分钟准备，随后自动开始计时。" };
      }
      const reminded = await this.focusService.create(detail.task.id, detail.task.version, "remind");
      await this.focusService.respondToReminder(reminded.id, reminded.version, "other_arrangement");
      return { type: "success", message: "已记录另有安排，任务仍保留在日程中。" };
    } catch (error) {
      const message = error instanceof Error && error.message.includes("already active")
        ? "当前已有专注会话，请先在软件中处理。"
        : "操作未完成，请打开软件查看任务当前状态。";
      return { type: "error", message };
    }
  }
}

export function loadFeishuCardActionConfig(env: NodeJS.ProcessEnv): FeishuCardActionConfig | null {
  const targetOpenId = env.FEISHU_TARGET_OPEN_ID?.trim();
  return targetOpenId ? { targetOpenId } : null;
}
