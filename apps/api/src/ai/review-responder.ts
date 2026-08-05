import type { DeepSeekConfig } from "./config.js";
import { personalContextInstruction, type UserAiContextProvider } from "./user-context.js";
import type { ReviewPromptMessage, ReviewResponder, ReviewResponderInput } from "../review-service.js";

type ChatCompletionResponse = { choices?: Array<{ message?: { content?: string } }> };

class ReviewProviderError extends Error {
  constructor(readonly status: number) {
    super(`DeepSeek returned HTTP ${status}.`);
  }
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ReviewProviderError) return error.status === 408 || error.status === 429 || error.status >= 500;
  return error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError");
}

function boundedHistory(messages: ReviewPromptMessage[]): ReviewPromptMessage[] {
  const selected: ReviewPromptMessage[] = [];
  let remaining = 10_000;
  for (const message of [...messages].reverse()) {
    if (remaining <= 0) break;
    const content = message.content.length > remaining ? message.content.slice(-remaining) : message.content;
    selected.push({ role: message.role, content });
    remaining -= content.length;
  }
  return selected.reverse();
}

function boundedContext(input: ReviewResponderInput): string {
  return JSON.stringify(input.context, null, 2).slice(0, 14_000);
}

export class DeepSeekReviewResponder implements ReviewResponder {
  constructor(private readonly config: DeepSeekConfig, private readonly userContext?: UserAiContextProvider) {}

  async reply(input: ReviewResponderInput): Promise<string> {
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
    throw lastError instanceof Error ? lastError : new Error("DeepSeek review reply failed.");
  }

  private async requestReply(input: ReviewResponderInput): Promise<string> {
    const personalContext = await personalContextInstruction(this.userContext, this.config.DEEPSEEK_USER_CONTEXT_MAX_CHARS);
    const response = await fetch(endpoint(this.config.DEEPSEEK_BASE_URL), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.DEEPSEEK_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.DEEPSEEK_MODEL,
        temperature: 0.35,
        max_tokens: this.config.DEEPSEEK_MAX_OUTPUT_TOKENS,
        messages: [
          {
            role: "system",
            content: [
              "你现在处于软件明确标记的 daily_review 模式，不是普通对话，也不是自动评估。",
              "根据用户主动写下的复盘、当天任务、客观结果、专注记录、主观反馈和软件内相关对话，做简短、具体、可继续交谈的回应。",
              "区分用户复盘正文、任务过程反馈、软件内对话和你的回复；不得把它们混成用户说过的话。",
              "不得推断人格、精神状态、情绪原因或软件外行为；不得评价用户价值，也不要根据任务数量判断表现。",
              "你没有创建、修改、移动、取消或关闭任务的权限。可以提出问题、选择和建议，但计划调整最终由用户决定。",
              "这次只回复复盘对话，不生成每日简报或赛博日记，也不要声称已经保存、修改或执行了其他操作。",
              `复盘日期：${input.localDate}。结构化当日上下文如下：\n${boundedContext(input)}`,
              personalContext,
            ].filter(Boolean).join("\n"),
          },
          ...boundedHistory(input.messages),
        ],
      }),
      signal: AbortSignal.timeout(this.config.DEEPSEEK_TIMEOUT_MS),
    });
    if (!response.ok) throw new ReviewProviderError(response.status);
    const content = (await response.json() as ChatCompletionResponse).choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("DeepSeek returned no review reply.");
    return content.slice(0, 2_000);
  }
}
