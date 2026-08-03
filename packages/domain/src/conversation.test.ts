import { describe, expect, it } from "vitest";
import { conversationDateSchema, conversationMessageInputSchema } from "./conversation.js";

describe("conversation contract", () => {
  it("accepts a bounded user-authored message", () => {
    expect(conversationDateSchema.safeParse("2026-08-03").success).toBe(true);
    expect(conversationMessageInputSchema.parse({ content: "请帮我理清今天的安排。" })).toEqual({ content: "请帮我理清今天的安排。" });
  });

  it("rejects empty and oversized messages", () => {
    expect(conversationMessageInputSchema.safeParse({ content: "   " }).success).toBe(false);
    expect(conversationMessageInputSchema.safeParse({ content: "x".repeat(4_001) }).success).toBe(false);
  });
});
