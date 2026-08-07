import { z } from "zod";
import type { DeepSeekConfig } from "./config.js";
import { personalContextInstruction, type UserAiContextProvider } from "./user-context.js";

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
  options: Array<{
    title: string;
    detail: string;
    adjustments: PlanChangeScheduleAdjustment[];
  }>;
  warnings: string[];
};

export type PlanChangeScheduleAdjustment = {
  taskId: string;
  scheduleKind: "none" | "daypart" | "exact";
  localDate: string | null;
  daypart: "morning" | "afternoon" | "evening" | null;
  startAt: string | null;
  endAt: string | null;
  timeZone: "Asia/Shanghai";
  reason: string;
};

export type PlanChangeAdviceRequest = {
  message: string;
  referenceDate: string;
  currentTime: string;
  task: PlanChangeTaskContext;
  dayTasks: PlanChangeTaskContext[];
};

export interface PlanChangeAdvisor {
  advise(request: PlanChangeAdviceRequest): Promise<PlanChangeAdvice>;
}

const scheduleAdjustmentSchema = z.object({
  taskId: z.string().uuid(),
  scheduleKind: z.enum(["none", "daypart", "exact"]),
  localDate: z.string().date().nullable(),
  daypart: z.enum(["morning", "afternoon", "evening"]).nullable(),
  startAt: z.string().datetime({ offset: true }).nullable(),
  endAt: z.string().datetime({ offset: true }).nullable(),
  timeZone: z.literal("Asia/Shanghai"),
  reason: z.string().trim().min(1).max(1000)
}).strict().superRefine((adjustment, context) => {
  if (adjustment.scheduleKind === "none") {
    if (adjustment.daypart !== null || adjustment.startAt !== null || adjustment.endAt !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["scheduleKind"], message: "Unscheduled adjustments cannot contain time fields" });
    }
    return;
  }
  if (adjustment.scheduleKind === "daypart") {
    if (!adjustment.localDate || !adjustment.daypart || adjustment.startAt !== null || adjustment.endAt !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["scheduleKind"], message: "Daypart adjustments require localDate/daypart only" });
    }
    return;
  }
  if (adjustment.localDate !== null || adjustment.daypart !== null || !adjustment.startAt || !adjustment.endAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["scheduleKind"], message: "Exact adjustments require startAt/endAt only" });
    return;
  }
  const start = new Date(adjustment.startAt);
  const end = new Date(adjustment.endAt);
  if (!isHalfHourBoundary(start) || !isHalfHourBoundary(end) || end.getTime() - start.getTime() < 30 * 60 * 1000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["startAt"], message: "Exact adjustments must use valid 30-minute boundaries" });
    return;
  }
  if (localDate(start) !== localDate(end)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endAt"], message: "Exact adjustments cannot cross midnight" });
  }
});

const adviceSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  feasibility: z.enum(["feasible", "risky", "needs_clarification"]),
  affectedTaskIds: z.array(z.string().uuid()).max(50),
  options: z.array(z.object({
    title: z.string().trim().min(1).max(200),
    detail: z.string().trim().min(1).max(2000),
    adjustments: z.array(scheduleAdjustmentSchema).max(4).default([])
  }).strict()).min(1).max(4),
  warnings: z.array(z.string().trim().min(1).max(1000)).max(8)
}).strict();

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

export class DeepSeekPlanChangeAdvisor implements PlanChangeAdvisor {
  constructor(private readonly config: DeepSeekConfig, private readonly userContext?: UserAiContextProvider) {}

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
    const context = await personalContextInstruction(this.userContext, this.config.DEEPSEEK_USER_CONTEXT_MAX_CHARS);
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
              "每个 option 还必须包含 adjustments 数组。只有信息足够明确时才给出具体排期候选；否则返回空数组并解释需要用户补充什么。",
              "adjustments 只能调整 lifecycleStatus=open 的既有任务排期，不能修改 active、awaiting_outcome、closed 或 cancelled 任务，不能创建、取消或关闭任务。",
              "每个 adjustment 返回 taskId、scheduleKind、localDate、daypart、startAt、endAt、timeZone、reason。严格遵守 none/daypart/exact 字段矩阵。",
              "精确时间使用带偏移 ISO 8601、Asia/Shanghai、30 分钟边界、至少 30 分钟、不得跨午夜。不得改变标题或备注。",
              "返回严格 JSON：summary、feasibility（feasible|risky|needs_clarification）、affectedTaskIds、options（1 到 4 个 title/detail/adjustments）、warnings。不要返回 Markdown。",
              context
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

export function filterAdviceToKnownTasks(advice: PlanChangeAdvice, knownTasks: Map<string, PlanChangeTaskContext>): PlanChangeAdvice {
  const options = advice.options.map((option) => ({
    ...option,
    adjustments: option.adjustments.filter((adjustment) => {
      const task = knownTasks.get(adjustment.taskId);
      return task?.lifecycleStatus === "open" && changesSchedule(task, adjustment);
    })
  }));
  const adjustmentTaskIds = options.flatMap((option) => option.adjustments.map((adjustment) => adjustment.taskId));
  return {
    ...advice,
    options,
    affectedTaskIds: [...new Set([
      ...advice.affectedTaskIds.filter((id) => knownTasks.has(id)),
      ...adjustmentTaskIds
    ])]
  };
}

function changesSchedule(task: PlanChangeTaskContext, adjustment: PlanChangeScheduleAdjustment): boolean {
  return task.scheduleKind !== adjustment.scheduleKind
    || task.localDate !== adjustment.localDate
    || task.daypart !== adjustment.daypart
    || task.startAt !== adjustment.startAt
    || task.endAt !== adjustment.endAt
    || task.timeZone !== adjustment.timeZone;
}

function isHalfHourBoundary(value: Date): boolean {
  if (!Number.isFinite(value.getTime()) || value.getUTCMilliseconds() !== 0) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? -1);
  const second = Number(parts.find((part) => part.type === "second")?.value ?? -1);
  return minute % 30 === 0 && second === 0;
}

function localDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(value);
}
