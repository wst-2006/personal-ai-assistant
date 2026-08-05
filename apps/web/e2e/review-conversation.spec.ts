import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { reviewMessages, reviewSessions, tasks } from "@personal-ai/db/schema";
import { asc, eq } from "drizzle-orm";

test("复盘页可选择真实 AI 对话，用户与 AI 消息持久分开并在 390px 恢复", async ({ page }) => {
  test.setTimeout(120_000);
  const suffix = Date.now().toString(36);
  const localDate = `2099-11-${String(10 + (Date.now() % 10)).padStart(2, "0")}`;
  const taskId = randomUUID();
  const message = `E2E 复盘对话 ${suffix}：今天完成了主要部分，请只基于当天记录给一个简短回应。`;
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  let reviewId: string | null = null;

  try {
    await db.insert(tasks).values({
      id: taskId,
      title: `E2E 复盘上下文任务 ${suffix}`,
      lifecycleStatus: "closed",
      currentOutcome: "complete",
      scheduleKind: "none",
      localDate,
      timeZone: "Asia/Shanghai",
    });

    await page.clock.setFixedTime(new Date(`${localDate}T21:00:00+08:00`));
    await page.goto("/");
    await page.locator(".app-rail").getByRole("button", { name: "复盘", exact: true }).click();
    await page.getByLabel("复盘正文", { exact: true }).fill(message);
    const saved = page.waitForResponse((response) => response.url().includes("/api/v1/reviews/") && response.url().endsWith("/messages") && response.request().method() === "POST" && response.status() === 201);
    const replied = page.waitForResponse((response) => response.url().includes("/api/v1/reviews/") && response.url().endsWith("/reply-last") && response.request().method() === "POST" && response.status() === 201);
    await page.getByRole("button", { name: "保存并请 AI 回应", exact: true }).click();
    const savedBody = (await (await saved).json()) as { session: { id: string } };
    reviewId = savedBody.session.id;
    await replied;

    await expect(page.locator(".review-stream article.app").getByText(message, { exact: true })).toBeVisible();
    await expect(page.locator(".review-stream article.ai")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "结束今日复盘并生成简报", exact: true })).toBeEnabled();

    await page.reload();
    await page.locator(".app-rail").getByRole("button", { name: "复盘", exact: true }).click();
    await expect(page.locator(".review-stream article.app").getByText(message, { exact: true })).toBeVisible();
    await expect(page.locator(".review-stream article.ai")).toHaveCount(1);
    await expect(page.locator(".review-count strong")).toHaveText("1");

    const persisted = await db.select({ source: reviewMessages.source, content: reviewMessages.content })
      .from(reviewMessages)
      .where(eq(reviewMessages.reviewSessionId, reviewId))
      .orderBy(asc(reviewMessages.createdAt));
    expect(persisted.map((row) => row.source)).toEqual(["app", "ai"]);
    expect(persisted[0]?.content).toBe(message);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator(".mobile-nav").getByRole("button", { name: "复盘", exact: true }).click();
    await expect(page.locator(".review-stream article.ai")).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally {
    const cleanupReviewId = reviewId ?? (await db.select({ id: reviewSessions.id }).from(reviewSessions).where(eq(reviewSessions.localDate, localDate)))[0]?.id ?? null;
    if (cleanupReviewId) {
      await db.delete(reviewMessages).where(eq(reviewMessages.reviewSessionId, cleanupReviewId));
      await db.delete(reviewSessions).where(eq(reviewSessions.id, cleanupReviewId));
    }
    await db.delete(tasks).where(eq(tasks.id, taskId));
    await client.end();
  }
});

test("AI-only 历史消息不会冒充用户复盘解锁简报", async ({ page }) => {
  const localDate = `2099-11-${String(20 + (Date.now() % 8)).padStart(2, "0")}`;
  const reviewId = randomUUID();
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  try {
    await db.insert(reviewSessions).values({ id: reviewId, localDate, state: "review_open" });
    await db.insert(reviewMessages).values({ id: randomUUID(), reviewSessionId: reviewId, source: "ai", content: "这不是用户主动复盘。" });
    await page.clock.setFixedTime(new Date(`${localDate}T21:00:00+08:00`));
    await page.goto("/");
    await page.locator(".app-rail").getByRole("button", { name: "复盘", exact: true }).click();
    await expect(page.locator(".review-count")).toContainText("0");
    await expect(page.locator(".review-stream article.ai").getByText("这不是用户主动复盘。", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "结束今日复盘并生成简报", exact: true })).toBeDisabled();
  } finally {
    await db.delete(reviewMessages).where(eq(reviewMessages.reviewSessionId, reviewId));
    await db.delete(reviewSessions).where(eq(reviewSessions.id, reviewId));
    await client.end();
  }
});
