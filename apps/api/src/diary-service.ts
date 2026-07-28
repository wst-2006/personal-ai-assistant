import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { AppDatabase } from "@personal-ai/db/client";
import { cyberDiaries, dailyBriefs, reviewMessages, reviewSessions } from "@personal-ai/db/schema";
import type { z } from "zod";
import type { cyberDiaryContentSchema } from "@personal-ai/domain/diary";

type DiaryContent = z.infer<typeof cyberDiaryContentSchema>;

export class DiaryPrerequisiteError extends Error {
  constructor(readonly code: "review_message_required" | "confirmed_brief_required" | "invalid_diary_links") {
    super(code);
  }
}

export class DiaryNotFoundError extends Error {}

export class DiaryService {
  constructor(private readonly db: AppDatabase) {}

  async getByLocalDate(localDate: string) {
    return this.db.transaction(async (transaction) => {
      const [review] = await transaction.select().from(reviewSessions).where(eq(reviewSessions.localDate, localDate)).limit(1);
      if (!review) return { diary: null, review: null, confirmedBrief: null, hasReviewMessage: false };
      const messages = await transaction.select({ id: reviewMessages.id }).from(reviewMessages).where(eq(reviewMessages.reviewSessionId, review.id)).limit(1);
      const [confirmedBrief] = await transaction.select().from(dailyBriefs).where(and(eq(dailyBriefs.reviewSessionId, review.id), eq(dailyBriefs.state, "confirmed"))).orderBy(desc(dailyBriefs.updatedAt)).limit(1);
      const [diary] = await transaction.select().from(cyberDiaries).where(eq(cyberDiaries.localDate, localDate)).limit(1);
      return { diary: diary ?? null, review, confirmedBrief: confirmedBrief ?? null, hasReviewMessage: messages.length > 0 };
    });
  }

  async save(localDate: string, reviewSessionId: string, briefId: string, content: DiaryContent) {
    return this.db.transaction(async (transaction) => {
      const [review] = await transaction.select().from(reviewSessions).where(eq(reviewSessions.id, reviewSessionId)).limit(1);
      if (!review || review.localDate !== localDate) throw new DiaryPrerequisiteError("invalid_diary_links");
      const messages = await transaction.select({ id: reviewMessages.id }).from(reviewMessages).where(eq(reviewMessages.reviewSessionId, review.id)).limit(1);
      if (messages.length === 0) throw new DiaryPrerequisiteError("review_message_required");
      const [brief] = await transaction.select().from(dailyBriefs).where(eq(dailyBriefs.id, briefId)).limit(1);
      if (!brief || brief.reviewSessionId !== review.id || brief.state !== "confirmed") throw new DiaryPrerequisiteError("confirmed_brief_required");
      const [existing] = await transaction.select().from(cyberDiaries).where(eq(cyberDiaries.localDate, localDate)).limit(1);
      if (existing) {
        return (await transaction.update(cyberDiaries).set({ reviewSessionId, briefId, content, updatedAt: new Date() }).where(eq(cyberDiaries.id, existing.id)).returning())[0]!;
      }
      return (await transaction.insert(cyberDiaries).values({ id: randomUUID(), localDate, reviewSessionId, briefId, content }).returning())[0]!;
    });
  }
}
