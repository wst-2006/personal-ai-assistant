import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
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
      async subscribe() { return { results: [], source: null, status: "unavailable" as const, provider: "rss_subscription" }; },
      async search() { return { results: [], source: null, status: "unavailable" as const, provider: "test" }; },
      async weather() { return { section: { title: "天气与地点", body: "今日未记录地点。" }, source: null, location: null, weather: null }; }
    } as unknown as BriefProviders;
    const writer = { async write() { throw new Error("AI editor must not run without web sources"); } } as BriefWriter;

    await expect(new BriefService(connection.db, providers, writer).generateFromConversation("生成断源测试简报", localDate))
      .rejects.toBeInstanceOf(BriefSourcesUnavailableError);

    const after = await connection.db.select({ id: dailyBriefs.id }).from(dailyBriefs).where(eq(dailyBriefs.localDate, localDate));
    expect(after).toEqual(before);
  });

  it("uses an imported Work Buddy draft as the final source fallback", async () => {
    const localDate = "2099-12-31";
    const externalId = randomUUID();
    const externalTitle = `Work Buddy fallback ${externalId}`;
    await connection.db.insert(dailyBriefs).values({
      id: externalId,
      localDate,
      reviewSessionId: null,
      state: "draft",
      content: {
        title: externalTitle,
        reflection: "外部简报已经整理好的来源材料。",
        taskSummary: "来自 Work Buddy",
        sections: [{ title: "外部原文", body: "公开资料" }]
      },
      sources: [{ kind: "external_brief", label: "Work Buddy 简报", provider: "work_buddy", retrievedAt: new Date().toISOString() }]
    });
    let generatedId: string | null = null;
    let capturedTaskExpansion: Array<{ title: string }> = [];
    const providers = {
      async subscribe() { return { results: [], source: null, status: "unavailable" as const, provider: "rss_subscription" }; },
      async search() { return { results: [], source: null, status: "unavailable" as const, provider: "test" }; },
      async weather() { return { section: { title: "天气与地点", body: "今日未记录地点。" }, source: null, location: null, weather: null }; }
    } as unknown as BriefProviders;
    const writer: BriefWriter = {
      async write(input) {
        capturedTaskExpansion = input.searches.find((section) => section.key === "taskExpansion")?.results.map((result) => ({ title: result.title })) ?? [];
        return {
          title: "使用 Work Buddy 材料的简报",
          reflection: "复盘上下文",
          taskSummary: "外部来源兜底",
          sections: [
            ...input.searches.map((section) => ({ key: section.key, body: section.results[0]?.description ?? "暂无可靠资料。" })),
            { key: "encouragement" as const, body: "保留来源，再继续。" }
          ]
        };
      }
    };
    try {
      const result = await new BriefService(connection.db, providers, writer).generateFromConversation("生成最终兜底测试", localDate);
      generatedId = result.id;
      expect(capturedTaskExpansion).toEqual([{ title: externalTitle }]);
      expect(result.sources).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "work_buddy", kind: "external_brief" })]));
    } finally {
      if (generatedId) await connection.db.delete(dailyBriefs).where(eq(dailyBriefs.id, generatedId));
      await connection.db.delete(dailyBriefs).where(eq(dailyBriefs.id, externalId));
    }
  });
});
