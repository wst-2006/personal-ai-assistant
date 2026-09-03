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
  city: "示例城市",
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
      messages: [{ role: "user", content: "本周想让饮食更规律，并说明需要注意的限制。" }]
    });

    expect(result).toEqual({ content: "我已记下训练与作息安排。请确认是否有医生要求限制饮水。", needsClarification: true });
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(request.body)) as { thinking?: { type: string }; messages: Array<{ role: string; content: string }> };
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.messages[0]?.content).toContain("不得诊断、开药、解释中药药性");
    expect(body.messages[0]?.content).toContain("不要创建任务、修改计划");
    expect(body.messages[1]).toEqual({ role: "user", content: "本周想让饮食更规律，并说明需要注意的限制。" });
  });

  it("retries a transient provider failure before exposing a missing reply", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ reply: "已记下。", needsClarification: false }) } }]
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DeepSeekHealthConversationResponder({ ...config, DEEPSEEK_MAX_RETRIES: 1 }).reply({
      weekStart: "2026-08-16",
      profile,
      activePlan: null,
      messages: [{ role: "user", content: "本周想让饮食更规律。" }]
    })).resolves.toEqual({ content: "已记下。", needsClarification: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts JSON returned in reasoning_content when content is empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: null, reasoning_content: `整理如下：\n\`\`\`json\n${JSON.stringify({ reply: "已记下本周安排。", needsClarification: false })}\n\`\`\`` } }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DeepSeekHealthConversationResponder(config).reply({
      weekStart: "2026-08-16",
      profile,
      activePlan: null,
      messages: [{ role: "user", content: "本周想让饮食更规律。" }]
    })).resolves.toEqual({ content: "已记下本周安排。", needsClarification: false });
  });

  it("retries an empty JSON response within the same send", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ reply: "已记下。", needsClarification: false }) } }]
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DeepSeekHealthConversationResponder({ ...config, DEEPSEEK_MAX_RETRIES: 1 }).reply({
      weekStart: "2026-08-16",
      profile,
      activePlan: null,
      messages: [{ role: "user", content: "本周想让饮食更规律。" }]
    })).resolves.toEqual({ content: "已记下。", needsClarification: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
