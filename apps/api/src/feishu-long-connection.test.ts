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
  cardHandler?: (event: { messageId: string; operatorOpenId: string; value: unknown }) => Promise<void>;
  onCardAction(handler: NonNullable<FakeChannel["cardHandler"]>) { this.cardHandler = handler; }
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
    await channel.cardHandler?.({ messageId: "om_1", operatorOpenId: "ou_owner", value: { action: "start" } });
    expect(actions.handle).toHaveBeenCalledWith("ou_owner", { action: "start" });
    expect(channel.updateCard).toHaveBeenCalledWith("om_1", expect.objectContaining({ header: expect.any(Object) }));

    await service.stop();
    expect(channel.forceDisconnect).toHaveBeenCalledOnce();
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
