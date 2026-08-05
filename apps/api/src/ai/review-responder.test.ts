import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekReviewResponder } from "./review-responder.js";
import type { DeepSeekConfig } from "./config.js";

const config: DeepSeekConfig = {
  DEEPSEEK_API_KEY: "test-key",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  DEEPSEEK_MODEL: "deepseek-v4-flash",
  DEEPSEEK_VISION_MODEL: undefined,
  DEEPSEEK_TIMEOUT_MS: 30_000,
  DEEPSEEK_MAX_RETRIES: 0,
  DEEPSEEK_MAX_OUTPUT_TOKENS: 1_200,
  DEEPSEEK_USER_CONTEXT_MAX_CHARS: 6_000,
};

afterEach(() => vi.unstubAllGlobals());

describe("DeepSeekReviewResponder", () => {
  it("sends an explicit bounded daily-review context without granting write authority", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "可以先确认今天已经留下的进展，再决定明天的承接动作。" } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const reply = await new DeepSeekReviewResponder(config).reply({
      localDate: "2026-08-05",
      messages: [{ role: "user", content: "今天完成了主要部分。" }],
      context: {
        tasks: [{ id: "task-1", title: "完成报告", lifecycleStatus: "closed", startAt: null, endAt: null, notes: null }],
        outcomes: [{ taskId: "task-1", outcome: "partial", progressPercent: 80, note: null }],
        focusSessions: [{ taskId: "task-1", state: "evaluated", rawActiveSeconds: 3_600, effectiveFocusSeconds: 3_000 }],
        feedback: [{ taskId: "task-1", satisfaction: "satisfied", note: "节奏合适" }],
        conversationMessages: [{ role: "user", content: "今天调整过顺序" }],
      },
    });

    expect(reply).toContain("明天的承接动作");
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    const body = JSON.parse(String(options.body));
    expect(body.messages[0].content).toContain("daily_review 模式");
    expect(body.messages[0].content).toContain("没有创建、修改、移动、取消或关闭任务的权限");
    expect(body.messages[0].content).toContain("完成报告");
    expect(body.messages[0].content).toContain("不生成每日简报或赛博日记");
  });
});
