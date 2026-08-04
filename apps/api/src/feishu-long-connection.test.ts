import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeishuCardActionService } from "./feishu-card-actions.js";
import {
  FeishuLongConnectionService,
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
  recallMessage = vi.fn<(messageId: string) => Promise<void>>().mockResolvedValue(undefined);
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

  it("connects, handles card actions, updates the card, and disconnects on shutdown", async () => {
    const channel = new FakeChannel();
    const actions = { handle: vi.fn().mockResolvedValue({ type: "success", message: "done" }) };
    const service = new FeishuLongConnectionService(config, actions as unknown as FeishuCardActionService, () => channel, silentLogger);

    await service.start();
    expect(channel.connect).toHaveBeenCalledOnce();
    await channel.cardHandler?.({ messageId: "om_1", chatId: "oc_1", operatorOpenId: "ou_owner", value: { action: "start" } });
    expect(actions.handle).toHaveBeenCalledWith("ou_owner", { action: "start" });
    expect(channel.recallMessage).toHaveBeenCalledWith("om_1");
    expect(channel.updateCard).not.toHaveBeenCalled();
    expect(channel.sendText).toHaveBeenCalledWith("oc_1", "done");

    await service.stop();
    expect(channel.forceDisconnect).toHaveBeenCalledOnce();
  });

  it("sends a visible text fallback when Feishu rejects the card update", async () => {
    const channel = new FakeChannel();
    channel.recallMessage.mockRejectedValueOnce(new Error("permission denied"));
    const actions = { handle: vi.fn().mockResolvedValue({ type: "success", message: "已记录另有安排" }) };
    const service = new FeishuLongConnectionService(config, actions as unknown as FeishuCardActionService, () => channel, silentLogger);

    await service.start();
    await channel.cardHandler?.({ messageId: "om_2", chatId: "oc_2", operatorOpenId: "ou_owner", value: { action: "other_arrangement" } });

    expect(channel.updateCard).toHaveBeenCalledWith("om_2", expect.objectContaining({ header: expect.any(Object) }));
    expect(channel.sendText).toHaveBeenCalledWith("oc_2", "已记录另有安排");
    await service.stop();
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
