import { createLarkChannel, type CardActionEvent, type LarkChannel, type NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { FeishuCardActionResult, FeishuCardActionService } from "./feishu-card-actions.js";
import type { FeishuIntakeService } from "./feishu-intake-service.js";

export type FeishuLongConnectionConfig = {
  appId: string;
  appSecret: string;
  handshakeTimeoutMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
};

type CardActionHandler = (event: { messageId: string; chatId: string; operatorOpenId: string; value: unknown }) => Promise<void>;
type TextMessageHandler = (event: { messageId: string; chatId: string; operatorOpenId: string; text: string; messageType: string }) => Promise<void>;

export interface FeishuChannelClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  forceDisconnect(): Promise<void>;
  updateCard(messageId: string, card: object): Promise<void>;
  recallMessage(messageId: string): Promise<void>;
  sendText(targetId: string, text: string): Promise<void>;
  sendCard(targetId: string, card: object): Promise<void>;
  onCardAction(handler: CardActionHandler): void;
  onMessage(handler: TextMessageHandler): void;
  onError(handler: (error: Error) => void): void;
  onReconnecting(handler: () => void): void;
  onReconnected(handler: () => void): void;
}

export type FeishuChannelFactory = (config: FeishuLongConnectionConfig) => FeishuChannelClient;

export type FeishuConnectionLogger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export class FeishuLongConnectionService {
  private channel: FeishuChannelClient | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  private stopped = true;
  private generation = 0;

  constructor(
    private readonly config: FeishuLongConnectionConfig,
    private readonly actions: FeishuCardActionService,
    private readonly channelFactory: FeishuChannelFactory = createSdkChannel,
    private readonly logger: FeishuConnectionLogger = console,
    private readonly intake: FeishuIntakeService | undefined = undefined
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation += 1;
    await this.connect(this.generation);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const channel = this.channel;
    this.channel = null;
    if (channel) await channel.forceDisconnect();
  }

  private async connect(generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) return;
    const channel = this.channelFactory(this.config);
    this.channel = channel;
    channel.onCardAction(async (event) => {
      this.logger.info(`Feishu card action received: ${event.value && typeof event.value === "object" && "action" in event.value ? String((event.value as { action?: unknown }).action) : "unknown"}.`);
      try {
        const result = await this.actions.handle(event.operatorOpenId, event.value);
        try {
          // A reminder card is a one-shot control. Once acted on, retract the
          // original message so an obsolete Start/Other arrangement button
          // cannot remain in the conversation.
          await channel.recallMessage(event.messageId);
        } catch (error) {
          // Some tenants may reject message deletion. Fall back to replacing
          // the card with a terminal result before sending the confirmation.
          this.logger.warn(`Feishu card recall failed; trying card update: ${errorMessage(error)}`);
          try {
            await channel.updateCard(event.messageId, actionResultCard(result));
          } catch (updateError) {
            this.logger.warn(`Feishu card update failed; sending text fallback: ${errorMessage(updateError)}`);
          }
        }
        // Long-connection card callbacks do not provide an in-place toast response.
        // A short confirmation message guarantees visible feedback even when the
        // Feishu client keeps rendering the original card.
        await channel.sendText(event.chatId, result.message);
      } catch (error) {
        this.logger.warn(`Feishu card action rejected: ${errorMessage(error)}`);
        try {
          await channel.sendText(event.chatId, error instanceof Error ? error.message : "操作未完成，请打开软件查看任务当前状态。");
        } catch (fallbackError) {
          this.logger.warn(`Feishu card action fallback failed: ${errorMessage(fallbackError)}`);
        }
      }
    });
    channel.onMessage(async (event) => {
      if (!this.intake) return;
      try {
        const response = await this.intake.receive(event);
        if (response.kind === "text") await channel.sendText(event.chatId, response.text);
        if (response.kind === "card") await channel.sendCard(event.chatId, response.card);
      } catch (error) {
        this.logger.warn(`Feishu intake handling failed: ${errorMessage(error)}`);
        try {
          await channel.sendText(event.chatId, "快捷录入暂时不可用，原始消息没有被自动写入任务。请在软件中手动录入。");
        } catch (fallbackError) {
          this.logger.warn(`Feishu intake fallback failed: ${errorMessage(fallbackError)}`);
        }
      }
    });
    channel.onError((error) => this.logger.error(`Feishu long connection error: ${error.message}`));
    channel.onReconnecting(() => this.logger.warn("Feishu long connection reconnecting."));
    channel.onReconnected(() => this.logger.info("Feishu long connection reconnected."));

    try {
      await channel.connect();
      if (this.stopped || generation !== this.generation) {
        await channel.forceDisconnect();
        return;
      }
      this.retryAttempt = 0;
      this.logger.info("Feishu long connection established.");
    } catch (error) {
      await channel.forceDisconnect().catch(() => undefined);
      if (this.channel === channel) this.channel = null;
      if (this.stopped || generation !== this.generation) return;
      this.logger.error(`Feishu long connection failed: ${errorMessage(error)}`);
      this.scheduleRetry(generation);
    }
  }

  private scheduleRetry(generation: number): void {
    const delay = Math.min(this.config.retryBaseMs * 2 ** this.retryAttempt, this.config.retryMaxMs);
    this.retryAttempt += 1;
    this.logger.warn(`Feishu long connection will retry in ${delay}ms.`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect(generation);
    }, delay);
    this.retryTimer.unref?.();
  }
}

export function loadFeishuLongConnectionConfig(env: NodeJS.ProcessEnv): FeishuLongConnectionConfig | null {
  const transport = env.FEISHU_CALLBACK_TRANSPORT?.trim().toLowerCase() || "websocket";
  if (transport === "http") return null;
  if (transport !== "websocket") throw new Error("FEISHU_CALLBACK_TRANSPORT must be websocket or http");
  const appId = env.FEISHU_APP_ID?.trim();
  const appSecret = env.FEISHU_APP_SECRET?.trim();
  const targetOpenId = env.FEISHU_TARGET_OPEN_ID?.trim();
  if (!appId || !appSecret || !targetOpenId) return null;
  return {
    appId,
    appSecret,
    handshakeTimeoutMs: positiveInteger(env.FEISHU_WS_HANDSHAKE_TIMEOUT_MS, 15_000),
    retryBaseMs: positiveInteger(env.FEISHU_WS_RETRY_BASE_MS, 5_000),
    retryMaxMs: positiveInteger(env.FEISHU_WS_RETRY_MAX_MS, 60_000)
  };
}

function createSdkChannel(config: FeishuLongConnectionConfig): FeishuChannelClient {
  const channel = createLarkChannel({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: "websocket",
    handshakeTimeoutMs: config.handshakeTimeoutMs,
    source: "personal-ai-assistant"
  });
  return new SdkFeishuChannel(channel);
}

class SdkFeishuChannel implements FeishuChannelClient {
  constructor(private readonly channel: LarkChannel) {}
  connect() { return this.channel.connect(); }
  disconnect() { return this.channel.disconnect(); }
  async forceDisconnect() {
    this.channel.rawWsClient?.close({ force: true });
    await this.channel.disconnect();
  }
  updateCard(messageId: string, card: object) { return this.channel.updateCard(messageId, card); }
  recallMessage(messageId: string) { return this.channel.recallMessage(messageId); }
  async sendText(targetId: string, text: string) {
    await this.channel.send(targetId, { text });
  }
  async sendCard(targetId: string, card: object) {
    await this.channel.send(targetId, { card });
  }
  onCardAction(handler: CardActionHandler) {
    this.channel.on("cardAction", (event: CardActionEvent) => handler({
      messageId: event.messageId,
      chatId: event.chatId,
      operatorOpenId: event.operator.openId,
      value: event.action.value
    }));
  }
  onMessage(handler: TextMessageHandler) {
    this.channel.on("message", (event: NormalizedMessage) => handler({
      messageId: event.messageId,
      chatId: event.chatId,
      operatorOpenId: event.senderId,
      text: event.content,
      messageType: event.rawContentType
    }));
  }
  onError(handler: (error: Error) => void) { this.channel.on("error", handler); }
  onReconnecting(handler: () => void) { this.channel.on("reconnecting", handler); }
  onReconnected(handler: () => void) { this.channel.on("reconnected", handler); }
}

function actionResultCard(result: FeishuCardActionResult) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: result.type === "success" ? "green" : "red",
      title: { tag: "plain_text", content: result.type === "success" ? "操作已处理" : "操作未完成" }
    },
    elements: [{ tag: "div", text: { tag: "lark_md", content: result.message } }]
  };
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Feishu WebSocket timing values must be positive integers");
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
