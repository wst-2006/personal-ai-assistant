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
  const taskService = { get: vi.fn().mockResolvedValue({ task: { id: taskId, version: 8, scheduleRevision: 3 } }) };
  const focusService = {
    create: vi.fn().mockResolvedValue({ id: "focus-1", version: 1 }),
    respondToReminder: vi.fn().mockResolvedValue({ id: "focus-1", version: 2 })
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

  it("starts one-minute preparation only for the configured single user", async () => {
    const { webhook, focusService } = services();
    const body = {
      token: config.verificationToken,
      event: { operator: { open_id: targetOpenId }, action: { value: { action: "start", taskId, scheduleRevision: 3 } } }
    };
    const response = await webhook.handle(JSON.stringify(body), {}, body);
    expect(response).toEqual({ toast: { type: "success", content: expect.stringContaining("1 分钟准备") } });
    expect(focusService.create).toHaveBeenCalledWith(taskId, 8, "prepare");

    const foreign = { ...body, event: { ...body.event, operator: { open_id: "ou_other" } } };
    await expect(webhook.handle(JSON.stringify(foreign), {}, foreign)).rejects.toBeInstanceOf(FeishuWebhookAuthError);
  });

  it("verifies the signature and decrypts encrypted callbacks", async () => {
    const { webhook, focusService } = services();
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

    expect(response).toEqual({ toast: { type: "success", content: expect.stringContaining("另有安排") } });
    expect(focusService.respondToReminder).toHaveBeenCalledWith("focus-1", 1, "other_arrangement");
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
