import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { dailyBriefs, reviewMessages, reviewSessions, tasks } from "@personal-ai/db/schema";

type BriefContent = { title:string; reflection:string; taskSummary:string; sections:Array<{title:string;body:string}> };

export class BriefNotFoundError extends Error {}
export class BriefReviewRequiredError extends Error {}

export class BriefService {
  constructor(private readonly db: AppDatabase) {}

  async generateFromReview(reviewSessionId: string) {
    return this.db.transaction(async (transaction) => {
      const [review] = await transaction.select().from(reviewSessions).where(eq(reviewSessions.id, reviewSessionId)).limit(1);
      if (!review) throw new BriefNotFoundError();
      const messages = await transaction.select().from(reviewMessages).where(eq(reviewMessages.reviewSessionId, review.id)).orderBy(desc(reviewMessages.createdAt));
      if (messages.length === 0) throw new BriefReviewRequiredError();
      const taskRows = await transaction.select().from(tasks).where(eq(tasks.localDate, review.localDate));
      const closed = taskRows.filter((task) => task.lifecycleStatus === "closed").length;
      const content: BriefContent = {
        title: `${review.localDate} 的每日简报`,
        reflection: messages.map((message) => message.content).join("\n\n"),
        taskSummary: `当天共安排 ${taskRows.length} 项任务，已关闭 ${closed} 项。`,
        sections: [{ title: "来自今天", body: "这份草稿基于你刚刚保存的复盘和项目内任务数据生成。外部新闻、天气与地点将在连接相应来源后补充。" }]
      };
      const sources = [{ kind: "personal_record", label: "复盘正文与本项目任务数据", reviewSessionId: review.id }];
      const [existing] = await transaction.select().from(dailyBriefs).where(eq(dailyBriefs.reviewSessionId, review.id)).orderBy(desc(dailyBriefs.updatedAt)).limit(1);
      if (existing) {
        const [updated] = await transaction.update(dailyBriefs).set({ content, sources, state: "draft", updatedAt: new Date() }).where(eq(dailyBriefs.id, existing.id)).returning();
        return updated!;
      }
      return (await transaction.insert(dailyBriefs).values({ id: randomUUID(), localDate: review.localDate, reviewSessionId: review.id, state: "draft", content, sources }).returning())[0]!;
    });
  }

  async update(id: string, content: BriefContent, state?: "draft" | "confirmed") {
    const [updated] = await this.db.update(dailyBriefs).set({ content, ...(state ? { state } : {}), updatedAt: new Date() }).where(eq(dailyBriefs.id, id)).returning();
    if (!updated) throw new BriefNotFoundError();
    return updated;
  }
}
