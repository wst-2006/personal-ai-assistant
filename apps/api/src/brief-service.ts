import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { dailyBriefs, reviewMessages, reviewSessions, tasks } from "@personal-ai/db/schema";
import { BriefProviders, type BriefSection, type BriefSource, searchSection } from "./brief-providers.js";

type BriefContent = { title:string; reflection:string; taskSummary:string; sections:BriefSection[]; location?: Awaited<ReturnType<BriefProviders["weather"]>>["location"]; weather?: Awaited<ReturnType<BriefProviders["weather"]>>["weather"] };

export class BriefNotFoundError extends Error {}
export class BriefReviewRequiredError extends Error {}

export class BriefService {
  constructor(private readonly db: AppDatabase, private readonly providers = new BriefProviders()) {}

  async generateFromReview(reviewSessionId: string, locationName?: string) {
    const [review] = await this.db.select().from(reviewSessions).where(eq(reviewSessions.id, reviewSessionId)).limit(1);
    if (!review) throw new BriefNotFoundError();
    const messages = await this.db.select().from(reviewMessages).where(eq(reviewMessages.reviewSessionId, review.id)).orderBy(desc(reviewMessages.createdAt));
    if (messages.length === 0) throw new BriefReviewRequiredError();
    const taskRows = await this.db.select().from(tasks).where(eq(tasks.localDate, review.localDate));
    const closed = taskRows.filter((task) => task.lifecycleStatus === "closed").length;
    const taskQuery = taskRows.map((task) => task.title).filter(Boolean).slice(0, 3).join(" ");
    const { content, sources } = await this.generateContent({
      localDate: review.localDate,
      reflection: messages.map((message) => message.content).join("\n\n"),
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
      input.taskQuery ? this.providers.search(input.taskQuery) : Promise.resolve({ results: [], source: null }), this.providers.weather(input.locationName)
    ]);
    const sections = [searchSection("金融", finance), searchSection("AI", ai), searchSection("大数据与科技", technology), searchSection("任务相关拓展", taskExpansion), searchSection("历史／人文／社会", humanities)];
    const content: BriefContent = {
      title: input.title ?? `${input.localDate} 的每日简报`, reflection: input.reflection, taskSummary: input.taskSummary, sections: [...sections.map((item) => item.section), weather.section], location: weather.location, weather: weather.weather
    };
    const sources: BriefSource[] = [{ kind: "personal_record", label: input.sourceLabel, provider: "personal_ai", retrievedAt: new Date().toISOString() }, ...sections.flatMap((item) => item.sources), ...(weather.source ? [weather.source] : [])];
    return { content, sources };
  }

  async update(id: string, content: BriefContent, state?: "draft" | "confirmed") {
    const [updated] = await this.db.update(dailyBriefs).set({ content, ...(state ? { state } : {}), updatedAt: new Date() }).where(eq(dailyBriefs.id, id)).returning();
    if (!updated) throw new BriefNotFoundError();
    return updated;
  }
}
