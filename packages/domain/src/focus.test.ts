import { describe, expect, it } from "vitest";
import { createFocusSessionSchema, evaluateFocusSessionSchema } from "./focus.js";

describe("focus input contracts", () => {
  it("accepts durable start modes", () => {
    expect(createFocusSessionSchema.safeParse({
      taskId: "00000000-0000-4000-8000-000000000001", expectedTaskVersion: 2, mode: "prepare"
    }).success).toBe(true);
    expect(createFocusSessionSchema.safeParse({
      taskId: "00000000-0000-4000-8000-000000000001", expectedTaskVersion: 2, mode: "restart"
    }).success).toBe(true);
  });

  it.each([
    ["complete", 100, true], ["complete", 90, false], ["partial", 50, true], ["partial", 0, false], ["not_completed", 0, true]
  ] as const)("validates %s evaluation percentages", (outcome, progressPercent, valid) => {
    const result = evaluateFocusSessionSchema.safeParse({ expectedVersion: 1, outcome, progressPercent, satisfaction: "neutral" });
    expect(result.success).toBe(valid);
  });
});
