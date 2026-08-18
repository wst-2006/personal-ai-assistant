import { describe, expect, it } from "vitest";
import { reviewDateSchema, reviewMessageSchema, reviewRadarSchema, reviewRadarSnapshotSchema } from "./review.js";

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

  it("accepts a complete six-axis radar snapshot", () => {
    const radar = { mainlineProgress: 100, overallExecution: 80, focusQuality: 60, energyState: 40, wellbeing: 20, growthGain: 80 };
    expect(reviewRadarSchema.safeParse(radar).success).toBe(true);
    expect(reviewRadarSnapshotSchema.safeParse({ version: 1, radar }).success).toBe(true);
    expect(reviewRadarSchema.safeParse({ ...radar, wellbeing: null }).success).toBe(false);
  });

  it("rejects values between hexagon stages", () => {
    const radar = { mainlineProgress: 56.4, overallExecution: 46.8, focusQuality: 64.1, energyState: 44.5, wellbeing: 58.9, growthGain: 50.2 };
    expect(reviewRadarSchema.safeParse(radar).success).toBe(false);
  });
});
