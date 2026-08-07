import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { dailyBriefs } from "@personal-ai/db/schema";
import { BriefSourcesUnavailableError, BriefService } from "./brief-service.js";
import type { BriefProviders } from "./brief-providers.js";
import type { BriefWriter } from "./ai/brief-writer.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
afterAll(async () => { await connection.client.end(); });

describe("daily brief source availability", () => {
  it("does not persist or invoke the AI editor when every web-search call is unavailable", async () => {
    const localDate = "2099-12-30";
    const before = await connection.db.select({ id: dailyBriefs.id }).from(dailyBriefs).where(eq(dailyBriefs.localDate, localDate));
    const providers = {
      async search() { return { results: [], source: null, status: "unavailable" as const, provider: "test" }; },
      async weather() { return { section: { title: "天气与地点", body: "今日未记录地点。" }, source: null, location: null, weather: null }; }
    } as unknown as BriefProviders;
    const writer = { async write() { throw new Error("AI editor must not run without web sources"); } } as BriefWriter;

    await expect(new BriefService(connection.db, providers, writer).generateFromConversation("生成断源测试简报", localDate))
      .rejects.toBeInstanceOf(BriefSourcesUnavailableError);

    const after = await connection.db.select({ id: dailyBriefs.id }).from(dailyBriefs).where(eq(dailyBriefs.localDate, localDate));
    expect(after).toEqual(before);
  });
});
