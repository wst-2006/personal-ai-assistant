import { z } from "zod";
import { focusSegmentSchema, type FocusSegment } from "@personal-ai/domain/focus";
import type { DeepSeekConfig } from "./config.js";

export type PlanFocusStructureRequest = {
  title: string;
  totalStartAt: string;
  totalEndAt: string;
  totalMinutes: number;
  instructions: string | null;
};

export interface FocusStructurePlanner {
  plan(request: PlanFocusStructureRequest): Promise<FocusSegment[]>;
}

const responseSchema = z.object({ segments: z.array(focusSegmentSchema).min(1).max(40) }).strict();

type ChatCompletionResponse = { choices?: Array<{ message?: { content?: string } }> };

export class DeepSeekFocusStructurePlanner implements FocusStructurePlanner {
  constructor(private readonly config: DeepSeekConfig) {}

  async plan(request: PlanFocusStructureRequest): Promise<FocusSegment[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.DEEPSEEK_MAX_RETRIES; attempt += 1) {
      try {
        return await this.requestPlan(request);
      } catch (error) {
        lastError = error;
        if (attempt === this.config.DEEPSEEK_MAX_RETRIES) break;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("DeepSeek focus planning failed.");
  }

  private async requestPlan(request: PlanFocusStructureRequest): Promise<FocusSegment[]> {
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
              "你是个人专注结构规划器，只生成候选，不替用户作最终决定。",
              "输出 JSON 对象：{\"segments\":[{\"segmentType\":\"focus|break\",\"durationMinutes\":整数}]}。",
              "所有分钟之和必须严格等于任务总分钟数，不得改变任务开始或结束时间。",
              "30 分钟任务只能返回一个 30 分钟 focus，不插入休息。",
              "其他结构必须从 focus 开始，focus 与 break 交替，并在最后一个 focus 后保留 break。",
              "每个 focus 至少 30 分钟；每个 break 为 5 至 15 分钟。",
              "只使用用户本次要求和任务信息，不推断人格、意志力、精神或健康状态。",
              "只返回 JSON，不要 Markdown 或解释。"
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
    if (!content) throw new Error("DeepSeek returned no focus structure content.");
    return responseSchema.parse(JSON.parse(content)).segments;
  }
}
