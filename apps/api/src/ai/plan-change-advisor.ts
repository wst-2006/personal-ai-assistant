import { z } from "zod";
import type { DeepSeekConfig } from "./config.js";

export type PlanChangeTaskContext = {
  id: string;
  title: string;
  lifecycleStatus: "open" | "active" | "awaiting_outcome" | "closed" | "cancelled";
  scheduleKind: "none" | "daypart" | "exact";
  localDate: string | null;
  daypart: "morning" | "afternoon" | "evening" | null;
  startAt: string | null;
  endAt: string | null;
  timeZone: string;
  notes: string | null;
  version: number;
  scheduleRevision: number;
};

export type PlanChangeAdvice = {
  summary: string;
  feasibility: "feasible" | "risky" | "needs_clarification";
  affectedTaskIds: string[];
  options: Array<{ title: string; detail: string }>;
  warnings: string[];
};

export type PlanChangeAdviceRequest = {
  message: string;
  referenceDate: string;
  task: PlanChangeTaskContext;
  dayTasks: PlanChangeTaskContext[];
};

export interface PlanChangeAdvisor {
  advise(request: PlanChangeAdviceRequest): Promise<PlanChangeAdvice>;
}

const adviceSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  feasibility: z.enum(["feasible", "risky", "needs_clarification"]),
  affectedTaskIds: z.array(z.string().uuid()).max(50),
  options: z.array(z.object({
    title: z.string().trim().min(1).max(200),
    detail: z.string().trim().min(1).max(2000)
  }).strict()).min(1).max(4),
  warnings: z.array(z.string().trim().min(1).max(1000)).max(8)
}).strict();

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

export class DeepSeekPlanChangeAdvisor implements PlanChangeAdvisor {
  constructor(private readonly config: DeepSeekConfig) {}

  async advise(request: PlanChangeAdviceRequest): Promise<PlanChangeAdvice> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.DEEPSEEK_MAX_RETRIES; attempt += 1) {
      try {
        return await this.requestAdvice(request);
      } catch (error) {
        lastError = error;
        if (attempt === this.config.DEEPSEEK_MAX_RETRIES) break;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("DeepSeek plan-change consultation failed.");
  }

  private async requestAdvice(request: PlanChangeAdviceRequest): Promise<PlanChangeAdvice> {
    const response = await fetch(`${this.config.DEEPSEEK_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
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
              "你是个人计划软件中的协商顾问。用户主动提出临时变化时，你只分析可行性、受影响安排和可选方案。",
              "你绝不能声称已经修改、取消、延期或创建任何任务；你没有写入日程的权限。所有方案必须等待用户回到时间轴明确确认。",
              "不要擅自限制每日任务数量，不要推断人格、情绪、健康或意志力，也不要进行说教。",
              "只根据用户说明、当前任务和当天任务上下文回答。无法判断时使用 needs_clarification，并在 warnings 中提出一个具体问题。",
              "只引用 dailyTasks 内的任务 ID 到 affectedTaskIds；没有受影响任务时返回空数组。",
              "返回严格 JSON：summary、feasibility（feasible|risky|needs_clarification）、affectedTaskIds、options（1 到 4 个 title/detail）、warnings。不要返回 Markdown。"
            ].join("\n")
          },
          { role: "user", content: JSON.stringify(request) }
        ]
      }),
      signal: AbortSignal.timeout(this.config.DEEPSEEK_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`DeepSeek returned HTTP ${response.status}.`);
    const result = await response.json() as ChatCompletionResponse;
    const content = result.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek returned no plan-change consultation.");
    return adviceSchema.parse(JSON.parse(content));
  }
}

export function filterAdviceToKnownTasks(advice: PlanChangeAdvice, knownTaskIds: Set<string>): PlanChangeAdvice {
  return {
    ...advice,
    affectedTaskIds: [...new Set(advice.affectedTaskIds.filter((id) => knownTaskIds.has(id)))]
  };
}
