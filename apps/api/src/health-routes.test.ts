import { afterAll, describe, expect, it } from "vitest";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { healthSleepAnalyses } from "@personal-ai/db/schema";
import { eq } from "drizzle-orm";
import { buildApp } from "./app.js";
import { HealthService } from "./health-service.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
const service = new HealthService(connection.db);
const app = buildApp({
  healthService: service,
  sleepImageAnalyzer: {
    async analyze() {
      return {
        totalSleepMinutes: 390, deepSleepMinutes: 90, lightSleepMinutes: null, remSleepMinutes: null,
        awakeCount: 2, sleepStart: "23:40", wakeTime: "06:10", deviceScore: 82,
        deviceNotes: "设备显示睡眠评分。", visibleMetrics: ["总睡眠", "深睡", "评分"],
        interpretation: ["截图中显示总睡眠和设备评分。"], limitations: ["仅基于截图中可见信息，不能替代专业医疗建议。"]
      };
    }
  }
});

afterAll(async () => {
  await app.close();
  await connection.client.end();
});

describe("sleep screenshot routes", () => {
  it("persists structured results and never accepts mismatched image bytes", async () => {
    const dataUrl = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")}`;
    const created = await app.inject({ method: "POST", url: "/api/v1/health/sleep-analyses", payload: {
      localDate: "2099-02-01", fileName: "huawei-sleep.png", mimeType: "image/png", dataUrl
    } });
    expect(created.statusCode).toBe(201);
    const record = created.json().analysis as { id: string; analysis: { totalSleepMinutes: number }; sha256: string };
    expect(record.analysis.totalSleepMinutes).toBe(390);
    expect(record.sha256).toMatch(/^[a-f0-9]{64}$/);

    const listed = await app.inject({ method: "GET", url: "/api/v1/health/sleep-analyses/2099-02-01" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().analyses).toHaveLength(1);

    const invalid = await app.inject({ method: "POST", url: "/api/v1/health/sleep-analyses", payload: {
      localDate: "2099-02-02", fileName: "fake.png", mimeType: "image/png", dataUrl: "data:image/png;base64,ZmFrZQ=="
    } });
    expect(invalid.statusCode).toBe(400);
    await connection.db.delete(healthSleepAnalyses).where(eq(healthSleepAnalyses.id, record.id));
  });
});
