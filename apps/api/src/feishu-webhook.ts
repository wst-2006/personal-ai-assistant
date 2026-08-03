import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import {
  FeishuActionAuthError,
  FeishuActionPayloadError,
  type FeishuCardActionService
} from "./feishu-card-actions.js";

export type FeishuWebhookConfig = { verificationToken: string; encryptKey: string };

export class FeishuWebhookAuthError extends Error {}
export class FeishuWebhookPayloadError extends Error {}

export class FeishuWebhookService {
  constructor(
    private readonly config: FeishuWebhookConfig,
    private readonly actions: FeishuCardActionService
  ) {}

  async handle(rawBody: string, headers: Record<string, string | string[] | undefined>, parsedBody: unknown): Promise<unknown> {
    const body = this.decodeAndVerify(rawBody, headers, parsedBody);
    if (body.type === "url_verification" && typeof body.challenge === "string") return { challenge: body.challenge };
    const event = object(body.event);
    const operator = object(event.operator);
    const openId = stringValue(operator.open_id) ?? stringValue(body.open_id);
    const actionContainer = object(event.action ?? body.action);
    try {
      const result = await this.actions.handle(openId, actionContainer.value);
      return toast(result.type, result.message);
    } catch (error) {
      if (error instanceof FeishuActionAuthError) throw new FeishuWebhookAuthError(error.message);
      if (error instanceof FeishuActionPayloadError) throw new FeishuWebhookPayloadError(error.message);
      throw error;
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
  const transport = env.FEISHU_CALLBACK_TRANSPORT?.trim().toLowerCase() || "websocket";
  if (transport !== "http") return null;
  const verificationToken = env.FEISHU_VERIFICATION_TOKEN?.trim();
  const encryptKey = env.FEISHU_ENCRYPT_KEY?.trim();
  if (!verificationToken || !encryptKey) return null;
  return { verificationToken, encryptKey };
}

function decryptFeishuPayload(encrypted: string, encryptKey: string): Record<string, unknown> {
  try {
    const payload = Buffer.from(encrypted, "base64");
    if (payload.length <= 16) throw new Error("encrypted payload is too short");
    const key = createHash("sha256").update(encryptKey).digest();
    // Feishu prefixes the AES-CBC ciphertext with the random 16-byte IV.
    const iv = payload.subarray(0, 16);
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    const plain = Buffer.concat([decipher.update(payload.subarray(16)), decipher.final()]).toString("utf8");
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
