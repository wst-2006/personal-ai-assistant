import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { HealthPlanningOutputError } from "./ai/health-planner.js";
import type { HealthService } from "./health-service.js";

const createAiCandidate = vi.fn().mockRejectedValue(new HealthPlanningOutputError(
  "第 4 天的“运动安全注意”缺少必填字段",
  [{ path: "days.3.movement.safetyNotes", reason: "缺少必填字段" }]
));

const app = buildApp({
  healthService: { createAiCandidate } as unknown as HealthService,
  healthPlanner: { plan: vi.fn() }
});

afterAll(async () => app.close());

describe("health planning error responses", () => {
  it("returns sanitized field-level validation details without hiding the saved conversation state", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/health/weeks/ai-candidates",
      payload: { weekStart: "2026-08-16" }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: "ai_health_plan_invalid",
      message: expect.stringContaining("第 4 天的“运动安全注意”缺少必填字段"),
      validationIssues: [{ path: "days.3.movement.safetyNotes", reason: "缺少必填字段" }]
    });
    expect(response.json().message).toContain("本周交流已经保留");
    expect(response.json().message).toContain("不会自动重复请求");
    expect(createAiCandidate).toHaveBeenCalledTimes(1);
  });
});
