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

const candidateEntryTypes = new Set(["task", "idea", "question"]);
const candidateSchedulePrecisions = new Set(["exact", "morning", "afternoon", "evening"]);
const optionalCandidateFields = new Set(["date", "startAt", "endAt", "schedulePrecision", "notes"]);

class DeepSeekProviderError extends Error {
  constructor(readonly status: number, readonly detail: string | null) {
    super(`DeepSeek returned HTTP ${status}${detail ? `: ${detail}` : "."}`);
  }
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof DeepSeekProviderError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError");
}

async function providerErrorDetail(response: Response): Promise<string | null> {
  try {
    const payload = await response.json() as unknown;
    if (typeof payload !== "object" || payload === null) return null;
    const record = payload as Record<string, unknown>;
    const error = typeof record.error === "object" && record.error !== null
      ? record.error as Record<string, unknown>
      : record;
    const message = error.message;
    if (typeof message !== "string") return null;
    return message.replace(/\s+/g, " ").trim().slice(0, 500) || null;
  } catch {
    return null;
  }
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
        if (attempt === this.config.DEEPSEEK_MAX_RETRIES || !isRetryable(error)) break;
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
              "你是个人任务系统的结构化录入器。把用户自然语言中表达的语义整理成候选；从原文提取和概括不是编造。",
              "如果输入以‘计划：’、‘计划:’或‘计划 ’开头，表示用户在描述或调整已有计划，不是新建任务。不要把这类内容伪装成一个新任务；应在 notes 中明确写出‘这是计划调整请求，需要回到计划调整流程确认’，并把 missingFields 视为缺少任务排期上下文。",
              "title 和 entryType 是必填字段，绝对不能返回 null。title 应从原文提炼为简洁标题；以‘想法：’开头时 entryType=idea，以‘问题：’开头时 entryType=question，其余明确安排或待办为 task。",
              "只有 date、startAt、endAt、schedulePrecision、notes 这些可选字段在原文无法确定时才返回 null。missingFields 只能列这些可选字段，不得包含 title 或 entryType。",
              "日期使用 YYYY-MM-DD；相对日期根据 referenceDate 推导。具体时间使用带时区偏移的 ISO 8601。",
              "schedulePrecision 只能是 exact、morning、afternoon、evening 或 null。",
              "task 的 exact 起止时间必须落在 Asia/Shanghai 本地时间的 :00 或 :30，且至少相隔 30 分钟；时间块长度只由起止时间决定。若用户明确给出开始时间但没有给时长或结束时间，保留 startAt，令 endAt=null，并把 endAt 放入 missingFields，等待系统追问时长。",
              "若输入同时包含‘原始安排’和‘用户补充时长’，必须保留原始任务标题与开始时间，用补充时长计算 endAt，并从 missingFields 移除 endAt。",
              "idea 或 question 的 date、startAt、endAt、schedulePrecision 必须全部为 null；这些不适用字段不要放入 missingFields。",
              "只返回一个包含 title、entryType、date、startAt、endAt、schedulePrecision、notes、missingFields 的 JSON 对象，不要 Markdown 或解释。",
              context
            ].join("\n")
          },
          {
            role: "user",
            content: JSON.stringify({
              referenceDate: request.referenceDate,
              timeZone: request.timeZone,
              input: request.text
            })
          }
        ]
      }),
      signal: AbortSignal.timeout(this.config.DEEPSEEK_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new DeepSeekProviderError(response.status, await providerErrorDetail(response));
    }

    const result = await response.json() as ChatCompletionResponse;
    const content = result.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek returned no structured task content.");

    return naturalLanguageTaskCandidateSchema.parse(normalizeCandidate(JSON.parse(content), request.text));
  }
}

function normalizeCandidate(value: unknown, sourceText: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  const inferredEntryType = inferEntryType(sourceText);
  const entryType = typeof raw.entryType === "string" && candidateEntryTypes.has(raw.entryType)
    ? raw.entryType
    : inferredEntryType;
  const rawTitle = typeof raw.title === "string" ? raw.title.trim() : "";
  const title = (rawTitle || inferTitle(sourceText)).slice(0, 200);
  const missingFields = Array.isArray(raw.missingFields)
    ? raw.missingFields.filter((field): field is string => typeof field === "string" && optionalCandidateFields.has(field))
    : [];
  const normalized = {
    title,
    entryType,
    date: typeof raw.date === "string" ? raw.date : null,
    startAt: typeof raw.startAt === "string" ? raw.startAt : null,
    endAt: typeof raw.endAt === "string" ? raw.endAt : null,
    schedulePrecision: typeof raw.schedulePrecision === "string" && candidateSchedulePrecisions.has(raw.schedulePrecision)
      ? raw.schedulePrecision
      : null,
    notes: typeof raw.notes === "string" ? raw.notes : null,
    missingFields
  };

  return entryType === "task"
    ? normalized
    : { ...normalized, date: null, startAt: null, endAt: null, schedulePrecision: null };
}

function inferEntryType(sourceText: string): "task" | "idea" | "question" {
  const prefix = sourceText.trim().match(/^(想法|问题|任务)\s*[：:]/u)?.[1];
  return prefix === "想法" ? "idea" : prefix === "问题" ? "question" : "task";
}

function inferTitle(sourceText: string): string {
  const trimmed = sourceText.trim();
  const withoutPrefix = trimmed.replace(/^(?:想法|问题|任务)\s*[：:]\s*/u, "").trim();
  return withoutPrefix || trimmed;
}
