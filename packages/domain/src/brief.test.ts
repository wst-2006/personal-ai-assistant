import { describe, expect, it } from "vitest";
import { dailyBriefContentSchema, generateDailyBriefSchema, updateDailyBriefSchema } from "./brief.js";

const content = { title: "今日简报", reflection: "完成了重要工作。", taskSummary: "安排 2 项，完成 1 项。", sections: [{ title: "来自今天", body: "个人记录来源。" }] };

describe("daily brief contracts", () => {
  it("accepts an optional city name supplied at generation time", () => {
    expect(generateDailyBriefSchema.parse({ locationName: "杭州" })).toEqual({ locationName: "杭州" });
    expect(generateDailyBriefSchema.parse({})).toEqual({});
    expect(() => generateDailyBriefSchema.parse({ locationName: "" })).toThrow();
  });
  it("accepts editable personal-record brief content", () => {
    expect(dailyBriefContentSchema.safeParse(content).success).toBe(true);
    expect(updateDailyBriefSchema.safeParse({ content, state: "confirmed" }).success).toBe(true);
  });
  it("rejects empty editorial fields", () => {
    expect(dailyBriefContentSchema.safeParse({ ...content, title: "" }).success).toBe(false);
  });
});
