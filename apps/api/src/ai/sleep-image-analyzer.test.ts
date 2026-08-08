import { describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleSleepImageAnalyzer } from "./sleep-image-analyzer.js";
import type { VisionConfig } from "./vision-config.js";

const config: VisionConfig = {
  VISION_API_KEY: "vision-test-key",
  VISION_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  VISION_MODEL: "qwen3-vl-flash",
  VISION_TIMEOUT_MS: 30_000,
  VISION_MAX_RETRIES: 2,
  VISION_MAX_OUTPUT_TOKENS: 1_200
};

describe("OpenAiCompatibleSleepImageAnalyzer", () => {
  it("sends only the screenshot context to the separately configured vision provider", async () => {
    const analysis = {
      totalSleepMinutes: 438,
      deepSleepMinutes: 96,
      lightSleepMinutes: 247,
      remSleepMinutes: 95,
      awakeCount: 2,
      sleepStart: "23:18",
      wakeTime: "06:36",
      deviceScore: 82,
      deviceNotes: "设备显示睡眠评分良好",
      visibleMetrics: ["总睡眠 7 小时 18 分钟", "深睡 1 小时 36 分钟"],
      interpretation: ["截图显示的总睡眠时长为 438 分钟。"],
      limitations: ["仅基于这张截图中可见的信息，不能替代专业医疗建议"]
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(analysis)}\n\`\`\`` } }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(new OpenAiCompatibleSleepImageAnalyzer(config).analyze({
        localDate: "2026-08-03",
        fileName: "sleep.png",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,iVBORw0KGgo="
      })).resolves.toEqual(analysis);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
      expect(options.headers).toMatchObject({ authorization: "Bearer vision-test-key" });
      const body = JSON.parse(String(options.body));
      expect(body.model).toBe("qwen3-vl-flash");
      expect(body).not.toHaveProperty("response_format");
      expect(body.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } });
      expect(body.messages[0].content).not.toContain("个人背景");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not retry a non-recoverable provider request error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(new OpenAiCompatibleSleepImageAnalyzer(config).analyze({
        localDate: "2026-08-03",
        fileName: "sleep.png",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,iVBORw0KGgo="
      })).rejects.toThrow("Vision provider returned HTTP 400");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
