import type { HealthConversationNotifier } from "./health-conversation-service.js";

export type FeishuHealthMessengerConfig = {
  appId: string;
  appSecret: string;
  targetOpenId: string;
};

type Fetcher = typeof fetch;

export class FeishuHealthMessenger implements HealthConversationNotifier {
  private tokenState: { token: string; expiresAt: number } | null = null;

  constructor(private readonly config: FeishuHealthMessengerConfig, private readonly fetcher: Fetcher = fetch) {}

  async notifyClarification(input: { weekStart: string; content: string }): Promise<void> {
    const token = await this.tenantToken();
    const text = [
      `【健康周笺 · ${input.weekStart} 起】`,
      input.content,
      "",
      "请直接回复“健康：你的补充”。回复会保存到这一周的健康交流，不会被当成任务或复盘。"
    ].join("\n");
    const response = await this.fetcher("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        receive_id: this.config.targetOpenId,
        msg_type: "text",
        content: JSON.stringify({ text })
      }),
      signal: AbortSignal.timeout(15_000)
    });
    const result = await response.json().catch(() => ({})) as { code?: number; msg?: string };
    if (!response.ok || result.code !== 0) throw new Error(`Feishu health clarification delivery failed: ${result.msg ?? response.status}.`);
  }

  private async tenantToken(): Promise<string> {
    if (this.tokenState && this.tokenState.expiresAt > Date.now() + 60_000) return this.tokenState.token;
    const response = await this.fetcher("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
      signal: AbortSignal.timeout(15_000)
    });
    const result = await response.json().catch(() => ({})) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (!response.ok || result.code !== 0 || !result.tenant_access_token) throw new Error(`Feishu health token request failed: ${result.msg ?? response.status}.`);
    this.tokenState = {
      token: result.tenant_access_token,
      expiresAt: Date.now() + Math.max(60, result.expire ?? 7_200) * 1_000
    };
    return this.tokenState.token;
  }
}

export function loadFeishuHealthMessengerConfig(env: NodeJS.ProcessEnv): FeishuHealthMessengerConfig | null {
  const appId = env.FEISHU_APP_ID?.trim();
  const appSecret = env.FEISHU_APP_SECRET?.trim();
  const targetOpenId = env.FEISHU_TARGET_OPEN_ID?.trim();
  return appId && appSecret && targetOpenId ? { appId, appSecret, targetOpenId } : null;
}
