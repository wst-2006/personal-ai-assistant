import { afterEach, describe, expect, it, vi } from "vitest";
import type { CardActionEvent, LarkChannel } from "@larksuiteoapi/node-sdk";
import type { FeishuCardActionService } from "./feishu-card-actions.js";
import {
  FeishuLongConnectionService,
  SdkFeishuChannel,
  loadFeishuLongConnectionConfig,
  type FeishuChannelClient,
  type FeishuConnectionLogger
} from "./feishu-long-connection.js";

const config = { appId: "cli_app", appSecret: "secret", handshakeTimeoutMs: 200, retryBaseMs: 10, retryMaxMs: 40 };

class FakeChannel implements FeishuChannelClient {
  connect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  disconnect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  forceDisconnect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  updateCard = vi.fn<(messageId: string, card: object) => Promise<void>>().mockResolvedValue(undefined);
  sendText = vi.fn<(targetId: string, text: string) => Promise<void>>().mockResolvedValue(undefined);
  sendCard = vi.fn<(targetId: string, card: object) => Promise<void>>().mockResolvedValue(undefined);
  cardHandler?: (event: { messageId: string; chatId: string; operatorOpenId: string; value: unknown }) => Promise<void>;
  messageHandler?: (event: { messageId: string; chatId: string; operatorOpenId: string; text: string; messageType: string }) => Promise<void>;
  onCardAction(handler: NonNullable<FakeChannel["cardHandler"]>) { this.cardHandler = handler; }
  onMessage(handler: NonNullable<FakeChannel["messageHandler"]>) { this.messageHandler = handler; }
  onError() {}
  onReconnecting() {}
  onReconnected() {}
}

const silentLogger: FeishuConnectionLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => vi.useRealTimers());

describe("Feishu long connection", () => {
  it("uses WebSocket by default and keeps HTTP callback as an explicit fallback", () => {
    expect(loadFeishuLongConnectionConfig({
      FEISHU_APP_ID: " cli_app ", FEISHU_APP_SECRET: " secret ", FEISHU_TARGET_OPEN_ID: " ou_owner "
    })).toMatchObject({ appId: "cli_app", appSecret: "secret", handshakeTimeoutMs: 15_000 });
    expect(loadFeishuLongConnectionConfig({
      FEISHU_CALLBACK_TRANSPORT: "http", FEISHU_APP_ID: "cli_app", FEISHU_APP_SECRET: "secret", FEISHU_TARGET_OPEN_ID: "ou_owner"
    })).toBeNull();
  });

  it("connects, handles card actions, replaces the acted card, and disconnects on shutdown", async () => {
    const channel = new FakeChannel();
    const actions = { handle: vi.fn().mockResolvedValue({ type: "success", message: "done" }) };
    const service = new FeishuLongConnectionService(config, actions as unknown as FeishuCardActionService, () => channel, silentLogger);

    await service.start();
    expect(channel.connect).toHaveBeenCalledOnce();
    await channel.cardHandler?.({ messageId: "om_1", chatId: "oc_1", operatorOpenId: "ou_owner", value: { action: "start" } });
    expect(actions.handle).toHaveBeenCalledWith("ou_owner", { action: "start" });
    expect(channel.updateCard).toHaveBeenCalledWith("om_1", expect.objectContaining({ header: expect.any(Object) }));
    expect(JSON.stringify(channel.updateCard.mock.calls[0]?.[1])).toContain("done");
    expect(JSON.stringify(channel.updateCard.mock.calls[0]?.[1])).not.toContain('"tag":"action"');
    expect(channel.sendText).not.toHaveBeenCalled();

    await service.stop();
    expect(channel.forceDisconnect).toHaveBeenCalledOnce();
  });

  it("sends a visible text fallback when Feishu rejects the card update", async () => {
    const channel = new FakeChannel();
    channel.updateCard.mockRejectedValueOnce(new Error("permission denied"));
    const actions = { handle: vi.fn().mockResolvedValue({ type: "success", message: "已记录另有安排" }) };
    const service = new FeishuLongConnectionService(config, actions as unknown as FeishuCardActionService, () => channel, silentLogger);

    await service.start();
    await channel.cardHandler?.({ messageId: "om_2", chatId: "oc_2", operatorOpenId: "ou_owner", value: { action: "other_arrangement" } });

    expect(channel.updateCard).toHaveBeenCalledWith("om_2", expect.objectContaining({ header: expect.any(Object) }));
    expect(channel.sendText).toHaveBeenCalledWith("oc_2", "已记录另有安排");
    await service.stop();
  });

  it("acknowledges the SDK card event before asynchronous business processing finishes", async () => {
    let sdkHandler: ((event: CardActionEvent) => void | Promise<void>) | undefined;
    const rawChannel = {
      on: vi.fn((name: string, handler: (event: CardActionEvent) => void | Promise<void>) => {
        if (name === "cardAction") sdkHandler = handler;
      })
    } as unknown as LarkChannel;
    const channel = new SdkFeishuChannel(rawChannel);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let completed = false;
    channel.onCardAction(async () => {
      await pending;
      completed = true;
    });

    expect(sdkHandler).toBeTypeOf("function");
    const returned = sdkHandler!({
      messageId: "om_ack",
      chatId: "oc_ack",
      operator: { openId: "ou_owner" },
      action: { tag: "button", value: { action: "intake_confirm" } }
    });

    expect(returned).toBeUndefined();
    expect(completed).toBe(false);
    release();
    await vi.waitFor(() => expect(completed).toBe(true));
  });

  it("routes an owner text message to the intake service and sends its confirmation card", async () => {
    const channel = new FakeChannel();
    const actions = { handle: vi.fn() };
    const intake = { receive: vi.fn().mockResolvedValue({ kind: "card", card: { header: { title: "确认" } } }) };
    const service = new FeishuLongConnectionService(
      config,
      actions as unknown as FeishuCardActionService,
      () => channel,
      silentLogger,
      intake as never
    );

    await service.start();
    await channel.messageHandler?.({ messageId: "om_text", chatId: "oc_1", operatorOpenId: "ou_owner", text: "明天九点学习", messageType: "text" });

    expect(intake.receive).toHaveBeenCalledWith(expect.objectContaining({ messageId: "om_text", text: "明天九点学习" }));
    expect(channel.sendCard).toHaveBeenCalledWith("oc_1", expect.objectContaining({ header: expect.any(Object) }));
    await service.stop();
  });

  it("retries a failed initial handshake and stops retrying after shutdown", async () => {
    vi.useFakeTimers();
    const failed = new FakeChannel();
    failed.connect.mockRejectedValueOnce(new Error("offline"));
    const recovered = new FakeChannel();
    const factory = vi.fn().mockReturnValueOnce(failed).mockReturnValueOnce(recovered);
    const actions = { handle: vi.fn() };
    const service = new FeishuLongConnectionService(config, actions as unknown as FeishuCardActionService, factory, silentLogger);

    await service.start();
    expect(failed.forceDisconnect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10);
    expect(recovered.connect).toHaveBeenCalledOnce();

    await service.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
