import { generatedHealthPlanContentSchema, type HealthPlanContent } from "@personal-ai/domain/health";
import type { ZodIssue } from "zod";
import type { HealthPlanner } from "../health-service.js";
import type { DeepSeekConfig } from "./config.js";
import { personalContextInstruction, type UserAiContextProvider } from "./user-context.js";

type ChatCompletionResponse = { choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }> };
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
  "每个日对象的 nutritionDirection、proteinRangeGrams、nutritionTargets、hydrationGuidance、mealExamples、proteinRotationSources、foodReference、fruitOptions、plateGuidance、seasonalVegetables、seasonalGuidance、seasonalPoem 全部必须出现。",
  "所有 minimum 必须小于或等于 maximum；蛋白质 1-300g，碳水/脂肪/纤维 0-1000g，饮水 0-10L，运动时长 minimum 0-240 分钟、maximum 0-300 分钟。",
  "macroRatioPercent 的 protein、carbohydrate、fat 可为整数或小数，均在 0-100，三项合计必须在 95-105。",
  "mealExamples 的 breakfast/lunch/dinner 各 1-6 条，snack 0-5 条；proteinRotationSources 1-5 条；三类 foodReference 各 1-10 条；fruitOptions 2-6 条。",
  "不得返回 movement、exercise、training、workout 或任何训练计划字段；运动安排由用户自己管理。",
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
  fruitOptions: "水果推荐",
  proteinOptions: "蛋白替代",
  fiberOptions: "纤维替代",
  carbOptions: "碳水替代",
  plateGuidance: "餐盘提示",
  seasonalVegetables: "时令蔬菜",
  seasonalGuidance: "时令提示",
  seasonalPoem: "时令诗句",
  minimum: "下限",
  maximum: "上限"
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

function normalizeRange(value: unknown): unknown {
  const range = pickKnown(value, ["minimum", "maximum"]);
  if (!range) return value;
  if ("minimum" in range) range.minimum = normalizeNumber(range.minimum);
  if ("maximum" in range) range.maximum = normalizeNumber(range.maximum);
  return range;
}

function normalizeList(value: unknown): unknown {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value;
  return value;
}

function firstPresent(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  return undefined;
}

function parseRangeFromText(value: unknown, suffix: string): { minimum: number; maximum: number } | null {
  if (Array.isArray(value)) value = value.join(" ");
  if (typeof value !== "string") return null;
  const escapedSuffix = suffix === "L" ? "(?:L|升)" : suffix;
  const match = value.match(new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*(?:[-–—~至到])\\s*([0-9]+(?:\\.[0-9]+)?)\\s*${escapedSuffix}`, "iu"));
  if (!match) return null;
  const minimum = Number(match[1]);
  const maximum = Number(match[2]);
  return Number.isFinite(minimum) && Number.isFinite(maximum) ? { minimum, maximum } : null;
}

function normalizeMealExamples(value: unknown): unknown {
  return pickKnown(value, ["breakfast", "lunch", "dinner", "snack"]) ?? value;
}

function normalizeFoodReference(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const normalized = {
    proteinOptions: firstPresent(value, ["proteinOptions", "proteinFoods", "proteinSources", "proteins"]),
    fiberOptions: firstPresent(value, ["fiberOptions", "fiberFoods", "vegetableOptions", "vegetables"]),
    carbOptions: firstPresent(value, ["carbOptions", "carbFoods", "stapleOptions", "stapleFoods", "carbohydrateOptions"])
  };
  return Object.fromEntries(Object.entries(normalized)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => [key, normalizeList(item)]));
}

function normalizeSeasonalPoem(value: unknown): unknown {
  if (value === null) return null;
  if (!isRecord(value)) return value;
  const poem = pickKnown(value, ["title", "author", "excerpt", "relevance"]) ?? {};
  const excerpt = poem.excerpt;
  if (typeof excerpt === "string") {
    const knownPoems: Array<{ excerpt: string; title: string; author: string }> = [
      { excerpt: "自古逢秋悲寂寥，我言秋日胜春朝。", title: "秋词", author: "刘禹锡" },
      { excerpt: "空山新雨后，天气晚来秋。", title: "山居秋暝", author: "王维" }
    ];
    const known = knownPoems.find((item) => excerpt.includes(item.excerpt) || item.excerpt.includes(excerpt));
    if (known) {
      poem.title ??= known.title;
      poem.author ??= known.author;
    }
  }
  return poem;
}

function normalizeNutritionTargets(value: unknown, hydrationGuidance: unknown): unknown {
  if (!isRecord(value)) return value;
  const targets: Record<string, unknown> = {};
  const aliases: Record<string, readonly string[]> = {
    carbohydrateGrams: ["carbohydrateGrams", "carbohydrateRangeGrams", "carbGrams", "carbsGrams"],
    fatGrams: ["fatGrams", "fatRangeGrams"],
    fiberGrams: ["fiberGrams", "fiberRangeGrams"],
    hydrationLiters: ["hydrationLiters", "waterLiters", "waterRangeLiters", "hydrationRangeLiters"],
    macroRatioPercent: ["macroRatioPercent", "macroRatio", "macros"]
  };
  for (const [canonical, keys] of Object.entries(aliases)) {
    const item = firstPresent(value, keys);
    if (item !== undefined) targets[canonical] = item;
  }
  if (targets.hydrationLiters === undefined) {
    const parsed = parseRangeFromText(hydrationGuidance, "L");
    if (parsed) targets.hydrationLiters = parsed;
  }
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

function neutralMovementReference() {
  return {
    category: "rest" as const,
    durationMinutes: { minimum: 0, maximum: 0 },
    intensity: "rest" as const,
    highIntensity: false,
    safetyReminder: "健康饮食参考不生成训练计划。"
  };
}

function normalizeDay(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const day = pickKnown(value, [
    "nutritionDirection", "proteinRangeGrams", "nutritionTargets", "hydrationGuidance", "mealExamples",
    "proteinRotationSources", "foodReference", "fruitOptions", "plateGuidance", "seasonalVegetables", "seasonalGuidance",
    "seasonalPoem"
  ]) ?? {};
  if (day.hydrationGuidance === undefined) day.hydrationGuidance = firstPresent(value, ["hydration", "waterGuidance"]);
  if (day.plateGuidance === undefined) day.plateGuidance = firstPresent(value, ["plateAdvice", "plate"]);
  if (day.proteinRotationSources === undefined) day.proteinRotationSources = firstPresent(value, ["proteinSources", "proteinRotation"]);
  if (day.seasonalVegetables === undefined) day.seasonalVegetables = firstPresent(value, ["seasonalVegetableOptions"]);
  if (day.fruitOptions === undefined) day.fruitOptions = firstPresent(value, ["fruitOptions", "fruit", "seasonalFruits"]);
  if ("hydrationGuidance" in day) day.hydrationGuidance = normalizeList(day.hydrationGuidance);
  if ("plateGuidance" in day) day.plateGuidance = normalizeList(day.plateGuidance);
  if ("proteinRotationSources" in day) day.proteinRotationSources = normalizeList(day.proteinRotationSources);
  if ("seasonalVegetables" in day) day.seasonalVegetables = normalizeList(day.seasonalVegetables);
  if ("fruitOptions" in day) day.fruitOptions = normalizeList(day.fruitOptions);
  if ("proteinRangeGrams" in day) day.proteinRangeGrams = normalizeRange(day.proteinRangeGrams);
  if ("nutritionTargets" in day) day.nutritionTargets = normalizeNutritionTargets(day.nutritionTargets, day.hydrationGuidance);
  if ("mealExamples" in day) day.mealExamples = normalizeMealExamples(day.mealExamples);
  if ("foodReference" in day) day.foodReference = normalizeFoodReference(day.foodReference);
  if ("seasonalPoem" in day) day.seasonalPoem = normalizeSeasonalPoem(day.seasonalPoem);
  // Existing stored plans retain their movement field for compatibility, but
  // newly generated health references never ask the provider for training.
  day.movement = neutralMovementReference();
  return day;
}

export function normalizeProviderHealthPlan(value: unknown): unknown {
  const source = unwrapProviderPlan(value);
  const plan = pickKnown(source, ["overview", "supplements", "days"]);
  if (!plan) return value;
  if (Array.isArray(plan.days)) plan.days = plan.days.map((day) => normalizeDay(isRecord(day) && isRecord(day.content) ? day.content : day));
  else if (isRecord(plan.days)) plan.days = Object.values(plan.days).map((day) => normalizeDay(isRecord(day) && isRecord(day.content) ? day.content : day));
  return plan;
}

function unwrapProviderPlan(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (Object.prototype.hasOwnProperty.call(value, "overview") || Object.prototype.hasOwnProperty.call(value, "days")) return value;
  for (const key of ["plan", "healthPlan", "weeklyPlan", "weekPlan", "data", "result"]) {
    const nested = value[key];
    if (isRecord(nested) && (Object.prototype.hasOwnProperty.call(nested, "overview") || Object.prototype.hasOwnProperty.call(nested, "days"))) return nested;
  }
  return value;
}

function parseProviderJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    if (start < 0) throw new Error("provider_json_missing_object");
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < candidate.length; index += 1) {
      const character = candidate[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') { quoted = true; continue; }
      if (character === "{") depth += 1;
      if (character === "}") {
        depth -= 1;
        if (depth === 0) return JSON.parse(candidate.slice(start, index + 1));
      }
    }
    throw new Error("provider_json_incomplete");
  }
}

function providerText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) {
    const text = value.map((part) => {
      if (typeof part === "string") return part;
      if (isRecord(part) && typeof part.text === "string") return part.text;
      return "";
    }).join("").trim();
    return text || null;
  }
  if (isRecord(value)) return JSON.stringify(value);
  return null;
}

function providerTexts(message: { content?: unknown; reasoning_content?: unknown } | undefined): string[] {
  return Array.from(new Set([
    providerText(message?.content),
    providerText(message?.reasoning_content)
  ].filter((value): value is string => Boolean(value))));
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
  if (issue.message.includes("protein conversion")) return "必须给出鸡蛋、牛肉和鸡胸肉的具体换算";
  if (issue.message.includes("paper cup hydration conversion")) return "必须给出饮水量对应的纸杯数量";
  if (issue.message.includes("fruit options with portions")) return "必须给出至少两种带份量的水果选择";
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
        // A seven-day JSON candidate must be emitted in `content`. Some
        // DeepSeek models otherwise spend the whole output budget in
        // reasoning_content and finish with an empty, truncated answer.
        thinking: { type: "disabled" },
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
              "字段名必须严格遵守软件契约：nutritionTargets 使用 carbohydrateGrams、fatGrams、fiberGrams、hydrationLiters、macroRatioPercent；hydrationGuidance 和 plateGuidance 必须是字符串数组；foodReference 必须使用 proteinOptions、fiberOptions、carbOptions；fruitOptions 必须是水果字符串数组；seasonalPoem 有内容时必须同时返回 title、author、excerpt、relevance。不要使用 calories、proteinFoods、stapleFoods、vegetables 或其他同义字段，也不要返回 movement、exercise、training、workout。",
              "饮食是可执行的参考而非硬性处方：给保守范围、三餐与可选加餐的真实食材示例、当天蛋白来源轮换和替代食材。proteinOptions 必须分别包含带数字的鸡蛋、牛肉、鸡胸肉换算，例如目标蛋白质约等于多少个鸡蛋、多少克牛肉、多少克鸡胸肉；hydrationGuidance 必须包含带数字的常见纸杯换算，例如 2.5L 水约等于多少个纸杯，并注明只是估算，不要求精确照做。",
              "fruitOptions 每天必须给出至少两种具体水果和建议份量，例如 1 个苹果、200 克草莓；水果独立于正餐和蔬菜展示。优先建议从水果和日常食物获取自然营养，补充剂只用于饮食难以覆盖或用户明确考虑的部分。不得要求打卡，不得把示例写成必须执行。缺少精确资料时必须在 overview 或 nutritionDirection 说明假设。",
              "蛋白质、碳水、脂肪、纤维和饮水使用每日参考范围；hydrationGuidance 给出可选择的分时饮水参考、运动前后调整和避免一次性大量饮水的提示，不计算用户实际饮水量。三大营养素比例总和约为 100。mealExamples 只写正餐与可选加餐的组合，不生成训练计划，不计算用户实际已摄入量，不伪装成完成进度。",
              "用户自己管理训练。不得生成、概括或调整训练计划、动作清单、运动任务、训练时长、强度、重量、配速或排期；也不要在 overview、nutritionDirection、mealExamples、supplements 中夹带这些内容。",
              "不把建议写成任务，不要求反馈，不自动改变用户资料。",
              "当输入包含 sleepAnalysis 时，它是用户主动要求的单次修订依据：只使用其中非空、可见的指标生成候选，不诊断睡眠问题，不将一次记录写成长期结论，也不自动改变任何现有周计划。",
              "节气内容只作为传统饮食文化和时令提示，不做中医体质诊断或治疗宣称。",
              "weather 只在系统真实取得天气预报时出现；缺失时不得编造天气。可根据温度、降水概率和天气代码给出简短、可选择的出行或活动提示。",
              "seasonalPoem 只能选择确有把握的真实古诗词短句；作者、篇名或原句不确定时必须返回 null，禁止杜撰。excerpt 保持简短，relevance 只解释与当天时令或天气的联系。",
              "supplements 只围绕用户资料与饮食场景给补充剂建议，可分别考虑维生素 C、钙、锌、鱼油等类别，先说明哪些营养更适合通过水果、蔬菜、奶类、鱼类等自然食物获得，再写标签、服用时机和成分重复的注意事项；不提供确定剂量、不自动加入肌酸，也不替用户做医疗判断。",
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
    const message = result.choices?.[0]?.message;
    const contents = providerTexts(message);
    if (contents.length === 0) throw new HealthPlanningOutputError("没有返回可用的健康候选内容");
    let lastOutputError: HealthPlanningOutputError | null = null;
    for (const content of contents) {
      let parsed: unknown;
      try {
        parsed = parseProviderJson(content);
      } catch {
        lastOutputError = new HealthPlanningOutputError("返回的 JSON 不完整或格式损坏");
        continue;
      }
      const validated = generatedHealthPlanContentSchema.safeParse(normalizeProviderHealthPlan(parsed));
      if (validated.success) return validated.data;
      lastOutputError = validationOutputError(validated.error.issues);
    }
    throw lastOutputError ?? new HealthPlanningOutputError("没有返回可用的健康候选内容");
  }
}
