import { createHash } from "node:crypto";
import type { ReminderDeliveryContext, ReminderDeliveryProvider, ReminderDeliveryResult, ReminderJob } from "./worker-core.js";

export type FeishuConfig = {
  appId: string;
  appSecret: string;
  targetOpenId: string;
  taskUrlBase?: string;
};

type TokenState = { token: string; expiresAt: number };

export class FeishuDeliveryProvider implements ReminderDeliveryProvider {
  private tokenState: TokenState | null = null;

  constructor(private readonly config: FeishuConfig, private readonly fetcher: typeof fetch = fetch) {}

  async deliver(job: ReminderJob, context: ReminderDeliveryContext): Promise<ReminderDeliveryResult> {
    const payload = parsePayload(job.payload);
    const token = await this.tenantAccessToken();
    const updating = job.kind !== "task_start" && Boolean(context.remoteMessageId);
    const response = await this.fetcher(updating
      ? `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(context.remoteMessageId!)}`
      : "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
      method: updating ? "PATCH" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(updating ? {
        msg_type: "interactive",
        content: JSON.stringify(buildReminderCard(payload, context))
      } : {
        receive_id: this.config.targetOpenId,
        msg_type: "interactive",
        content: JSON.stringify(buildReminderCard(payload, context))
      }),
      signal: AbortSignal.timeout(10_000)
    });
    const result = await response.json().catch(() => ({})) as { code?: number; msg?: string; data?: { message_id?: string } };
    if (!response.ok || result.code !== 0) throw new Error(`feishu_message_failed:${result.code ?? response.status}:${result.msg ?? "unknown"}`);
    return { remoteMessageId: result.data?.message_id ?? context.remoteMessageId };
  }

  private async tenantAccessToken(): Promise<string> {
    if (this.tokenState && this.tokenState.expiresAt > Date.now() + 60_000) return this.tokenState.token;
    const response = await this.fetcher("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
      signal: AbortSignal.timeout(10_000)
    });
    const result = await response.json().catch(() => ({})) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (!response.ok || result.code !== 0 || !result.tenant_access_token) {
      throw new Error(`feishu_token_failed:${result.code ?? response.status}:${result.msg ?? "unknown"}`);
    }
    this.tokenState = { token: result.tenant_access_token, expiresAt: Date.now() + Math.max(60, result.expire ?? 7200) * 1000 };
    return this.tokenState.token;
  }
}

export function loadFeishuConfig(env: NodeJS.ProcessEnv): FeishuConfig | null {
  const appId = env.FEISHU_APP_ID?.trim();
  const appSecret = env.FEISHU_APP_SECRET?.trim();
  const targetOpenId = env.FEISHU_TARGET_OPEN_ID?.trim();
  if (!appId || !appSecret || !targetOpenId) return null;
  return { appId, appSecret, targetOpenId, taskUrlBase: env.APP_PUBLIC_URL?.trim() || undefined };
}

function parsePayload(value: unknown): { taskId: string; title: string; startAt: string; endAt: string; timeZone: string; scheduleRevision: number; cardState?: "started" } {
  if (!value || typeof value !== "object") throw new Error("invalid_reminder_payload");
  const payload = value as Record<string, unknown>;
  if (typeof payload.taskId !== "string" || typeof payload.title !== "string" || typeof payload.startAt !== "string"
    || typeof payload.endAt !== "string" || typeof payload.timeZone !== "string" || typeof payload.scheduleRevision !== "number") {
    throw new Error("invalid_reminder_payload");
  }
  if (payload.cardState !== undefined && payload.cardState !== "started") throw new Error("invalid_reminder_payload");
  return payload as ReturnType<typeof parsePayload>;
}

function buildReminderCard(payload: ReturnType<typeof parsePayload>, context: ReminderDeliveryContext) {
  const time = new Intl.DateTimeFormat("zh-CN", { timeZone: payload.timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(payload.startAt));
  const schedule = taskScheduleText(payload);
  if (payload.cardState === "started") {
    return {
      config: { wide_screen_mode: true },
      header: { template: "green", title: { tag: "plain_text", content: "任务已经开始" } },
      elements: [
        { tag: "div", text: { tag: "lark_md", content: `**${payload.title}**\n${schedule}\n已在桌面软件或飞书完成一次开始确认；原卡片按钮已经失效。` } }
      ]
    };
  }
  const stage = context.now.getTime() >= new Date(payload.endAt).getTime()
    ? "missed"
    : context.now.getTime() >= new Date(payload.startAt).getTime()
      ? "late"
      : context.now.getTime() >= new Date(payload.startAt).getTime() - 60_000
        ? "ready"
        : "upcoming";
  const sharedActions: Array<Record<string, unknown>> = [
    { tag: "button", text: { tag: "plain_text", content: "另有安排" }, value: { action: "other_arrangement", taskId: payload.taskId, scheduleRevision: payload.scheduleRevision, commandId: commandId(payload, "other_arrangement") } },
    { tag: "button", text: { tag: "plain_text", content: "取消任务" }, type: "danger", value: { action: "cancel_request", taskId: payload.taskId, scheduleRevision: payload.scheduleRevision, commandId: commandId(payload, "cancel_request") } }
  ];
  const actions = stage === "ready"
    ? [
        { tag: "button", text: { tag: "plain_text", content: "我会准时开始" }, type: "primary", value: { action: "start", taskId: payload.taskId, scheduleRevision: payload.scheduleRevision, commandId: commandId(payload, "start") } },
        ...sharedActions
      ]
    : stage === "late"
      ? [
          { tag: "button", text: { tag: "plain_text", content: "准时确认已失效" }, disabled: true },
          ...sharedActions
        ]
      : stage === "upcoming" ? sharedActions : [];
  const copy = stage === "missed"
    ? `**${payload.title}**\n${schedule}\n固定时段内未进入专注，已记录为未完成。`
    : stage === "late"
      ? `**${payload.title}**\n${schedule}\n开始按钮已经过期。若仍在原任务时段内，请直接告诉 AI“我开始了这个任务”，系统只从实际开始时刻记录。`
      : stage === "ready"
        ? `**${payload.title}**\n${schedule}\n还有 1 分钟开始。点击“我会准时开始”后，到原定时间自动进入专注计时。`
        : `**${payload.title}**\n${schedule}\n开始按钮会在前 1 分钟出现在这张卡片上。`;
  return {
    config: { wide_screen_mode: true },
    header: { template: stage === "missed" ? "red" : stage === "late" ? "grey" : stage === "ready" ? "orange" : "green", title: { tag: "plain_text", content: `${time} · ${stage === "missed" ? "任务未开始" : stage === "late" ? "等待迟到开始" : stage === "ready" ? "准备开始" : "即将开始"}` } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: copy } },
      ...(actions.length > 0 ? [{ tag: "action", actions }] : [])
    ]
  };
}

function taskScheduleText(payload: { startAt: string; endAt: string; timeZone: string }): string {
  const dateParts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: payload.timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric"
  }).formatToParts(new Date(payload.startAt));
  const date = `${dateParts.find((part) => part.type === "year")?.value ?? ""}年${dateParts.find((part) => part.type === "month")?.value ?? ""}月${dateParts.find((part) => part.type === "day")?.value ?? ""}日`;
  const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: payload.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  return `日期：${date}\n开始：${timeFormatter.format(new Date(payload.startAt))}\n结束：${timeFormatter.format(new Date(payload.endAt))}`;
}

function commandId(payload: ReturnType<typeof parsePayload>, action: "start" | "other_arrangement" | "cancel_request"): string {
  const bytes = createHash("sha256")
    .update(`${payload.taskId}:${payload.scheduleRevision}:${action}`)
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
