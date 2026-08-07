import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { dailyBriefs, reviewMessages, reviewSessions, tasks } from "@personal-ai/db/schema";
import { BriefProviders, type BriefSection, type BriefSource, searchSection } from "./brief-providers.js";
import type { BriefSectionKey, BriefWriter } from "./ai/brief-writer.js";

type BriefContent = { title:string; reflection:string; taskSummary:string; sections:BriefSection[]; location?: Awaited<ReturnType<BriefProviders["weather"]>>["location"]; weather?: Awaited<ReturnType<BriefProviders["weather"]>>["weather"] };

export class BriefNotFoundError extends Error {}
export class BriefReviewRequiredError extends Error {}
export class BriefGenerationUnavailableError extends Error {}
export class BriefSourcesUnavailableError extends Error {}

const sectionDefinitions: Array<{ key: Exclude<BriefSectionKey, "encouragement">; title: string }> = [
  { key: "finance", title: "金融" },
  { key: "ai", title: "AI" },
  { key: "technology", title: "大数据与科技" },
  { key: "taskExpansion", title: "任务相关拓展" },
  { key: "humanities", title: "历史／人文／社会" }
];

const sectionTitles: Record<BriefSectionKey, string> = {
  finance: "金融",
  ai: "AI",
  technology: "大数据与科技",
  taskExpansion: "任务相关拓展",
  humanities: "历史／人文／社会",
  encouragement: "给今天的一句话"
};

export class BriefService {
  constructor(
    private readonly db: AppDatabase,
    private readonly providers = new BriefProviders(),
    private readonly writer?: BriefWriter
  ) {}

  async generateFromReview(reviewSessionId: string, locationName?: string) {
    const [review] = await this.db.select().from(reviewSessions).where(eq(reviewSessions.id, reviewSessionId)).limit(1);
    if (!review) throw new BriefNotFoundError();
    const messages = await this.db.select().from(reviewMessages).where(eq(reviewMessages.reviewSessionId, review.id)).orderBy(asc(reviewMessages.createdAt));
    if (!messages.some((message) => message.source === "app")) throw new BriefReviewRequiredError();
    const taskRows = await this.db.select().from(tasks).where(eq(tasks.localDate, review.localDate));
    const closed = taskRows.filter((task) => task.lifecycleStatus === "closed").length;
    const taskQuery = taskRows.map((task) => task.title).filter(Boolean).slice(0, 3).join(" ");
    const { content, sources } = await this.generateContent({
      localDate: review.localDate,
      reflection: messages.map((message) => `${message.source === "ai" ? "[AI 回应]" : "[用户复盘]"}\n${message.content}`).join("\n\n"),
      taskSummary: `当天共安排 ${taskRows.length} 项任务，已关闭 ${closed} 项。`,
      taskQuery,
      locationName,
      sourceLabel: "复盘正文与本项目任务数据"
    });
    return this.db.transaction(async (transaction) => {
      const [existing] = await transaction.select().from(dailyBriefs).where(eq(dailyBriefs.reviewSessionId, review.id)).orderBy(desc(dailyBriefs.updatedAt)).limit(1);
      if (existing) {
        const [updated] = await transaction.update(dailyBriefs).set({ content, sources, state: "draft", updatedAt: new Date() }).where(eq(dailyBriefs.id, existing.id)).returning();
        return updated!;
      }
      return (await transaction.insert(dailyBriefs).values({ id: randomUUID(), localDate: review.localDate, reviewSessionId: review.id, state: "draft", content, sources }).returning())[0]!;
    });
  }

  async generateFromConversation(conversation: string, localDate: string, locationName?: string) {
    const { content, sources } = await this.generateContent({
      localDate,
      reflection: conversation,
      taskSummary: "这是一份由用户明确请求生成的独立简报，不关联今日复盘，也不会生成赛博日记。",
      taskQuery: conversation,
      locationName,
      sourceLabel: "用户明确请求的独立对话内容",
      title: `${localDate} 的独立简报`
    });
    return (await this.db.insert(dailyBriefs).values({ id: randomUUID(), localDate, reviewSessionId: null, state: "confirmed", content, sources }).returning())[0]!;
  }

  async listStandalone(localDate: string) {
    return this.db.select().from(dailyBriefs).where(and(eq(dailyBriefs.localDate, localDate), isNull(dailyBriefs.reviewSessionId))).orderBy(desc(dailyBriefs.updatedAt));
  }

  private async generateContent(input: { localDate: string; reflection: string; taskSummary: string; taskQuery: string; locationName?: string; sourceLabel: string; title?: string }) {
    const [finance, ai, technology, humanities, taskExpansion, weather] = await Promise.all([
      this.providers.search("金融 市场 今日 要闻"), this.providers.search("人工智能 今日 要闻"), this.providers.search("大数据 科技 今日 要闻"), this.providers.search("历史 人文 社会 今日"),
      input.taskQuery ? this.providers.search(input.taskQuery) : Promise.resolve({ results: [], source: null, status: "empty" as const, provider: "none" }), this.providers.weather(input.locationName)
    ]);
    const searchResults = { finance, ai, technology, taskExpansion, humanities };
    const attemptedSearches = Object.values(searchResults).filter((result) => result.provider !== "none");
    if (attemptedSearches.length > 0 && attemptedSearches.every((result) => result.status === "unavailable")) {
      throw new BriefSourcesUnavailableError();
    }
    const searchedSections = sectionDefinitions.map((definition) => ({
      ...definition,
      result: searchResults[definition.key],
      fallback: searchSection(definition.title, searchResults[definition.key])
    }));
    let generated: Awaited<ReturnType<BriefWriter["write"]>> | null = null;
    if (this.writer) {
      try {
        generated = await this.writer.write({
          localDate: input.localDate,
          titleHint: input.title ?? `${input.localDate} 的每日简报`,
          reflection: input.reflection,
          taskSummary: input.taskSummary,
          searches: searchedSections.map((item) => ({ key: item.key, title: item.title, results: item.result.results }))
        });
      } catch {
        throw new BriefGenerationUnavailableError();
      }
    }
    const editorialSections: BriefSection[] = generated
      ? generated.sections.map((section) => {
          const searched = searchedSections.find((item) => item.key === section.key);
          return searched && searched.result.status !== "ok"
            ? searched.fallback.section
            : { title: sectionTitles[section.key], body: section.body };
        })
      : [
          ...searchedSections.map((item) => item.fallback.section),
          { title: sectionTitles.encouragement, body: "今天留下的记录已经足够成为下一步的起点，按自己的节奏继续。" }
        ];
    const content: BriefContent = {
      title: generated?.title ?? input.title ?? `${input.localDate} 的每日简报`,
      reflection: generated?.reflection ?? input.reflection,
      taskSummary: generated?.taskSummary ?? input.taskSummary,
      sections: [...editorialSections, weather.section],
      location: weather.location,
      weather: weather.weather
    };
    const sources: BriefSource[] = [
      { kind: "personal_record", label: input.sourceLabel, provider: "personal_ai", retrievedAt: new Date().toISOString() },
      ...searchedSections.flatMap((item) => item.fallback.sources),
      ...(weather.source ? [weather.source] : [])
    ];
    return { content, sources };
  }

  async update(id: string, content: BriefContent, state?: "draft" | "confirmed") {
    const [updated] = await this.db.update(dailyBriefs).set({ content, ...(state ? { state } : {}), updatedAt: new Date() }).where(eq(dailyBriefs.id, id)).returning();
    if (!updated) throw new BriefNotFoundError();
    return updated;
  }
}
