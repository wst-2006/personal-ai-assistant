import { expect, test } from "@playwright/test";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { appConversationMessages, appConversations, reviewMessages, reviewSessions } from "@personal-ai/db/schema";
import { eq } from "drizzle-orm";

test("软件内 AI 对话真实保存、刷新恢复并作为独立复盘上下文显示", async ({ page }) => {
  test.setTimeout(120_000);
  const suffix = Date.now().toString(36);
  const localDate = `2099-10-${String(10 + (Date.now() % 10)).padStart(2, "0")}`;
  const message = `E2E 对话 ${suffix}：请给我一条不改变计划的学习建议。`;
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  let conversationId: string | null = null;
  let reviewId: string | null = null;

  try {
    await page.clock.setFixedTime(new Date(`${localDate}T10:00:00+08:00`));
    await page.goto("/");
    await page.getByRole("button", { name: "与 AI 一起整理", exact: true }).click();
    const input = page.getByLabel("AI 输入内容", { exact: true });
    await expect(input).toBeVisible();
    await input.fill(message);
    const responseReady = page.waitForResponse((response) => response.url().includes("/api/v1/conversations/") && response.url().endsWith("/messages") && response.request().method() === "POST" && response.status() === 201);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const response = await responseReady;
    const body = (await response.json()) as { conversation: { id: string }; messages: Array<{ role: string; content: string }> };
    conversationId = body.conversation.id;
    expect(body.messages.at(-1)?.role).toBe("assistant");
    await expect(page.locator(".conversation-thread").getByText(message, { exact: true })).toBeVisible();
    await expect(page.locator(".conversation-message.assistant")).toHaveCount(1);

    await page.reload();
    await page.getByRole("button", { name: "与 AI 一起整理", exact: true }).click();
    await expect(page.locator(".conversation-thread").getByText(message, { exact: true })).toBeVisible();
    await expect(page.locator(".conversation-message.assistant")).toHaveCount(1);

    await page.locator(".ai-drawer").getByRole("button", { name: "关闭 AI 助手", exact: true }).click();
    await page.locator(".app-rail").getByRole("button", { name: "复盘", exact: true }).click();
    await expect(page.getByRole("heading", { name: "与 AI 的交流", exact: true })).toBeVisible();
    await expect(page.locator(".review-software-conversations").getByText(message, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "结束今日复盘并生成简报", exact: true })).toBeDisabled();

    const conversations = await db.select({ id: appConversations.id }).from(appConversations).where(eq(appConversations.localDate, localDate));
    expect(conversations).toHaveLength(1);
    const persistedMessages = await db.select({ id: appConversationMessages.id }).from(appConversationMessages).where(eq(appConversationMessages.conversationId, conversations[0]!.id));
    expect(persistedMessages).toHaveLength(2);
    const reviews = await db.select({ id: reviewSessions.id }).from(reviewSessions).where(eq(reviewSessions.localDate, localDate));
    reviewId = reviews[0]?.id ?? null;
    expect(await db.select({ id: reviewMessages.id }).from(reviewMessages).where(eq(reviewMessages.reviewSessionId, reviewId!))).toHaveLength(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator(".mobile-nav").getByRole("button", { name: "复盘", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(page.locator(".review-software-conversations").getByText(message, { exact: true })).toBeVisible();
  } finally {
    if (reviewId) await db.delete(reviewSessions).where(eq(reviewSessions.id, reviewId));
    if (conversationId) {
      await db.delete(appConversationMessages).where(eq(appConversationMessages.conversationId, conversationId));
      await db.delete(appConversations).where(eq(appConversations.id, conversationId));
    }
    await client.end();
  }
});
