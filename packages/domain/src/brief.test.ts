import { describe, expect, it } from "vitest";
import { dailyBriefContentSchema, generateDailyBriefSchema, generateStandaloneBriefSchema, updateDailyBriefSchema } from "./brief.js";

const content = { title: "今日简报", reflection: "完成了重要工作。", taskSummary: "安排 2 项，完成 1 项。", sections: [{ title: "来自今天", body: "个人记录来源。" }] };

describe("daily brief contracts", () => {
  it("accepts an optional city name supplied at generation time", () => {
    expect(generateDailyBriefSchema.parse({ locationName: "杭州" })).toEqual({ locationName: "杭州" });
    expect(generateDailyBriefSchema.parse({})).toEqual({});
    expect(() => generateDailyBriefSchema.parse({ locationName: "" })).toThrow();
  });
  it("requires an explicit bounded conversation and date for a standalone brief", () => {
    expect(generateStandaloneBriefSchema.parse({ conversation: "把这段阅读笔记整理成一份简报", localDate: "2026-07-30" })).toEqual({ conversation: "把这段阅读笔记整理成一份简报", localDate: "2026-07-30" });
    expect(generateStandaloneBriefSchema.safeParse({ conversation: "", localDate: "2026-07-30" }).success).toBe(false);
    expect(generateStandaloneBriefSchema.safeParse({ conversation: "有效内容", localDate: "2026/07/30" }).success).toBe(false);
    expect(generateStandaloneBriefSchema.safeParse({ conversation: "有效内容", localDate: "2026-07-30", unexpected: true }).success).toBe(false);
  });
  it("accepts editable personal-record brief content", () => {
    expect(dailyBriefContentSchema.safeParse(content).success).toBe(true);
    expect(updateDailyBriefSchema.safeParse({ content, state: "confirmed" }).success).toBe(true);
  });
  it("rejects empty editorial fields", () => {
    expect(dailyBriefContentSchema.safeParse({ ...content, title: "" }).success).toBe(false);
  });
});
