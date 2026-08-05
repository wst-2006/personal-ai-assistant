import { describe, expect, it } from "vitest";
import { reviewDateSchema, reviewMessageSchema } from "./review.js";

describe("review contracts", () => {
  it("accepts a local review date and bounded message", () => {
    expect(reviewDateSchema.safeParse("2026-07-28").success).toBe(true);
    expect(reviewMessageSchema.safeParse({ content: "完成了今天最重要的一段工作。" }).success).toBe(true);
  });

  it("rejects malformed dates and empty messages", () => {
    expect(reviewDateSchema.safeParse("2026/07/28").success).toBe(false);
    expect(reviewMessageSchema.safeParse({ content: "  " }).success).toBe(false);
    expect(reviewMessageSchema.safeParse({ content: "伪造回复", source: "ai" }).success).toBe(false);
  });
});
