import { describe, expect, it } from "vitest";
import { cyberDiaryContentSchema, cyberDiaryRadarSchema, saveCyberDiarySchema } from "./diary.js";

describe("cyber diary contracts", () => {
  const content = {
    title: "7 月 28 日",
    body: "今天把重要的事情慢慢做完了。",
    radar: {
      mainlineProgress: 80,
      overallExecution: 70,
      focusQuality: 75,
      energyState: 60,
      wellbeing: null,
      growthGain: 80
    }
  };

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
    expect(cyberDiaryRadarSchema.safeParse({ ...content.radar, mainlineProgress: 101 }).success).toBe(false);
  });
});
