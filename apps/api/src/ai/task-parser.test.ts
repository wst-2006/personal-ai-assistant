import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekTaskParser } from "./task-parser.js";
import type { DeepSeekConfig } from "./config.js";

const config: DeepSeekConfig = {
  DEEPSEEK_API_KEY: "test-key",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  DEEPSEEK_MODEL: "deepseek-v4-flash",
  DEEPSEEK_VISION_MODEL: undefined,
  DEEPSEEK_TIMEOUT_MS: 30_000,
  DEEPSEEK_MAX_RETRIES: 2,
  DEEPSEEK_MAX_OUTPUT_TOKENS: 1_200,
  DEEPSEEK_USER_CONTEXT_MAX_CHARS: 6_000
};

const request = {
  text: "明天上午九点到十点半复习微观经济学消费者理论",
  referenceDate: "2026-08-03",
  timeZone: "Asia/Shanghai"
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DeepSeekTaskParser", () => {
  it("uses the configured OpenAI-compatible endpoint and validates a JSON candidate", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            title: "复习微观经济学消费者理论",
            entryType: "task",
            date: "2026-08-04",
            startAt: "2026-08-04T09:00:00+08:00",
            endAt: "2026-08-04T10:30:00+08:00",
            schedulePrecision: "exact",
            notes: null,
            missingFields: []
          })
        }
      }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const candidate = await new DeepSeekTaskParser(config).parse(request);

    expect(candidate.title).toBe("复习微观经济学消费者理论");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(options.headers).toMatchObject({ authorization: "Bearer test-key" });
    expect(JSON.parse(String(options.body))).toMatchObject({
      model: "deepseek-v4-flash",
      response_format: { type: "json_object" }
    });
  });

  it("keeps the provider's safe error message and does not retry a permanent 400", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: "Unsupported request parameter: response_format" }
    }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DeepSeekTaskParser(config).parse(request)).rejects.toThrow(
      "DeepSeek returned HTTP 400: Unsupported request parameter: response_format"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
