import { healthPlanContentSchema, type HealthPlanContent } from "@personal-ai/domain/health";
import type { HealthPlanner } from "../health-service.js";
import type { DeepSeekConfig } from "./config.js";

type ChatCompletionResponse = { choices?: Array<{ message?: { content?: string } }> };

export class DeepSeekHealthPlanner implements HealthPlanner {
  constructor(private readonly config: DeepSeekConfig) {}

  async plan(input: Parameters<HealthPlanner["plan"]>[0]): Promise<HealthPlanContent> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.DEEPSEEK_MAX_RETRIES; attempt += 1) {
      try {
        return await this.requestPlan(input);
      } catch (error) {
        lastError = error;
        if (attempt === this.config.DEEPSEEK_MAX_RETRIES) break;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("DeepSeek health planning failed.");
  }

  private async requestPlan(input: Parameters<HealthPlanner["plan"]>[0]): Promise<HealthPlanContent> {
    const response = await fetch(`${this.config.DEEPSEEK_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.DEEPSEEK_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.config.DEEPSEEK_MODEL,
        temperature: 0.2,
        max_tokens: this.config.DEEPSEEK_MAX_OUTPUT_TOKENS,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "你为单一用户生成每周健康参考候选，永远不是医疗、营养处方或训练计划。",
              "只根据用户主动保存的资料、城市、节气、已有日程与本次特殊说明生成内容；不得推断人格、体质、疾病或心理状态。",
              "返回 JSON：{overview:string,supplements:string[],days:[7 个日对象]}。",
              "每个日对象必须有 nutritionDirection、proteinRangeGrams({minimum:90,maximum:120})、plateGuidance(1-5 条)、seasonalVegetables(1-6 条)、movement({category:'strength|volleyball|running|cycling|recovery|rest',durationMinutes:{minimum,maximum},intensity:'rest|low|moderate|high',highIntensity:boolean,safetyReminder})。",
              "饮食只能给范围、餐盘结构、时令蔬菜和高强度日方向，不给克数菜谱、每日打卡或必须吃的食物。",
              "运动只能给类别、时长范围、强度和一句安全提醒，不给动作、组数、重量、配速或康复治疗建议。",
              "不把建议写成任务，不要求反馈，不自动改变用户资料。必须避免相邻高冲击高强度日。",
              "当输入包含 sleepAnalysis 时，它是用户主动要求的单次修订依据：只使用其中非空、可见的指标生成候选，不诊断睡眠问题，不将一次记录写成长期结论，也不自动改变任何现有周计划。",
              "节气内容只作为传统饮食文化和时令提示，不做中医体质诊断或治疗宣称。",
              "补充剂内容仅提示标签、成分重复和咨询专业人士的场景；不提供确定剂量、不自动加入肌酸。",
              "只返回 JSON，不要 Markdown。"
            ].join("\n")
          },
          { role: "user", content: JSON.stringify(input) }
        ]
      }),
      signal: AbortSignal.timeout(this.config.DEEPSEEK_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`DeepSeek returned HTTP ${response.status}.`);
    const result = await response.json() as ChatCompletionResponse;
    const content = result.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek returned no health plan content.");
    return healthPlanContentSchema.parse(JSON.parse(content));
  }
}
