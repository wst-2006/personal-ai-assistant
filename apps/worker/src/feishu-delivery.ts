import type { ReminderDeliveryContext, ReminderDeliveryProvider, ReminderJob } from "./worker-core.js";

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

  async deliver(job: ReminderJob, context: ReminderDeliveryContext): Promise<void> {
    const payload = parsePayload(job.payload);
    const token = await this.tenantAccessToken();
    const response = await this.fetcher("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        receive_id: this.config.targetOpenId,
        msg_type: "interactive",
        content: JSON.stringify(buildReminderCard(payload, context, this.config.taskUrlBase))
      }),
      signal: AbortSignal.timeout(10_000)
    });
    const result = await response.json().catch(() => ({})) as { code?: number; msg?: string };
    if (!response.ok || result.code !== 0) throw new Error(`feishu_message_failed:${result.code ?? response.status}:${result.msg ?? "unknown"}`);
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

function parsePayload(value: unknown): { taskId: string; title: string; startAt: string; endAt: string; timeZone: string; scheduleRevision: number } {
  if (!value || typeof value !== "object") throw new Error("invalid_reminder_payload");
  const payload = value as Record<string, unknown>;
  if (typeof payload.taskId !== "string" || typeof payload.title !== "string" || typeof payload.startAt !== "string"
    || typeof payload.endAt !== "string" || typeof payload.timeZone !== "string" || typeof payload.scheduleRevision !== "number") {
    throw new Error("invalid_reminder_payload");
  }
  return payload as ReturnType<typeof parsePayload>;
}

function buildReminderCard(payload: ReturnType<typeof parsePayload>, context: ReminderDeliveryContext, taskUrlBase?: string) {
  const time = new Intl.DateTimeFormat("zh-CN", { timeZone: payload.timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(payload.startAt));
  const isInProgress = context.timing === "in_progress";
  const remainingMinutes = Math.max(0, Math.ceil((new Date(payload.endAt).getTime() - context.now.getTime()) / 60_000));
  const actions: Array<Record<string, unknown>> = [
    { tag: "button", text: { tag: "plain_text", content: "开始" }, type: "primary", value: { action: "start", taskId: payload.taskId, scheduleRevision: payload.scheduleRevision } },
    { tag: "button", text: { tag: "plain_text", content: "另有安排" }, value: { action: "other_arrangement", taskId: payload.taskId, scheduleRevision: payload.scheduleRevision } },
    { tag: "button", text: { tag: "plain_text", content: "打开任务" }, value: { action: "open_task", taskId: payload.taskId, scheduleRevision: payload.scheduleRevision } }
  ];
  if (taskUrlBase) actions.push({ tag: "button", text: { tag: "plain_text", content: "打开网页版" }, url: `${taskUrlBase.replace(/\/$/, "")}/?task=${encodeURIComponent(payload.taskId)}` });
  return {
    config: { wide_screen_mode: true },
    header: { template: isInProgress ? "orange" : "green", title: { tag: "plain_text", content: `${time} · ${isInProgress ? "任务已开始" : "即将开始"}` } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: isInProgress
        ? `**${payload.title}**\n原定任务已经开始，目前还剩约 ${remainingMinutes} 分钟。可以按剩余时间开始，也可以说明另有安排。`
        : `**${payload.title}**\n可以现在进入 1 分钟准备，也可以说明另有安排。` } },
      { tag: "action", actions }
    ]
  };
}
