import {
  sleepImageAnalysisSchema,
  type SleepImageAnalysis
} from "@personal-ai/domain/health";
import type { SleepImageAnalyzer } from "../health-service.js";
import type { DeepSeekConfig } from "./config.js";
import { personalContextInstruction, type UserAiContextProvider } from "./user-context.js";

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
};

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

export class DeepSeekSleepImageAnalyzer implements SleepImageAnalyzer {
  constructor(private readonly config: DeepSeekConfig, private readonly userContext?: UserAiContextProvider) {}

  async analyze(input: { localDate: string; fileName: string; mimeType: string; dataUrl: string }): Promise<SleepImageAnalysis> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.DEEPSEEK_MAX_RETRIES; attempt += 1) {
      try {
        return await this.requestAnalysis(input);
      } catch (error) {
        lastError = error;
        if (attempt === this.config.DEEPSEEK_MAX_RETRIES) break;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("DeepSeek sleep image analysis failed.");
  }

  private async requestAnalysis(input: { localDate: string; fileName: string; mimeType: string; dataUrl: string }): Promise<SleepImageAnalysis> {
    const context = await personalContextInstruction(this.userContext, this.config.DEEPSEEK_USER_CONTEXT_MAX_CHARS);
    const response = await fetch(endpoint(this.config.DEEPSEEK_BASE_URL), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.DEEPSEEK_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.DEEPSEEK_VISION_MODEL,
        temperature: 0,
        max_tokens: this.config.DEEPSEEK_MAX_OUTPUT_TOKENS,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "你是睡眠截图的可审计结构化读取器，不是医生，也不做睡眠障碍诊断。",
              "只读取这张图片中清晰可见的数字、时间、设备评分和设备说明；图片没有显示的字段必须返回 null，不得根据常识补全。",
              "所有时长统一返回分钟整数；无法确定或单位不清楚时返回 null。",
              "visibleMetrics 只列出图片实际出现且成功读取的指标。interpretation 只能描述图中数据，不得给出治疗或确定医学结论。limitations 至少包含‘仅基于这张截图中可见的信息，不能替代专业医疗建议’。",
              "只返回一个 JSON 对象，不要 Markdown 或解释。",
              context
            ].join("\n")
          },
          {
            role: "user",
            content: [
              { type: "text", text: JSON.stringify({ localDate: input.localDate, fileName: input.fileName, requiredKeys: ["totalSleepMinutes", "deepSleepMinutes", "lightSleepMinutes", "remSleepMinutes", "awakeCount", "sleepStart", "wakeTime", "deviceScore", "deviceNotes", "visibleMetrics", "interpretation", "limitations"] }) },
              { type: "image_url", image_url: { url: input.dataUrl } }
            ]
          }
        ]
      }),
      signal: AbortSignal.timeout(this.config.DEEPSEEK_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`DeepSeek returned HTTP ${response.status}.`);
    const result = await response.json() as ChatCompletionResponse;
    const content = result.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : content;
    if (!text) throw new Error("DeepSeek returned no sleep analysis content.");
    return sleepImageAnalysisSchema.parse(JSON.parse(text));
  }
}
