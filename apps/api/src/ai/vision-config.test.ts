import { describe, expect, it } from "vitest";
import { loadVisionConfig } from "./vision-config.js";

describe("vision provider configuration", () => {
  it("keeps image analysis disabled when no separate API key is configured", () => {
    expect(loadVisionConfig({})).toBeNull();
  });

  it("uses the mainland Model Studio defaults while allowing provider replacement", () => {
    expect(loadVisionConfig({ VISION_API_KEY: "test-key" })).toEqual({
      VISION_API_KEY: "test-key",
      VISION_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      VISION_MODEL: "qwen3.7-flash",
      VISION_TIMEOUT_MS: 30_000,
      VISION_MAX_RETRIES: 2,
      VISION_MAX_OUTPUT_TOKENS: 1_200
    });
    expect(loadVisionConfig({
      VISION_API_KEY: "other-key",
      VISION_BASE_URL: "https://vision.example.com/v1",
      VISION_MODEL: "other-vision-model"
    })).toMatchObject({
      VISION_API_KEY: "other-key",
      VISION_BASE_URL: "https://vision.example.com/v1",
      VISION_MODEL: "other-vision-model"
    });
  });
});
