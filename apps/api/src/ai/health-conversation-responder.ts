import { z } from "zod";
import type { DeepSeekConfig } from "./config.js";
import { personalContextInstruction, type UserAiContextProvider } from "./user-context.js";
import type { HealthConversationResponder } from "../health-conversation-service.js";

type ChatCompletionResponse = { choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }> };

const replySchema = z.object({
  reply: z.string().trim().min(1).max(4_000),
  needsClarification: z.boolean()
}).strict();

class HealthConversationProviderError extends Error {
  constructor(readonly status: number) {
    super(`DeepSeek returned HTTP ${status}.`);
  }
}

class HealthConversationOutputError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function isRetryable(error: unknown) {
  if (error instanceof HealthConversationProviderError) return error.status === 408 || error.status === 429 || error.status >= 500;
  if (error instanceof HealthConversationOutputError) return true;
  return error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError");
}

function providerText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const text = value.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      return "";
    }).join("").trim();
    return text || null;
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return null;
}

function providerTexts(message: { content?: unknown; reasoning_content?: unknown } | undefined) {
  return Array.from(new Set([
    providerText(message?.content),
    providerText(message?.reasoning_content)
  ].filter((value): value is string => Boolean(value))));
}

function parseReply(text: string) {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return replySchema.parse(JSON.parse(candidate));
  } catch {
    const start = candidate.indexOf("{");
    if (start < 0) throw new Error("health_reply_json_missing");
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < candidate.length; index += 1) {
      const character = candidate[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') { quoted = true; continue; }
      if (character === "{") depth += 1;
      if (character === "}") {
        depth -= 1;
        if (depth === 0) return replySchema.parse(JSON.parse(candidate.slice(start, index + 1)));
      }
    }
    throw new Error("health_reply_json_incomplete");
  }
}

function boundedHistory(messages: Parameters<HealthConversationResponder["reply"]>[0]["messages"]) {
  const selected: typeof messages = [];
  let remaining = 12_000;
  for (const message of [...messages].reverse()) {
    if (remaining <= 0) break;
    const content = message.content.length > remaining ? message.content.slice(-remaining) : message.content;
    selected.push({ role: message.role, content });
    remaining -= content.length;
  }
  return selected.reverse();
}

export class DeepSeekHealthConversationResponder implements HealthConversationResponder {
  constructor(private readonly config: DeepSeekConfig, private readonly userContext?: UserAiContextProvider) {}

  async reply(input: Parameters<HealthConversationResponder["reply"]>[0]) {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.DEEPSEEK_MAX_RETRIES; attempt += 1) {
      try {
        return await this.requestReply(input);
      } catch (error) {
        lastError = error;
        if (attempt === this.config.DEEPSEEK_MAX_RETRIES || !isRetryable(error)) break;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("DeepSeek health collaboration reply failed.");
  }

  private async requestReply(input: Parameters<HealthConversationResponder["reply"]>[0]) {
    const context = await personalContextInstruction(this.userContext, this.config.DEEPSEEK_USER_CONTEXT_MAX_CHARS);
    const response = await fetch(`${this.config.DEEPSEEK_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.DEEPSEEK_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.config.DEEPSEEK_MODEL,
        temperature: 0.3,
        thinking: { type: "disabled" },
        max_tokens: Math.min(1_500, this.config.DEEPSEEK_MAX_OUTPUT_TOKENS),
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "你是软件健康页内的本周参考协商助手。你只帮助用户澄清本周饮食、饮水、睡眠与运动偏好，不在本轮直接生成七日候选。",
              "回复 JSON：{reply:string,needsClarification:boolean}。信息足够时，简短复述理解并说明可点击‘根据本页交流生成候选’，needsClarification=false。",
              "只有缺少会显著改变安排的信息时才问问题；一次最多问 1–3 个具体问题，needsClarification=true。不要反复询问已有内容。",
              "不得诊断、开药、解释中药药性或推断药物相互作用。用户提到正在服药时，只能提醒遵循开方者意见；补水建议必须保守，并考虑是否存在医生要求的液体限制。",
              "不要创建任务、修改计划、声称已生成候选或声称已发送飞书。候选只有用户另行点击生成并确认后才会进入健康栏目。",
              `当前健康周开始于 ${input.weekStart}。`,
              `用户主动保存的健康资料：${JSON.stringify(input.profile)}`,
              input.activePlan ? `当前生效参考摘要：${JSON.stringify(input.activePlan)}` : "当前没有生效的本周健康参考。",
              context
            ].filter(Boolean).join("\n")
          },
          ...boundedHistory(input.messages)
        ]
      }),
      signal: AbortSignal.timeout(Math.max(60_000, this.config.DEEPSEEK_TIMEOUT_MS))
    });
    if (!response.ok) throw new HealthConversationProviderError(response.status);
    const message = (await response.json() as ChatCompletionResponse).choices?.[0]?.message;
    const texts = providerTexts(message);
    if (!texts.length) throw new HealthConversationOutputError("DeepSeek returned no health collaboration reply.");
    let lastParseError: unknown;
    for (const text of texts) {
      try {
        const parsed = parseReply(text);
        return { content: parsed.reply, needsClarification: parsed.needsClarification };
      } catch (error) {
        lastParseError = error;
      }
    }
    throw new HealthConversationOutputError(lastParseError instanceof Error ? lastParseError.message : "DeepSeek returned malformed health collaboration reply.");
  }
}
