import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { cyberDiaries, dailyBriefs, reviewMessages, reviewSessions } from "@personal-ai/db/schema";
import { eq } from "drizzle-orm";
import { BriefReviewRequiredError, BriefService } from "./brief-service.js";
import { DiaryPrerequisiteError, DiaryService } from "./diary-service.js";
import { GrowthService } from "./growth-service.js";

const connection = await connectVerifiedDatabase(loadDatabaseConfig());
const reviewIds: string[] = [];

afterEach(async () => {
  for (const id of reviewIds.splice(0)) {
    await connection.db.delete(cyberDiaries).where(eq(cyberDiaries.reviewSessionId, id));
    await connection.db.delete(dailyBriefs).where(eq(dailyBriefs.reviewSessionId, id));
    await connection.db.delete(reviewMessages).where(eq(reviewMessages.reviewSessionId, id));
    await connection.db.delete(reviewSessions).where(eq(reviewSessions.id, id));
  }
});

afterAll(async () => { await connection.client.end(); });

describe("review user-message prerequisites", () => {
  it("does not let an AI-only row unlock brief, diary, month history, or growth review credit", async () => {
    const localDate = "2099-09-05";
    const reviewId = randomUUID();
    const briefId = randomUUID();
    reviewIds.push(reviewId);
    await connection.db.transaction(async (transaction) => {
      await transaction.insert(reviewSessions).values({ id: reviewId, localDate, state: "review_open" });
      await transaction.insert(reviewMessages).values({ id: randomUUID(), reviewSessionId: reviewId, source: "ai", content: "不应独立解锁流程" });
      await transaction.insert(dailyBriefs).values({
        id: briefId,
        localDate,
        reviewSessionId: reviewId,
        state: "confirmed",
        content: { title: "测试简报", reflection: "AI-only", taskSummary: "无", sections: [] },
        sources: [],
      });
    });

    await expect(new BriefService(connection.db).generateFromReview(reviewId)).rejects.toBeInstanceOf(BriefReviewRequiredError);
    await expect(new DiaryService(connection.db).save(localDate, reviewId, briefId, { title: "日记", body: "不应保存" }))
      .rejects.toBeInstanceOf(DiaryPrerequisiteError);
    expect((await new DiaryService(connection.db).getByLocalDate(localDate)).hasReviewMessage).toBe(false);
    const month = await new DiaryService(connection.db).listMonth("2099-09");
    expect(month.days.find((day) => day.localDate === localDate)?.hasReview).toBe(false);
    const growth = await new GrowthService(connection.db).getSummary(localDate, 7);
    expect(growth.reviewedDays).toBe(0);

    await connection.db.insert(reviewMessages).values({ id: randomUUID(), reviewSessionId: reviewId, source: "app", content: "用户主动留下的复盘" });
    expect((await new DiaryService(connection.db).getByLocalDate(localDate)).hasReviewMessage).toBe(true);
    const afterUserMessage = await new GrowthService(connection.db).getSummary(localDate, 7);
    expect(afterUserMessage.reviewedDays).toBe(1);
  });
});
