import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FocusService } from "./focus-service.js";
import { FeishuCardActionService } from "./feishu-card-actions.js";
import { FeishuWebhookAuthError, FeishuWebhookService } from "./feishu-webhook.js";
import type { TaskService } from "./task-service.js";

const taskId = "7f9a4ad8-4dc7-4d18-92df-1d8be780a1b1";
const config = { verificationToken: "verify-token", encryptKey: "encrypt-key" };
const targetOpenId = "ou_owner";

function services() {
  const task = {
    id: taskId,
    title: "整理产品原型",
    version: 8,
    scheduleRevision: 3,
    lifecycleStatus: "open",
    localDate: null,
    startAt: new Date("2099-08-15T07:00:00.000Z"),
    endAt: new Date("2099-08-15T08:00:00.000Z")
  };
  const taskService = {
    get: vi.fn().mockResolvedValue({ task }),
    update: vi.fn().mockResolvedValue({ task: { ...task, scheduleKind: "none" }, historicalOverlaps: [] })
  };
  const focusService = {
    currentForTask: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: "focus-1", taskId, state: "armed", version: 2 }),
    otherArrangement: vi.fn().mockResolvedValue({ id: "focus-1", version: 2, state: "stopped_no_response" })
  };
  return {
    taskService,
    focusService,
    webhook: new FeishuWebhookService(config, new FeishuCardActionService(
      { targetOpenId },
      taskService as unknown as TaskService,
      focusService as unknown as FocusService
    ))
  };
}

describe("Feishu webhook", () => {
  it("answers a verified URL challenge", async () => {
    const { webhook } = services();
    const body = { type: "url_verification", token: config.verificationToken, challenge: "challenge-code" };
    await expect(webhook.handle(JSON.stringify(body), {}, body)).resolves.toEqual({ challenge: "challenge-code" });
  });

  it("confirms start only for the configured single user and replaces the card", async () => {
    const { webhook, focusService, taskService } = services();
    const body = {
      token: config.verificationToken,
      event: { operator: { open_id: targetOpenId }, action: { value: { action: "start", taskId, scheduleRevision: 3 } } }
    };
    const response = await webhook.handle(JSON.stringify(body), {}, body);
    expect(response).toMatchObject({
      toast: { type: "success", content: expect.stringContaining("任务已经开始") },
      card: expect.any(Object)
    });
    expect(JSON.stringify((response as { card: object }).card)).not.toContain("取消任务");
    expect(focusService.create).toHaveBeenCalledWith(taskId, 8, "prepare", undefined);

    const foreign = { ...body, event: { ...body.event, operator: { open_id: "ou_other" } } };
    await expect(webhook.handle(JSON.stringify(foreign), {}, foreign)).rejects.toBeInstanceOf(FeishuWebhookAuthError);
  });

  it("verifies the signature and decrypts encrypted callbacks", async () => {
    const { webhook, focusService, taskService } = services();
    const decrypted = {
      token: config.verificationToken,
      event: { operator: { open_id: targetOpenId }, action: { value: { action: "other_arrangement", taskId, scheduleRevision: 3 } } }
    };
    const encrypted = encrypt(JSON.stringify(decrypted), config.encryptKey);
    const envelope = { encrypt: encrypted };
    const rawBody = JSON.stringify(envelope);
    const timestamp = "1785330000";
    const nonce = "nonce";
    const signature = createHash("sha256").update(timestamp + nonce + config.encryptKey + rawBody).digest("hex");

    const response = await webhook.handle(rawBody, {
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": signature
    }, envelope);

    expect(response).toMatchObject({
      toast: { type: "success", content: expect.stringContaining("未排期") },
      card: expect.any(Object)
    });
    expect(focusService.otherArrangement).not.toHaveBeenCalled();
    expect(taskService.update).toHaveBeenCalledWith(taskId, expect.objectContaining({ scheduleKind: "none" }));
  });

  it("answers an encrypted URL challenge", async () => {
    const { webhook } = services();
    const decrypted = { type: "url_verification", token: config.verificationToken, challenge: "encrypted-challenge" };
    const encrypted = encrypt(JSON.stringify(decrypted), config.encryptKey);
    const envelope = { encrypt: encrypted };
    const rawBody = JSON.stringify(envelope);
    const timestamp = "1785330001";
    const nonce = "challenge-nonce";
    const signature = createHash("sha256").update(timestamp + nonce + config.encryptKey + rawBody).digest("hex");

    await expect(webhook.handle(rawBody, {
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": signature
    }, envelope)).resolves.toEqual({ challenge: "encrypted-challenge" });
  });
});

function encrypt(plain: string, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(plain), cipher.final()]).toString("base64");
}
