import { describe, expect, it } from "vitest";
import { personalContextInstruction } from "./user-context.js";

describe("personalContextInstruction", () => {
  it("omits user-authored context when sharing is disabled", async () => {
    const instruction = await personalContextInstruction({
      async getAiContext() { return null; }
    }, 6_000);

    expect(instruction).toBe("");
  });

  it("keeps user context bounded and makes product rules higher priority", async () => {
    const instruction = await personalContextInstruction({
      async getAiContext(maxCharacters) {
        expect(maxCharacters).toBe(12);
        return {
          personalContext: "主动输入的背景",
          aiGuidance: "先给框架",
          responseStyle: "concise" as const
        };
      }
    }, 12);

    expect(instruction).toContain("用户主动保存并允许本次发送给 AI");
    expect(instruction).toContain("回复详略偏好：简洁");
    expect(instruction).toContain("当前任务的结构化输出规则、安全边界和用户本次明确请求优先");
  });
});
