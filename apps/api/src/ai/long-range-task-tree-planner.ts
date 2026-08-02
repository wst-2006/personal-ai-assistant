import { z } from "zod";
import type { DeepSeekConfig } from "./config.js";
import { taskTreeProposalSchema, type TaskTreeProposal } from "@personal-ai/domain/long-range-plan";
import { personalContextInstruction, type UserAiContextProvider } from "./user-context.js";

export type LongRangeTaskTreeRequest = {
  title: string;
  periodStart: string;
  periodEnd: string;
  description: string | null;
  milestones: Array<{ title: string; targetDate: string | null; notes: string | null }>;
  instructions: string | null;
};

export interface LongRangeTaskTreePlanner { plan(input: LongRangeTaskTreeRequest): Promise<TaskTreeProposal>; }

type ChatResponse = { choices?: Array<{ message?: { content?: string } }> };

export class DeepSeekLongRangeTaskTreePlanner implements LongRangeTaskTreePlanner {
  constructor(private readonly config: DeepSeekConfig, private readonly userContext?: UserAiContextProvider) {}

  async plan(input: LongRangeTaskTreeRequest): Promise<TaskTreeProposal> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.DEEPSEEK_MAX_RETRIES; attempt += 1) {
      try { return await this.request(input); }
      catch (error) {
        lastError = error;
        if (attempt === this.config.DEEPSEEK_MAX_RETRIES) break;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("DeepSeek task-tree planning failed.");
  }

  private async request(input: LongRangeTaskTreeRequest): Promise<TaskTreeProposal> {
    const context = await personalContextInstruction(this.userContext, this.config.DEEPSEEK_USER_CONTEXT_MAX_CHARS);
    const response = await fetch(`${this.config.DEEPSEEK_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.DEEPSEEK_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.config.DEEPSEEK_MODEL,
        temperature: 0,
        max_tokens: this.config.DEEPSEEK_MAX_OUTPUT_TOKENS,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: [
            "你只提出个人长期规划的框架级任务候选，不替用户确认，不创建任何任务。",
            "输出严格 JSON：{\"summary\":\"一句话\",\"tasks\":[{\"title\":\"阶段或可辨认成果\",\"targetDate\":\"YYYY-MM-DD 或 null\",\"notes\":\"可选说明或 null\"}]}。",
            "最多 12 个候选，粒度保持在阶段、成果或明确的资料整理动作，不拆成课程知识点，不编造教材进度。",
            "候选全部是未排期任务；不要输出时间段、具体开始时间、难度、任务类型或连续专注字段。只返回 JSON，不要 Markdown。",
            context
          ].join("\n") },
          { role: "user", content: JSON.stringify(input) }
        ]
      }),
      signal: AbortSignal.timeout(this.config.DEEPSEEK_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`DeepSeek returned HTTP ${response.status}.`);
    const content = (await response.json() as ChatResponse).choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek returned no task-tree content.");
    return taskTreeProposalSchema.parse(JSON.parse(content));
  }
}
