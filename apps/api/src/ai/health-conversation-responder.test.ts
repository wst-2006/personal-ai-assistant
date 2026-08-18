import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeepSeekConfig } from "./config.js";
import { DeepSeekHealthConversationResponder } from "./health-conversation-responder.js";

const config: DeepSeekConfig = {
  DEEPSEEK_API_KEY: "test-key",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  DEEPSEEK_MODEL: "deepseek-v4-flash",
  DEEPSEEK_TIMEOUT_MS: 30_000,
  DEEPSEEK_MAX_RETRIES: 2,
  DEEPSEEK_MAX_OUTPUT_TOKENS: 4_096,
  DEEPSEEK_USER_CONTEXT_MAX_CHARS: 0
};

const profile = {
  city: "呼和浩特",
  basics: { sex: "other" as const, age: 30, heightCm: 170, weightKg: 65, bodyFatPercent: null, waistCm: null },
  goals: ["规律作息"],
  stageWeightGoal: { minimumKg: 63, maximumKg: 67 },
  considerations: ["正在按医嘱服用中药"],
  activity: { sessionsPerWeek: 6, usualDurationMinutes: { minimum: 60, maximum: 120 }, preferredActivities: ["力量训练", "有氧"], avoidHighRisk: true },
  food: { mealContext: "日常饮食", mealTimes: { breakfast: "08:00", lunch: "12:30", dinner: "19:00" }, dislikes: [], commonFoods: ["米饭", "鸡蛋", "蔬菜"] },
  supplements: { current: ["益生菌", "菊粉"], considering: [], avoids: [] },
  notes: null
};

afterEach(() => vi.unstubAllGlobals());

describe("DeepSeekHealthConversationResponder", () => {
  it("clarifies inside the health context without claiming to change a plan", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ reply: "我已记下训练与作息安排。请确认是否有医生要求限制饮水。", needsClarification: true }) } }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new DeepSeekHealthConversationResponder(config).reply({
      weekStart: "2026-08-16",
      profile,
      activePlan: null,
      messages: [{ role: "user", content: "本周三次力量、三次有氧，最近在喝中药。" }]
    });

    expect(result).toEqual({ content: "我已记下训练与作息安排。请确认是否有医生要求限制饮水。", needsClarification: true });
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(request.body)) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]?.content).toContain("不得诊断、开药、解释中药药性");
    expect(body.messages[0]?.content).toContain("不要创建任务、修改计划");
    expect(body.messages[1]).toEqual({ role: "user", content: "本周三次力量、三次有氧，最近在喝中药。" });
  });
});
