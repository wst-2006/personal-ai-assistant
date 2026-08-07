import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeepSeekConfig } from "./config.js";
import { DeepSeekLongRangeTaskTreePlanner } from "./long-range-task-tree-planner.js";

const config: DeepSeekConfig = {
  DEEPSEEK_API_KEY: "test-key",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  DEEPSEEK_MODEL: "deepseek-v4-flash",
  DEEPSEEK_VISION_MODEL: undefined,
  DEEPSEEK_TIMEOUT_MS: 30_000,
  DEEPSEEK_MAX_RETRIES: 0,
  DEEPSEEK_MAX_OUTPUT_TOKENS: 1_200,
  DEEPSEEK_USER_CONTEXT_MAX_CHARS: 6_000
};

afterEach(() => vi.unstubAllGlobals());

describe("DeepSeekLongRangeTaskTreePlanner", () => {
  it("requests bounded JSON-only framework candidates without task-writing authority", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        summary: "先确定范围，再形成阶段成果。",
        tasks: [{ title: "确定范围", targetDate: "2099-08-10", notes: null }]
      }) } }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const proposal = await new DeepSeekLongRangeTaskTreePlanner(config).plan({
      title: "研究准备",
      periodStart: "2099-08-01",
      periodEnd: "2099-08-31",
      description: "框架级规划",
      milestones: [],
      instructions: "不要拆成知识点"
    });

    expect(proposal.tasks).toHaveLength(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    const body = JSON.parse(String(options.body));
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.messages[0].content).toContain("不创建任何任务");
    expect(body.messages[0].content).toContain("不要输出时间段");
  });

  it("rejects provider failures for the service to translate into a recoverable API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream unavailable", { status: 503 })));
    await expect(new DeepSeekLongRangeTaskTreePlanner(config).plan({
      title: "研究准备", periodStart: "2099-08-01", periodEnd: "2099-08-31", description: null, milestones: [], instructions: null
    })).rejects.toThrow("DeepSeek returned HTTP 503");
  });
});
