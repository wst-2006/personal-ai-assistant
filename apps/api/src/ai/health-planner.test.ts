import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeepSeekConfig } from "./config.js";
import { DeepSeekHealthPlanner, HealthPlanningOutputError } from "./health-planner.js";

const config: DeepSeekConfig = {
  DEEPSEEK_API_KEY: "test-key",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  DEEPSEEK_MODEL: "deepseek-v4-flash",
  DEEPSEEK_TIMEOUT_MS: 30_000,
  DEEPSEEK_MAX_RETRIES: 0,
  DEEPSEEK_MAX_OUTPUT_TOKENS: 4_096,
  DEEPSEEK_USER_CONTEXT_MAX_CHARS: 0
};

const generatedDay = {
  nutritionDirection: "按普通健康成年人的保守参考范围安排，不把食物示例当成必须执行的菜单。",
  proteinRangeGrams: { minimum: 90, maximum: 120 },
  nutritionTargets: {
    carbohydrateGrams: { minimum: 200, maximum: 260 },
    fatGrams: { minimum: 50, maximum: 70 },
    fiberGrams: { minimum: 25, maximum: 30 },
    hydrationLiters: { minimum: 2, maximum: 2.5 },
    macroRatioPercent: { protein: 25, carbohydrate: 50, fat: 25 }
  },
  hydrationGuidance: ["2.5L 水约等于 10 个 250ml 纸杯，只是便于理解的估算。", "起床后和三餐之间分散补水。"],
  mealExamples: { breakfast: ["鸡蛋与燕麦"], lunch: ["牛肉、米饭和蔬菜"], dinner: ["鸡肉、南瓜和绿叶菜"], snack: ["无糖酸奶"] },
  proteinRotationSources: ["鸡蛋", "牛肉"],
  foodReference: {
    proteinOptions: ["约 15 个鸡蛋可提供接近目标量的蛋白质", "约 650 克牛肉可提供接近目标量的蛋白质", "约 550 克鸡胸肉可提供接近目标量的蛋白质"],
    fiberOptions: ["燕麦", "蔬菜"],
    carbOptions: ["米饭", "土豆"]
  },
  fruitOptions: ["1 个苹果", "200 克草莓"],
  plateGuidance: ["每餐包含一种主要蛋白质来源。"],
  seasonalVegetables: ["番茄"],
  seasonalGuidance: null,
  seasonalPoem: null,
  movement: {
    category: "recovery",
    durationMinutes: { minimum: 30, maximum: 45 },
    intensity: "low",
    highIntensity: false,
    safetyReminder: "以舒适为限。",
    focus: ["轻量活动", "收操拉伸"],
    safetyNotes: ["出现不适时停止并调整。"]
  }
};

const input = {
  profile: {
    city: "杭州",
    basics: { sex: "other" as const, age: 30, heightCm: 170, weightKg: 65, bodyFatPercent: null, waistCm: null },
    goals: ["稳定体能"],
    stageWeightGoal: { minimumKg: 63, maximumKg: 67 },
    considerations: [],
    activity: { sessionsPerWeek: 4, usualDurationMinutes: { minimum: 45, maximum: 75 }, preferredActivities: ["力量训练"], avoidHighRisk: true },
    food: { mealContext: "在家和外卖交替", mealTimes: { breakfast: "08:00", lunch: "12:30", dinner: "19:00" }, dislikes: [], commonFoods: ["鸡蛋", "米饭", "蔬菜"] },
    supplements: { current: [], considering: [], avoids: [] },
    notes: null
  },
  weekStart: "2099-08-09",
  solarTerm: "立秋",
  scheduledActivities: [],
  specialContext: null,
  sleepAnalysis: null,
  weather: null
};

afterEach(() => vi.unstubAllGlobals());

describe("DeepSeekHealthPlanner", () => {
  it("requests a complete executable reference candidate without task-writing authority", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ overview: "本周保持可执行、保守的参考。", supplements: ["查看标签，避免重复成分。"], days: Array.from({ length: 7 }, () => generatedDay) }) } }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const plan = await new DeepSeekHealthPlanner(config).plan(input);
    expect(plan.days[0]).toMatchObject({
      nutritionTargets: { hydrationLiters: { minimum: 2, maximum: 2.5 } },
      hydrationGuidance: ["2.5L 水约等于 10 个 250ml 纸杯，只是便于理解的估算。", "起床后和三餐之间分散补水。"],
      mealExamples: { breakfast: ["鸡蛋与燕麦"] },
      fruitOptions: ["1 个苹果", "200 克草莓"],
      movement: { category: "rest", durationMinutes: { minimum: 0, maximum: 0 } }
    });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    const body = JSON.parse(String(options.body)) as { max_tokens: number; response_format: { type: string }; thinking: { type: string }; messages: Array<{ content: string }> };
    expect(body).toMatchObject({ max_tokens: 8_192, response_format: { type: "json_object" }, thinking: { type: "disabled" } });
    expect(body.messages[0]?.content).toContain("mealExamples");
    expect(body.messages[0]?.content).toContain("hydrationGuidance");
    expect(body.messages[0]?.content).toContain("不得增加 day、date、weekday");
    expect(body.messages[0]?.content).toContain("不要返回 movement");
    expect(body.messages[0]?.content).toContain("不把建议写成任务");
    expect(body.messages[0]?.content).toContain("不计算用户实际已摄入量");
  });

  it("normalizes harmless provider formatting without spending a second request", async () => {
    const noisyDay = {
      ...generatedDay,
      date: "2099-08-09",
      nutritionTargets: {
        ...generatedDay.nutritionTargets,
        carbohydrateGrams: { minimum: "200", maximum: "260" },
        macroRatioPercent: { protein: "22.5", carbohydrate: "52.5", fat: "25" },
        providerNote: "not part of the contract"
      },
      movement: {
        ...generatedDay.movement,
        category: "散步",
        intensity: "medium",
        highIntensity: "false",
        providerNote: "not part of the contract"
      }
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: `\`\`\`json\n${JSON.stringify({
        overview: "本周采用保守参考。",
        supplements: ["查看标签，避免重复成分。"],
        days: Array.from({ length: 7 }, () => noisyDay),
        generatedAt: "2099-08-09T00:00:00Z"
      })}\n\`\`\`` } }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const plan = await new DeepSeekHealthPlanner(config).plan(input);

    expect(plan.days[0]?.movement).toMatchObject({ category: "rest", intensity: "rest", highIntensity: false });
    expect(plan.days[0]?.nutritionTargets?.macroRatioPercent).toEqual({ protein: 22.5, carbohydrate: 52.5, fat: 25 });
    expect(plan.days[0]).not.toHaveProperty("date");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps semantically equivalent health fields into the display contract", async () => {
    const providerDay = {
      nutritionDirection: generatedDay.nutritionDirection,
      proteinRangeGrams: generatedDay.proteinRangeGrams,
      nutritionTargets: {
        calories: { minimum: 2400, maximum: 2800 },
        carbohydrateGrams: { minimum: 300, maximum: 350 },
        fatGrams: { minimum: 60, maximum: 80 },
        fiberGrams: { minimum: 25, maximum: 35 },
        macroRatioPercent: { protein: 25, carbohydrate: 50, fat: 25 }
      },
      hydrationGuidance: "全天分次饮水，总量 2.5-3L，约等于 10-12 个 250ml 纸杯。",
      mealExamples: generatedDay.mealExamples,
      proteinRotationSources: generatedDay.proteinRotationSources,
      foodReference: {
        proteinFoods: ["约 15 个鸡蛋", "约 650 克牛肉", "约 550 克鸡胸肉"],
        stapleFoods: ["米饭"],
        vegetables: ["番茄"]
      },
      seasonalFruits: ["1 个苹果", "200 克草莓"],
      plateGuidance: "餐盘一半蔬菜，四分之一蛋白质，四分之一主食。",
      seasonalVegetables: generatedDay.seasonalVegetables,
      seasonalGuidance: "立秋后暑热未消，饮食保持清淡多样。",
      seasonalPoem: { excerpt: "自古逢秋悲寂寥，我言秋日胜春朝。", author: "刘禹锡", relevance: "立秋时节适合调整作息。" },
      movement: {
        category: "strength",
        durationMinutes: { minimum: 120, maximum: 120 },
        intensity: "moderate",
        focus: ["胸背训练"],
        safetyNotes: ["训练前充分热身。"]
      }
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ overview: "同义字段候选。", supplements: ["查看标签。"], days: Array.from({ length: 7 }, () => providerDay) }) } }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const plan = await new DeepSeekHealthPlanner(config).plan(input);
    expect(plan.days[0]).toMatchObject({
      hydrationGuidance: ["全天分次饮水，总量 2.5-3L，约等于 10-12 个 250ml 纸杯。"],
      nutritionTargets: { hydrationLiters: { minimum: 2.5, maximum: 3 } },
      foodReference: { proteinOptions: ["约 15 个鸡蛋", "约 650 克牛肉", "约 550 克鸡胸肉"], fiberOptions: ["番茄"], carbOptions: ["米饭"] },
      fruitOptions: ["1 个苹果", "200 克草莓"],
      plateGuidance: ["餐盘一半蔬菜，四分之一蛋白质，四分之一主食。"],
      seasonalPoem: { title: "秋词", author: "刘禹锡" },
      movement: { category: "rest", durationMinutes: { minimum: 0, maximum: 0 }, highIntensity: false }
    });
  });

  it("reads wrapped plans and JSON embedded in provider text or reasoning content", async () => {
    const payload = { plan: { overview: "包装后的候选。", supplements: ["查看标签。"], days: Array.from({ length: 7 }, () => generatedDay) } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: null, reasoning_content: `已整理完成：\n${JSON.stringify(payload)}` } }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DeepSeekHealthPlanner(config).plan(input)).resolves.toMatchObject({ overview: "包装后的候选。" });
  });

  it("falls back to reasoning content when the visible message is only an explanation", async () => {
    const payload = { overview: "从推理内容恢复的候选。", supplements: ["查看标签。"], days: Array.from({ length: 7 }, () => generatedDay) };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "已根据本周情况整理完成。", reasoning_content: JSON.stringify(payload) } }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DeepSeekHealthPlanner(config).plan(input)).resolves.toMatchObject({ overview: "从推理内容恢复的候选。" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a provider response that omits the new executable fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        overview: "缺少可执行字段的旧式输出。",
        supplements: ["查看标签。"],
        days: Array.from({ length: 7 }, () => ({
          nutritionDirection: generatedDay.nutritionDirection,
          proteinRangeGrams: generatedDay.proteinRangeGrams,
          plateGuidance: generatedDay.plateGuidance,
          seasonalVegetables: generatedDay.seasonalVegetables,
          movement: { category: "recovery", durationMinutes: { minimum: 20, maximum: 30 }, intensity: "low", highIntensity: false, safetyReminder: "以舒适为限。" }
        }))
      }) } }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await new DeepSeekHealthPlanner(config).plan(input).catch((caught) => caught);
    expect(error).toBeInstanceOf(HealthPlanningOutputError);
    expect((error as HealthPlanningOutputError).validationIssues).toContainEqual({ path: "days.0.nutritionTargets", reason: "缺少必填字段" });
    expect((error as HealthPlanningOutputError).userMessage).toContain("第 1 天");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps unsafe numeric contradictions blocked and does not auto-repair or retry them", async () => {
    const invalidDay = {
      ...generatedDay,
      nutritionTargets: {
        ...generatedDay.nutritionTargets,
        macroRatioPercent: { protein: 20, carbohydrate: 20, fat: 20 }
      }
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        overview: "比例相互矛盾。",
        supplements: ["查看标签。"],
        days: Array.from({ length: 7 }, () => invalidDay)
      }) } }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await new DeepSeekHealthPlanner({ ...config, DEEPSEEK_MAX_RETRIES: 5 }).plan(input).catch((caught) => caught);

    expect(error).toBeInstanceOf(HealthPlanningOutputError);
    expect((error as HealthPlanningOutputError).validationIssues).toContainEqual({ path: "days.0.nutritionTargets.macroRatioPercent", reason: "三项比例合计必须接近 100%" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a timed-out generation that may already have consumed tokens", async () => {
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DeepSeekHealthPlanner({ ...config, DEEPSEEK_MAX_RETRIES: 5 }).plan(input)).rejects.toThrow("DeepSeek health planning timed out.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries an explicit transient provider response at most once", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "busy" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ overview: "重试成功。", supplements: ["查看标签并避免重复成分。"], days: Array.from({ length: 7 }, () => generatedDay) }) } }]
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DeepSeekHealthPlanner({ ...config, DEEPSEEK_MAX_RETRIES: 5 }).plan(input)).resolves.toMatchObject({ overview: "重试成功。" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
