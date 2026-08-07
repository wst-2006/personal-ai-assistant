import { afterAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { growthRoutes } from "./growth-routes.js";
import type { GrowthWindowDays } from "./growth-service.js";

describe("growth routes", () => {
  const app = Fastify();
  const requests: Array<{ endDate: string; days: GrowthWindowDays }> = [];
  app.register(growthRoutes, {
    prefix: "/api/v1",
    growthService: {
      async getSummary(endDate: string, days: GrowthWindowDays) {
        requests.push({ endDate, days });
        return { range: { start: endDate, end: endDate }, days: [] };
      }
    } as never
  });

  afterAll(async () => { await app.close(); });

  it("accepts the supported week, month, quarter and year windows", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/growth/summary?endDate=2099-05-30" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/growth/summary?endDate=2099-05-30&days=30" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/growth/summary?endDate=2099-05-30&days=90" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/growth/summary?endDate=2099-05-30&days=365" })).statusCode).toBe(200);
    expect(requests).toEqual([
      { endDate: "2099-05-30", days: 7 },
      { endDate: "2099-05-30", days: 30 },
      { endDate: "2099-05-30", days: 90 },
      { endDate: "2099-05-30", days: 365 }
    ]);
  });

  it("rejects unsupported windows and invalid dates", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/growth/summary?endDate=2099-05-30&days=14" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/growth/summary?endDate=not-a-date" })).statusCode).toBe(400);
  });
});
