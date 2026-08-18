import type { DeepSeekConfig } from "./config.js";
import {
  organizedLongRangePlanSchema,
  type OrganizedLongRangePlan,
  type OrganizeLongRangePlanInput
} from "@personal-ai/domain/long-range-plan";
import { personalContextInstruction, type UserAiContextProvider } from "./user-context.js";

type ChatResponse = { choices?: Array<{ message?: { content?: string } }> };

export interface LongRangePlanOrganizer {
  organize(input: OrganizeLongRangePlanInput): Promise<OrganizedLongRangePlan>;
}

export class DeepSeekLongRangePlanOrganizer implements LongRangePlanOrganizer {
  constructor(private readonly config: DeepSeekConfig, private readonly userContext?: UserAiContextProvider) {}

  async organize(input: OrganizeLongRangePlanInput): Promise<OrganizedLongRangePlan> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.DEEPSEEK_MAX_RETRIES; attempt += 1) {
      try { return await this.request(input); }
      catch (error) {
        lastError = error;
        if (attempt === this.config.DEEPSEEK_MAX_RETRIES) break;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("DeepSeek long-range plan organization failed.");
  }

  private async request(input: OrganizeLongRangePlanInput): Promise<OrganizedLongRangePlan> {
    const context = await personalContextInstruction(this.userContext, this.config.DEEPSEEK_USER_CONTEXT_MAX_CHARS);
    const response = await fetch(`${this.config.DEEPSEEK_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.DEEPSEEK_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.config.DEEPSEEK_MODEL,
        temperature: 0,
        max_tokens: this.config.DEEPSEEK_MAX_OUTPUT_TOKENS,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: [
            "你是个人长期规划的协作整理者。用户保留最终决定，你只返回可编辑候选，不保存、不创建任务、不调整时间轴。",
            "保留用户的真实目标、边界和语气，不得虚构教材、进度、经历或承诺。",
            "把原始说明整理为清晰的规划标题、完整说明和最多 12 个框架级里程碑；避免细碎知识点和空泛口号。",
            "输出严格 JSON：{\"title\":\"规划标题\",\"description\":\"整理后的完整规划说明\",\"milestones\":[{\"title\":\"节点\",\"targetDate\":\"YYYY-MM-DD 或 null\",\"notes\":\"说明或 null\"}]}。",
            "日期必须位于用户给出的规划起止日期内；无法合理确定日期时返回 null。只返回 JSON，不要 Markdown。",
            context
          ].join("\n") },
          { role: "user", content: JSON.stringify(input) }
        ]
      }),
      signal: AbortSignal.timeout(this.config.DEEPSEEK_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`DeepSeek returned HTTP ${response.status}.`);
    const content = (await response.json() as ChatResponse).choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek returned no long-range plan candidate.");
    const candidate = organizedLongRangePlanSchema.parse(JSON.parse(content));
    return {
      ...candidate,
      milestones: candidate.milestones.map((milestone) => ({
        ...milestone,
        targetDate: milestone.targetDate && milestone.targetDate >= input.periodStart && milestone.targetDate <= input.periodEnd
          ? milestone.targetDate
          : null
      }))
    };
  }
}
