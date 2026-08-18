import { generatedHealthPlanContentSchema, type HealthPlanContent } from "@personal-ai/domain/health";
import type { ZodIssue } from "zod";
import type { HealthPlanner } from "../health-service.js";
import type { DeepSeekConfig } from "./config.js";
import { personalContextInstruction, type UserAiContextProvider } from "./user-context.js";

type ChatCompletionResponse = { choices?: Array<{ message?: { content?: string } }> };
export type HealthPlanValidationIssue = { path: string; reason: string };

export class HealthPlanningTimeoutError extends Error {}
export class HealthPlanningOutputError extends Error {
  constructor(readonly userMessage: string, readonly validationIssues: readonly HealthPlanValidationIssue[] = []) {
    super(userMessage);
    this.name = "HealthPlanningOutputError";
  }
}
export class HealthPlanningProviderError extends Error {
  constructor(readonly status: number) { super(`DeepSeek returned HTTP ${status}.`); }
}

const HEALTH_PLAN_OUTPUT_CONTRACT = [
  "输出对象只允许 overview、supplements、days 三个根字段，不得增加解释、日期索引或元数据字段。",
  "days 必须恰好 7 项并按周日到周六排序；每个日对象不得增加 day、date、weekday、label 等字段。",
  "overview 为 1-2000 字；supplements 为 1-8 条，每条 1-320 字。",
  "每个日对象的 nutritionDirection、proteinRangeGrams、nutritionTargets、hydrationGuidance、mealExamples、proteinRotationSources、foodReference、plateGuidance、seasonalVegetables、seasonalGuidance、seasonalPoem、movement 全部必须出现。",
  "所有 minimum 必须小于或等于 maximum；蛋白质 1-300g，碳水/脂肪/纤维 0-1000g，饮水 0-10L，运动时长 minimum 0-240 分钟、maximum 0-300 分钟。",
  "macroRatioPercent 的 protein、carbohydrate、fat 可为整数或小数，均在 0-100，三项合计必须在 95-105。",
  "mealExamples 的 breakfast/lunch/dinner 各 1-6 条，snack 0-5 条；proteinRotationSources 1-5 条；三类 foodReference 各 1-10 条。",
  "movement.category 只能是 strength、volleyball、running、walking、cycling、recovery、rest；movement.intensity 只能是 rest、low、moderate、high；focus 与 safetyNotes 各 1-8 条。",
  "不得省略字段，不得把数组写成字符串，不得把数字或布尔值写成解释性文字。"
].join("\n");

const FIELD_LABELS: Record<string, string> = {
  overview: "本周摘要",
  supplements: "补充剂提示",
  days: "七日安排",
  nutritionDirection: "饮食方向",
  proteinRangeGrams: "蛋白质范围",
  nutritionTargets: "营养目标",
  carbohydrateGrams: "碳水范围",
  fatGrams: "脂肪范围",
  fiberGrams: "膳食纤维范围",
  hydrationLiters: "饮水范围",
  macroRatioPercent: "三大营养素比例",
  protein: "蛋白质比例",
  carbohydrate: "碳水比例",
  fat: "脂肪比例",
  hydrationGuidance: "分时饮水建议",
  mealExamples: "三餐示例",
  breakfast: "早餐",
  lunch: "午餐",
  dinner: "晚餐",
  snack: "加餐",
  proteinRotationSources: "蛋白来源轮换",
  foodReference: "替代食材",
  proteinOptions: "蛋白替代",
  fiberOptions: "纤维替代",
  carbOptions: "碳水替代",
  plateGuidance: "餐盘提示",
  seasonalVegetables: "时令蔬菜",
  seasonalGuidance: "时令提示",
  seasonalPoem: "时令诗句",
  movement: "运动参考",
  category: "运动类别",
  durationMinutes: "运动时长",
  intensity: "运动强度",
  highIntensity: "高强度标记",
  safetyReminder: "安全提醒",
  focus: "训练重点",
  safetyNotes: "运动安全注意",
  minimum: "下限",
  maximum: "上限"
};

const MOVEMENT_CATEGORY_ALIASES: Record<string, string> = {
  strength_training: "strength",
  "力量训练": "strength",
  volleyball_training: "volleyball",
  "排球": "volleyball",
  run: "running",
  jogging: "running",
  "跑步": "running",
  walk: "walking",
  brisk_walking: "walking",
  "步行": "walking",
  "散步": "walking",
  bike: "cycling",
  bicycling: "cycling",
  "骑行": "cycling",
  active_recovery: "recovery",
  "轻量恢复": "recovery",
  "恢复": "recovery",
  "休息": "rest"
};

const INTENSITY_ALIASES: Record<string, string> = {
  none: "rest",
  "休息": "rest",
  light: "low",
  easy: "low",
  "低": "low",
  medium: "moderate",
  "中等": "moderate",
  vigorous: "high",
  hard: "high",
  "高": "high"
};

const EXPECTED_TYPE_LABELS: Record<string, string> = {
  string: "文字",
  number: "数字",
  integer: "整数",
  boolean: "布尔值",
  array: "列表",
  object: "对象"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickKnown(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = value[key];
  }
  return result;
}

function normalizeNumber(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed) ? Number(trimmed) : value;
}

function normalizeBoolean(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return value;
}

function normalizeAlias(value: unknown, aliases: Record<string, string>): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase().replace(/[\s-]+/g, "_");
  return aliases[normalized] ?? aliases[trimmed] ?? value;
}

function normalizeRange(value: unknown): unknown {
  const range = pickKnown(value, ["minimum", "maximum"]);
  if (!range) return value;
  if ("minimum" in range) range.minimum = normalizeNumber(range.minimum);
  if ("maximum" in range) range.maximum = normalizeNumber(range.maximum);
  return range;
}

function normalizeMealExamples(value: unknown): unknown {
  return pickKnown(value, ["breakfast", "lunch", "dinner", "snack"]) ?? value;
}

function normalizeFoodReference(value: unknown): unknown {
  return pickKnown(value, ["proteinOptions", "fiberOptions", "carbOptions"]) ?? value;
}

function normalizeSeasonalPoem(value: unknown): unknown {
  if (value === null) return null;
  return pickKnown(value, ["title", "author", "excerpt", "relevance"]) ?? value;
}

function normalizeNutritionTargets(value: unknown): unknown {
  const targets = pickKnown(value, ["carbohydrateGrams", "fatGrams", "fiberGrams", "hydrationLiters", "macroRatioPercent"]);
  if (!targets) return value;
  for (const key of ["carbohydrateGrams", "fatGrams", "fiberGrams", "hydrationLiters"] as const) {
    if (key in targets) targets[key] = normalizeRange(targets[key]);
  }
  if ("macroRatioPercent" in targets) {
    const ratio = pickKnown(targets.macroRatioPercent, ["protein", "carbohydrate", "fat"]);
    if (ratio) {
      for (const key of ["protein", "carbohydrate", "fat"] as const) {
        if (key in ratio) ratio[key] = normalizeNumber(ratio[key]);
      }
      targets.macroRatioPercent = ratio;
    }
  }
  return targets;
}

function normalizeMovement(value: unknown): unknown {
  const movement = pickKnown(value, ["category", "durationMinutes", "intensity", "highIntensity", "safetyReminder", "focus", "safetyNotes"]);
  if (!movement) return value;
  if ("category" in movement) movement.category = normalizeAlias(movement.category, MOVEMENT_CATEGORY_ALIASES);
  if ("durationMinutes" in movement) movement.durationMinutes = normalizeRange(movement.durationMinutes);
  if ("intensity" in movement) movement.intensity = normalizeAlias(movement.intensity, INTENSITY_ALIASES);
  if ("highIntensity" in movement) movement.highIntensity = normalizeBoolean(movement.highIntensity);
  return movement;
}

function normalizeDay(value: unknown): unknown {
  const day = pickKnown(value, [
    "nutritionDirection", "proteinRangeGrams", "nutritionTargets", "hydrationGuidance", "mealExamples",
    "proteinRotationSources", "foodReference", "plateGuidance", "seasonalVegetables", "seasonalGuidance",
    "seasonalPoem", "movement"
  ]);
  if (!day) return value;
  if ("proteinRangeGrams" in day) day.proteinRangeGrams = normalizeRange(day.proteinRangeGrams);
  if ("nutritionTargets" in day) day.nutritionTargets = normalizeNutritionTargets(day.nutritionTargets);
  if ("mealExamples" in day) day.mealExamples = normalizeMealExamples(day.mealExamples);
  if ("foodReference" in day) day.foodReference = normalizeFoodReference(day.foodReference);
  if ("seasonalPoem" in day) day.seasonalPoem = normalizeSeasonalPoem(day.seasonalPoem);
  if ("movement" in day) day.movement = normalizeMovement(day.movement);
  return day;
}

export function normalizeProviderHealthPlan(value: unknown): unknown {
  const plan = pickKnown(value, ["overview", "supplements", "days"]);
  if (!plan) return value;
  if (Array.isArray(plan.days)) plan.days = plan.days.map(normalizeDay);
  return plan;
}

function parseProviderJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

function issuePath(path: Array<string | number>): { machine: string; user: string } {
  const machine = path.map(String).join(".") || "root";
  let prefix = "";
  let fields = path;
  if (path[0] === "days" && typeof path[1] === "number") {
    prefix = `第 ${path[1] + 1} 天`;
    fields = path.slice(2);
  }
  const labels = fields
    .filter((segment): segment is string => typeof segment === "string")
    .map((segment) => FIELD_LABELS[segment] ?? segment);
  const label = labels.length > 0 ? labels.join(" / ") : FIELD_LABELS.days;
  return { machine, user: `${prefix}${prefix && label ? "的" : ""}“${label}”` };
}

function issueReason(issue: ZodIssue): string {
  if (issue.code === "invalid_type") {
    const expected = EXPECTED_TYPE_LABELS[issue.expected] ?? issue.expected;
    return issue.received === "undefined" ? "缺少必填字段" : `类型不正确，应为${expected}`;
  }
  if (issue.code === "invalid_enum_value") return "值不在允许范围内";
  if (issue.code === "unrecognized_keys") return "包含未允许的字段";
  if (issue.code === "too_small") return issue.type === "array" ? "条目数量不足" : "数值或文字长度低于允许范围";
  if (issue.code === "too_big") return issue.type === "array" ? "条目数量过多" : "数值或文字长度超过允许范围";
  if (issue.message.includes("minimum cannot exceed maximum")) return "下限不能大于上限";
  if (issue.message.includes("Macro ratio percentages")) return "三项比例合计必须接近 100%";
  if (issue.message.includes("is required for newly generated")) return "缺少必填字段";
  return "内容不符合候选格式";
}

function validationOutputError(issues: readonly ZodIssue[]): HealthPlanningOutputError {
  const validationIssues = issues.map((issue) => {
    const path = issuePath(issue.path);
    return { path: path.machine, reason: issueReason(issue), userPath: path.user };
  });
  const unique = Array.from(new Map(validationIssues.map((issue) => [`${issue.path}:${issue.reason}`, issue])).values());
  const visible = unique.slice(0, 3).map((issue) => `${issue.userPath}${issue.reason}`).join("；");
  const remainder = unique.length > 3 ? `；另有 ${unique.length - 3} 项` : "";
  return new HealthPlanningOutputError(`${visible || "候选结构不完整"}${remainder}`, unique.map(({ path, reason }) => ({ path, reason })));
}

function isTimeout(error: unknown) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function retryableProviderError(error: unknown) {
  return error instanceof HealthPlanningProviderError && (error.status === 408 || error.status === 429 || error.status >= 500);
}

export class DeepSeekHealthPlanner implements HealthPlanner {
  constructor(private readonly config: DeepSeekConfig, private readonly userContext?: UserAiContextProvider) {}

  async plan(input: Parameters<HealthPlanner["plan"]>[0]): Promise<HealthPlanContent> {
    let lastError: unknown;
    const maximumRetries = Math.min(1, this.config.DEEPSEEK_MAX_RETRIES);
    for (let attempt = 0; attempt <= maximumRetries; attempt += 1) {
      try {
        return await this.requestPlan(input);
      } catch (error) {
        lastError = isTimeout(error) ? new HealthPlanningTimeoutError("DeepSeek health planning timed out.") : error;
        // A timed-out generation may already have consumed provider tokens.
        // Do not silently repeat it. Only one bounded retry is allowed for an
        // explicit transient provider response such as 429 or 5xx.
        if (attempt === maximumRetries || !retryableProviderError(error)) break;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("DeepSeek health planning failed.");
  }

  private async requestPlan(input: Parameters<HealthPlanner["plan"]>[0]): Promise<HealthPlanContent> {
    const context = await personalContextInstruction(this.userContext, this.config.DEEPSEEK_USER_CONTEXT_MAX_CHARS);
    const response = await fetch(`${this.config.DEEPSEEK_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.DEEPSEEK_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.config.DEEPSEEK_MODEL,
        temperature: 0.2,
        // A validated seven-day plan is substantially larger than the short
        // task/review responses that share the global default. A larger ceiling
        // prevents a paid request from being truncated into invalid JSON.
        max_tokens: Math.max(8_192, this.config.DEEPSEEK_MAX_OUTPUT_TOKENS),
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "你为单一用户生成每周健康参考候选，永远不是医疗、营养处方或训练计划。",
              "只根据用户主动保存的资料、城市、节气、已有日程与本次特殊说明生成内容；不得推断人格、体质、疾病或心理状态。",
              "返回 JSON：{overview:string,supplements:string[],days:[7 个日对象]}。",
              HEALTH_PLAN_OUTPUT_CONTRACT,
              "饮食是可执行的参考而非硬性处方：给保守范围、三餐与可选加餐的真实食材示例、当天蛋白来源轮换和替代食材；不得要求打卡，不得把示例写成必须执行。缺少精确资料时必须在 overview 或 nutritionDirection 说明假设。",
              "蛋白质、碳水、脂肪、纤维和饮水使用每日参考范围；hydrationGuidance 给出可选择的分时饮水参考、运动前后调整和避免一次性大量饮水的提示，不计算实际饮水量。三大营养素比例总和约为 100。mealExamples 每餐应具体但简短，不计算用户实际已摄入量，不伪装成完成进度。",
              "运动给类别、时长范围、强度、2-6 条训练重点或动作结构以及分条安全注意事项；不得给确定重量、配速、治疗或康复处方。用户资料中存在不适记录时使用保守替代和停止条件。",
              "不把建议写成任务，不要求反馈，不自动改变用户资料。必须避免相邻高冲击高强度日。",
              "当输入包含 sleepAnalysis 时，它是用户主动要求的单次修订依据：只使用其中非空、可见的指标生成候选，不诊断睡眠问题，不将一次记录写成长期结论，也不自动改变任何现有周计划。",
              "节气内容只作为传统饮食文化和时令提示，不做中医体质诊断或治疗宣称。",
              "weather 只在系统真实取得天气预报时出现；缺失时不得编造天气。可根据温度、降水概率和天气代码给出简短、可选择的出行或活动提示。",
              "seasonalPoem 只能选择确有把握的真实古诗词短句；作者、篇名或原句不确定时必须返回 null，禁止杜撰。excerpt 保持简短，relevance 只解释与当天时令或天气的联系。",
              "补充剂内容仅提示标签、成分重复和咨询专业人士的场景；不提供确定剂量、不自动加入肌酸。",
              "只返回 JSON，不要 Markdown。",
              context
            ].join("\n")
          },
          { role: "user", content: JSON.stringify(input) }
        ]
      }),
      signal: AbortSignal.timeout(Math.max(120_000, this.config.DEEPSEEK_TIMEOUT_MS))
    });
    if (!response.ok) throw new HealthPlanningProviderError(response.status);
    const result = await response.json() as ChatCompletionResponse;
    const content = result.choices?.[0]?.message?.content;
    if (!content) throw new HealthPlanningOutputError("没有返回可用的健康候选内容");
    let parsed: unknown;
    try {
      parsed = parseProviderJson(content);
    } catch {
      throw new HealthPlanningOutputError("返回的 JSON 不完整或格式损坏");
    }
    const validated = generatedHealthPlanContentSchema.safeParse(normalizeProviderHealthPlan(parsed));
    if (!validated.success) throw validationOutputError(validated.error.issues);
    return validated.data;
  }
}
