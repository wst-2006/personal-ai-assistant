import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeepSeekConfig } from "./config.js";
import { DeepSeekBriefWriter } from "./brief-writer.js";

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

describe("DeepSeekBriefWriter", () => {
  it("creates a grounded structured brief without task-writing authority", async () => {
    const generated = {
      title: "2026-08-06 的每日简报",
      reflection: "今天完成了复盘，并保留了仍需调整的部分。",
      taskSummary: "当天安排两项任务，完成一项。",
      encouragement: "留下记录，明天就有可继续的起点。"
    };
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      const request = JSON.parse(String(options?.body));
      const isSection = String(request.messages[0].content).includes("资料编辑器");
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(isSection ? { body: "市场信息来自所给资料。" } : generated) } }]
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new DeepSeekBriefWriter(config).write({
      localDate: "2026-08-06",
      titleHint: "2026-08-06 的每日简报",
      reflection: "用户复盘",
      taskSummary: "当天任务摘要",
      searches: [
        { key: "finance", title: "金融", results: [{ title: "可靠标题", description: "可靠摘要", url: "https://example.com/finance" }] },
        { key: "ai", title: "AI", results: [] },
        { key: "technology", title: "大数据与科技", results: [] },
        { key: "taskExpansion", title: "任务相关拓展", results: [] },
        { key: "humanities", title: "历史／人文／社会", results: [] }
      ]
    });

    expect(result.sections).toHaveLength(6);
    expect(result.sections.at(-1)).toEqual({ key: "encouragement", body: generated.encouragement });
    expect(result.sections.find((section) => section.key === "finance")?.body).toBe("市场信息来自所给资料。");
    expect(result.sections.find((section) => section.key === "ai")?.body).toBe("暂无可靠资料。");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const overviewCall = fetchMock.mock.calls[0] as [string, RequestInit];
    const sectionCall = fetchMock.mock.calls[1] as [string, RequestInit];
    const [url, options] = overviewCall;
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    const body = JSON.parse(String(options.body));
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.messages[0].content).toContain("不创建、修改、移动、取消或关闭任务");
    expect(body.max_tokens).toBe(700);
    const sectionBody = JSON.parse(String(sectionCall[1].body));
    expect(sectionBody.messages[0].content).toContain("不得补充未提供的事实、数字、人物或来源");
    expect(sectionBody.messages[1].content).toContain("可靠标题");
    expect(sectionBody.messages[1].content).not.toContain("https://example.com/finance");
    expect(sectionBody.max_tokens).toBe(320);
  });

  it("rejects incomplete model output instead of persisting a false brief", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ title: "不完整" }) } }]
    }), { status: 200 })));

    await expect(new DeepSeekBriefWriter(config).write({
      localDate: "2026-08-06",
      titleHint: "每日简报",
      reflection: "复盘",
      taskSummary: "任务",
      searches: []
    })).rejects.toThrow();
  });
});
