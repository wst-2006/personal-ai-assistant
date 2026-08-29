import { describe, expect, it } from "vitest";
import { loadDeepSeekConfig } from "./config.js";

const baseEnvironment = {
  DEEPSEEK_API_KEY: "test-key",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  DEEPSEEK_MODEL: "deepseek-v4-flash"
};

describe("DeepSeek configuration", () => {
  it("keeps the vision model optional so the documented default can be used", () => {
    expect(loadDeepSeekConfig(baseEnvironment)).toMatchObject({
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_MODEL: "deepseek-v4-flash"
    });
    expect(loadDeepSeekConfig(baseEnvironment).DEEPSEEK_VISION_MODEL).toBeUndefined();
  });

  it("accepts an explicitly configured DeepSeek vision model", () => {
    expect(loadDeepSeekConfig({
      ...baseEnvironment,
      DEEPSEEK_VISION_MODEL: "deepseek-v4-flash-vision-exp"
    }).DEEPSEEK_VISION_MODEL).toBe("deepseek-v4-flash-vision-exp");
  });
});
