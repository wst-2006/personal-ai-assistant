import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { BriefGenerationUnavailableError } from "./brief-service.js";
import type { BriefService } from "./brief-service.js";

const persistedBrief = {
  id: "8e51cb70-5254-4fb1-87e8-c5f27bbe349b", localDate: "2026-07-30", reviewSessionId: null, state: "confirmed",
  content: { title: "独立简报", reflection: "明确请求的内容", taskSummary: "独立记录", sections: [] }, sources: [],
  createdAt: new Date(), updatedAt: new Date()
};
const calls: Array<{ conversation: string; localDate: string; locationName?: string }> = [];
const briefService = {
  async generateFromConversation(conversation: string, localDate: string, locationName?: string) {
    calls.push({ conversation, localDate, locationName });
    return persistedBrief;
  },
  async listStandalone() { return [persistedBrief]; }
} as unknown as BriefService;
const app = buildApp({ briefService });
const unavailableApp = buildApp({ briefService: {
  async generateFromConversation() { throw new BriefGenerationUnavailableError(); }
} as unknown as BriefService });

afterAll(async () => { await app.close(); await unavailableApp.close(); });

describe("standalone brief routes", () => {
  it("persists only an explicitly requested standalone brief contract", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/briefs/standalone", payload: { conversation: "整理这段独立对话", localDate: "2026-07-30" } });
    expect(response.statusCode).toBe(201);
    expect(response.json().brief).toMatchObject({ reviewSessionId: null, state: "confirmed" });
    expect(calls.at(-1)).toEqual({ conversation: "整理这段独立对话", localDate: "2026-07-30", locationName: undefined });
  });

  it("lists persisted standalone briefs and rejects malformed inputs", async () => {
    const list = await app.inject({ method: "GET", url: "/api/v1/briefs/standalone?date=2026-07-30" });
    expect(list.statusCode).toBe(200);
    expect(list.json().briefs[0]).toMatchObject({ reviewSessionId: null, state: "confirmed" });
    const invalid = await app.inject({ method: "POST", url: "/api/v1/briefs/standalone", payload: { conversation: "", localDate: "today" } });
    expect(invalid.statusCode).toBe(400);
  });

  it("does not persist or report a false success when AI brief editing fails", async () => {
    const response = await unavailableApp.inject({ method: "POST", url: "/api/v1/briefs/standalone", payload: { conversation: "请生成简报", localDate: "2026-07-30" } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "brief_generation_unavailable" });
  });
});
