import type { DeepSeekConfig } from "./config.js";
import { personalContextInstruction, type UserAiContextProvider } from "./user-context.js";
import type { ConversationPromptMessage, ConversationResponder } from "../conversation-service.js";

type ChatCompletionResponse = { choices?: Array<{ message?: { content?: string } }> };

class ConversationProviderError extends Error {
  constructor(readonly status: number) {
    super(`DeepSeek returned HTTP ${status}.`);
  }
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ConversationProviderError) return error.status === 408 || error.status === 429 || error.status >= 500;
  return error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError");
}

function boundedHistory(messages: ConversationPromptMessage[]): ConversationPromptMessage[] {
  const selected: ConversationPromptMessage[] = [];
  let remaining = 12_000;
  for (const message of [...messages].reverse()) {
    if (remaining <= 0) break;
    const content = message.content.length > remaining ? message.content.slice(-remaining) : message.content;
    selected.push({ role: message.role, content });
    remaining -= content.length;
  }
  return selected.reverse();
}

export class DeepSeekConversationResponder implements ConversationResponder {
  constructor(private readonly config: DeepSeekConfig, private readonly userContext?: UserAiContextProvider) {}

  async reply(input: Parameters<ConversationResponder["reply"]>[0]): Promise<string> {
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
    throw lastError instanceof Error ? lastError : new Error("DeepSeek conversation reply failed.");
  }

  private async requestReply(input: Parameters<ConversationResponder["reply"]>[0]) {
    const context = await personalContextInstruction(this.userContext, this.config.DEEPSEEK_USER_CONTEXT_MAX_CHARS);
    const response = await fetch(endpoint(this.config.DEEPSEEK_BASE_URL), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.DEEPSEEK_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.DEEPSEEK_MODEL,
        temperature: 0.4,
        max_tokens: this.config.DEEPSEEK_MAX_OUTPUT_TOKENS,
        messages: [
          {
            role: "system",
            content: [
              "你是用户主动唤起的个人管理与学习陪伴助手。只回应当前软件内对话，简洁、具体、不说教。",
              "你没有创建、修改、移动、取消或关闭任务的权限；涉及计划时，只提出选择、风险或下一步，最终由用户回到软件中的明确操作决定。",
              "不得推断人格、精神状态、行为或外部平台内容；不要声称已经执行了任何软件操作。",
              `当前日期：${input.localDate}。完整历史已保存，但本次只提供最近相关片段。`,
              context
            ].filter(Boolean).join("\n")
          },
          ...boundedHistory(input.messages)
        ]
      }),
      signal: AbortSignal.timeout(this.config.DEEPSEEK_TIMEOUT_MS)
    });
    if (!response.ok) throw new ConversationProviderError(response.status);
    const content = (await response.json() as ChatCompletionResponse).choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("DeepSeek returned no conversation reply.");
    return content.slice(0, 4_000);
  }
}
