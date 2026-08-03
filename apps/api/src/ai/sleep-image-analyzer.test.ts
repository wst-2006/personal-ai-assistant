import { describe, expect, it, vi } from "vitest";
import { DeepSeekSleepImageAnalyzer } from "./sleep-image-analyzer.js";
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

describe("DeepSeekSleepImageAnalyzer", () => {
  it("does not send an image to an unconfigured or unverified provider model", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(new DeepSeekSleepImageAnalyzer(config).analyze({
        localDate: "2026-08-03",
        fileName: "sleep.png",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,iVBORw0KGgo="
      })).rejects.toThrow("DEEPSEEK_VISION_MODEL is not configured");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
