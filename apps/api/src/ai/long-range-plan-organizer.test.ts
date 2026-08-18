import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeepSeekConfig } from "./config.js";
import { DeepSeekLongRangePlanOrganizer } from "./long-range-plan-organizer.js";

const config: DeepSeekConfig = {
  DEEPSEEK_API_KEY: "test-key",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  DEEPSEEK_MODEL: "deepseek-v4-pro",
  DEEPSEEK_TIMEOUT_MS: 5_000,
  DEEPSEEK_MAX_RETRIES: 0,
  DEEPSEEK_MAX_OUTPUT_TOKENS: 1_200,
  DEEPSEEK_USER_CONTEXT_MAX_CHARS: 0
};

afterEach(() => vi.unstubAllGlobals());

describe("DeepSeekLongRangePlanOrganizer", () => {
  it("returns a visible candidate only and removes milestone dates outside the plan period", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        title: "整理后的研究主线",
        description: "保留原始目标与现实边界的候选说明。",
        milestones: [
          { title: "确认资料范围", targetDate: "2099-04-10", notes: "先确认来源" },
          { title: "越界节点", targetDate: "2099-05-10", notes: null }
        ]
      }) } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const candidate = await new DeepSeekLongRangePlanOrganizer(config).organize({
      scope: "month",
      title: "我的原始标题",
      periodStart: "2099-04-01",
      periodEnd: "2099-04-30",
      description: "这是用户自己写的目标和边界。",
      milestones: []
    });

    expect(candidate).toMatchObject({
      title: "整理后的研究主线",
      milestones: [
        { title: "确认资料范围", targetDate: "2099-04-10" },
        { title: "越界节点", targetDate: null }
      ]
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      model: string;
      thinking: { type: string };
      response_format: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(request).toMatchObject({
      model: "deepseek-v4-pro",
      thinking: { type: "disabled" },
      response_format: { type: "json_object" }
    });
    expect(request.messages[0]?.content).toContain("只返回可编辑候选，不保存、不创建任务、不调整时间轴");
  });
});
