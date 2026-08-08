import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekConversationResponder } from "./conversation-responder.js";
import type { DeepSeekConfig } from "./config.js";

const config: DeepSeekConfig = {
  DEEPSEEK_API_KEY: "test-key",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  DEEPSEEK_MODEL: "deepseek-v4-flash",
  DEEPSEEK_TIMEOUT_MS: 30_000,
  DEEPSEEK_MAX_RETRIES: 0,
  DEEPSEEK_MAX_OUTPUT_TOKENS: 1_200,
  DEEPSEEK_USER_CONTEXT_MAX_CHARS: 6_000
};

afterEach(() => vi.unstubAllGlobals());

describe("DeepSeekConversationResponder", () => {
  it("keeps the request server-side, bounded, and free of task-writing authority", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "先看清你想保留的安排，再决定下一步。" } }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const reply = await new DeepSeekConversationResponder(config).reply({
      localDate: "2026-08-03",
      messages: Array.from({ length: 20 }, (_, index) => ({ role: index % 2 === 0 ? "user" as const : "assistant" as const, content: `第 ${index} 条消息 ${"x".repeat(1_000)}` }))
    });

    expect(reply).toBe("先看清你想保留的安排，再决定下一步。");
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(options.headers).toMatchObject({ authorization: "Bearer test-key" });
    const body = JSON.parse(String(options.body));
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.messages[0].content).toContain("没有创建、修改、移动、取消或关闭任务的权限");
    expect(body.messages.slice(1).reduce((sum: number, message: { content: string }) => sum + message.content.length, 0)).toBeLessThanOrEqual(12_000);
  });
});
