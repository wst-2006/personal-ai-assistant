import {
  naturalLanguageTaskCandidateSchema,
  type NaturalLanguageTaskCandidate
} from "@personal-ai/domain/task";
import type { DeepSeekConfig } from "./config.js";
import { personalContextInstruction, type UserAiContextProvider } from "./user-context.js";

export type ParseTaskRequest = {
  text: string;
  referenceDate: string;
  timeZone: string;
};

export interface TaskParser {
  parse(request: ParseTaskRequest): Promise<NaturalLanguageTaskCandidate>;
}

type ChatCompletionResponse = {
  choices?: Array<{
    message?: { content?: string };
  }>;
};

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

export class DeepSeekTaskParser implements TaskParser {
  constructor(private readonly config: DeepSeekConfig, private readonly userContext?: UserAiContextProvider) {}

  async parse(request: ParseTaskRequest): Promise<NaturalLanguageTaskCandidate> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.DEEPSEEK_MAX_RETRIES; attempt += 1) {
      try {
        return await this.requestCandidate(request);
      } catch (error) {
        lastError = error;
        if (attempt === this.config.DEEPSEEK_MAX_RETRIES) break;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }

    throw lastError instanceof Error ? lastError : new Error("DeepSeek task parsing failed.");
  }

  private async requestCandidate(request: ParseTaskRequest): Promise<NaturalLanguageTaskCandidate> {
    const context = await personalContextInstruction(this.userContext, this.config.DEEPSEEK_USER_CONTEXT_MAX_CHARS);
    const response = await fetch(endpoint(this.config.DEEPSEEK_BASE_URL), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.DEEPSEEK_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.DEEPSEEK_MODEL,
        temperature: 0,
        max_tokens: this.config.DEEPSEEK_MAX_OUTPUT_TOKENS,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "你是个人任务系统的结构化录入器。只整理用户明确表达的信息，不补造事实。",
              "无法确定的字段必须返回 null，并把字段名加入 missingFields。",
              "日期使用 YYYY-MM-DD；具体时间使用带时区偏移的 ISO 8601。",
              "entryType 只能是 task、idea、question。schedulePrecision 只能是 exact、morning、afternoon、evening 或 null。",
              "task 的 exact 起止时间必须落在 Asia/Shanghai 本地时间的 :00 或 :30，且至少相隔 30 分钟；时间块长度只由起止时间决定。",
              "idea 或 question 的日期、排期和时间字段必须全部为 null，只有标题和备注可以保留。",
              "只返回一个 JSON 对象，不要 Markdown 或解释。",
              context
            ].join("\n")
          },
          {
            role: "user",
            content: JSON.stringify({
              referenceDate: request.referenceDate,
              timeZone: request.timeZone,
              input: request.text,
              requiredKeys: [
                "title",
                "entryType",
                "date",
                "startAt",
                "endAt",
                "schedulePrecision",
                "notes",
                "missingFields"
              ]
            })
          }
        ]
      }),
      signal: AbortSignal.timeout(this.config.DEEPSEEK_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error(`DeepSeek returned HTTP ${response.status}.`);
    }

    const result = await response.json() as ChatCompletionResponse;
    const content = result.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek returned no structured task content.");

    return naturalLanguageTaskCandidateSchema.parse(JSON.parse(content));
  }
}
