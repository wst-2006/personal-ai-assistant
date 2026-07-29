import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { FocusService } from "./focus-service.js";
import type { TaskService } from "./task-service.js";

export type FeishuWebhookConfig = { verificationToken: string; encryptKey: string; targetOpenId: string };

const actionSchema = z.object({
  action: z.enum(["start", "other_arrangement"]),
  taskId: z.string().uuid(),
  scheduleRevision: z.number().int().positive()
}).passthrough();

export class FeishuWebhookAuthError extends Error {}
export class FeishuWebhookPayloadError extends Error {}

export class FeishuWebhookService {
  constructor(
    private readonly config: FeishuWebhookConfig,
    private readonly taskService: TaskService,
    private readonly focusService: FocusService
  ) {}

  async handle(rawBody: string, headers: Record<string, string | string[] | undefined>, parsedBody: unknown): Promise<unknown> {
    const body = this.decodeAndVerify(rawBody, headers, parsedBody);
    if (body.type === "url_verification" && typeof body.challenge === "string") return { challenge: body.challenge };
    const event = object(body.event);
    const operator = object(event.operator);
    const openId = stringValue(operator.open_id) ?? stringValue(body.open_id);
    if (openId !== this.config.targetOpenId) throw new FeishuWebhookAuthError("callback operator does not match the configured single user");
    const actionContainer = object(event.action ?? body.action);
    const action = actionSchema.safeParse(actionContainer.value);
    if (!action.success) throw new FeishuWebhookPayloadError("invalid card action payload");

    try {
      const detail = await this.taskService.get(action.data.taskId);
      if (detail.task.scheduleRevision !== action.data.scheduleRevision) {
        return toast("error", "任务排期已经变化，请在软件中查看最新安排。");
      }
      if (action.data.action === "start") {
        await this.focusService.create(detail.task.id, detail.task.version, "prepare");
        return toast("success", "已进入 1 分钟准备，随后自动开始计时。");
      }
      const reminded = await this.focusService.create(detail.task.id, detail.task.version, "remind");
      await this.focusService.respondToReminder(reminded.id, reminded.version, "other_arrangement");
      return toast("success", "已记录另有安排，任务仍保留在日程中。");
    } catch (error) {
      const message = error instanceof Error && error.message.includes("already active")
        ? "当前已有专注会话，请先在软件中处理。"
        : "操作未完成，请打开软件查看任务当前状态。";
      return toast("error", message);
    }
  }

  private decodeAndVerify(rawBody: string, headers: Record<string, string | string[] | undefined>, parsedBody: unknown): Record<string, unknown> {
    const envelope = object(parsedBody);
    if (typeof envelope.encrypt === "string") {
      const timestamp = header(headers, "x-lark-request-timestamp");
      const nonce = header(headers, "x-lark-request-nonce");
      const signature = header(headers, "x-lark-signature");
      if (!timestamp || !nonce || !signature) throw new FeishuWebhookAuthError("missing Feishu signature headers");
      const expected = createHash("sha256").update(timestamp + nonce + this.config.encryptKey + rawBody).digest("hex");
      if (!constantTimeEqual(expected, signature)) throw new FeishuWebhookAuthError("invalid Feishu signature");
      const decrypted = decryptFeishuPayload(envelope.encrypt, this.config.encryptKey);
      this.assertVerificationToken(decrypted);
      return decrypted;
    }
    this.assertVerificationToken(envelope);
    return envelope;
  }

  private assertVerificationToken(body: Record<string, unknown>): void {
    const token = stringValue(body.token) ?? stringValue(object(body.header).token);
    if (!token || !constantTimeEqual(token, this.config.verificationToken)) throw new FeishuWebhookAuthError("invalid Feishu verification token");
  }
}

export function loadFeishuWebhookConfig(env: NodeJS.ProcessEnv): FeishuWebhookConfig | null {
  const verificationToken = env.FEISHU_VERIFICATION_TOKEN?.trim();
  const encryptKey = env.FEISHU_ENCRYPT_KEY?.trim();
  const targetOpenId = env.FEISHU_TARGET_OPEN_ID?.trim();
  if (!verificationToken || !encryptKey || !targetOpenId) return null;
  return { verificationToken, encryptKey, targetOpenId };
}

function decryptFeishuPayload(encrypted: string, encryptKey: string): Record<string, unknown> {
  try {
    const payload = Buffer.from(encrypted, "base64");
    const key = createHash("sha256").update(encryptKey).digest();
    const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
    const plain = Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
    return object(JSON.parse(plain));
  } catch { throw new FeishuWebhookAuthError("invalid encrypted Feishu payload"); }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function toast(type: "success" | "error", content: string) { return { toast: { type, content } }; }
