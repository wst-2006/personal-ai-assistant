import { describe, expect, it } from "vitest";
import { cyberDiaryContentSchema, saveCyberDiarySchema } from "./diary.js";

describe("cyber diary contracts", () => {
  const content = { title: "7 月 28 日", body: "今天把重要的事情慢慢做完了。" };

  it("accepts an editable diary tied to review and brief identifiers", () => {
    expect(cyberDiaryContentSchema.safeParse(content).success).toBe(true);
    expect(saveCyberDiarySchema.safeParse({
      reviewSessionId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      briefId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12",
      content
    }).success).toBe(true);
  });

  it("rejects empty diary content and malformed links", () => {
    expect(cyberDiaryContentSchema.safeParse({ title: "", body: "正文" }).success).toBe(false);
    expect(saveCyberDiarySchema.safeParse({ reviewSessionId: "review", briefId: "brief", content }).success).toBe(false);
  });
});
