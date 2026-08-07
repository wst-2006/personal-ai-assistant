import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { cyberDiaries, dailyBriefs, focusSessions, reviewMessages, reviewSessions, taskFeedback, taskOutcomes, tasks } from "@personal-ai/db/schema";
import { eq } from "drizzle-orm";

test("复盘消息与每日简报通过真实 API 持久保存、编辑、刷新并导出", async ({ page }) => {
  test.setTimeout(120_000);
  const suffix = Date.now().toString(36);
  const localDate = `2099-12-${String(10 + (Date.now() % 10)).padStart(2, "0")}`;
  const ids = {
    review: randomUUID(),
    task: randomUUID(),
    focus: randomUUID(),
    outcome: randomUUID(),
    feedback: randomUUID(),
  };
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  let briefId: string | null = null;

  try {
    await db.transaction(async (transaction) => {
      await transaction.insert(reviewSessions).values({
        id: ids.review,
        localDate,
        state: "review_open",
      });
      await transaction.insert(tasks).values({
        id: ids.task,
        title: `E2E 复盘任务 ${suffix}`,
        lifecycleStatus: "closed",
        currentOutcome: "complete",
        scheduleKind: "exact",
        localDate,
        timeZone: "Asia/Shanghai",
        startAt: new Date(`${localDate}T01:00:00.000Z`),
        endAt: new Date(`${localDate}T02:30:00.000Z`),
      });
      await transaction.insert(focusSessions).values({
        id: ids.focus,
        taskId: ids.task,
        state: "evaluated",
        rawActiveSeconds: 5_400,
        effectiveFocusSeconds: 4_800,
      });
      await transaction.insert(taskOutcomes).values({
        id: ids.outcome,
        taskId: ids.task,
        focusSessionId: ids.focus,
        outcome: "complete",
        progressPercent: 100,
        source: "app",
      });
      await transaction.insert(taskFeedback).values({
        id: ids.feedback,
        taskId: ids.task,
        focusSessionId: ids.focus,
        satisfaction: "satisfied",
        note: `E2E feedback ${suffix}`,
      });
    });

    await page.clock.setFixedTime(new Date(`${localDate}T21:00:00+08:00`));
    await page.goto("/");
    await page.locator(".app-rail").getByRole("button", { name: "复盘", exact: true }).click();
    await expect(page.getByRole("heading", { name: "把今天还给自己。", exact: true })).toBeVisible();
    await expect(page.getByText(`E2E 复盘任务 ${suffix}`, { exact: true })).toHaveCount(0);
    await expect(page.locator(".review-checkin")).toContainText("90m");
    await expect(page.locator(".review-checkin")).toContainText("80m");

    const message = `E2E 复盘消息 ${suffix}：完成了核心任务，也记录了今天的节奏。`;
    await page.getByLabel("复盘正文", { exact: true }).fill(message);
    const messageSaved = page.waitForResponse((response) => response.url().endsWith(`/api/v1/reviews/${ids.review}/messages`) && response.request().method() === "POST" && response.status() === 201);
    await page.getByRole("button", { name: "只保存片段", exact: true }).click();
    await messageSaved;
    await expect(page.locator(".review-stream").getByText(message, { exact: true })).toBeVisible();

    const briefCreated = page.waitForResponse((response) => response.url().endsWith(`/api/v1/reviews/${ids.review}/briefs`) && response.request().method() === "POST" && response.status() === 201);
    await page.getByRole("button", { name: "结束今日复盘并生成简报", exact: true }).click();
    const createdBrief = (await (await briefCreated).json()) as { brief: { id: string; state: string; content: { sections: Array<{ title: string }> } } };
    briefId = createdBrief.brief.id;
    expect(createdBrief.brief.state).toBe("draft");
    expect(createdBrief.brief.content.sections.some((section) => section.title === "给今天的一句话")).toBe(true);
    await expect(page.getByText("每日简报草稿", { exact: true })).toBeVisible();

    const confirmResponse = page.waitForResponse((response) => response.url().endsWith(`/api/v1/briefs/${briefId}`) && response.request().method() === "PATCH");
    await page.getByRole("button", { name: "确认简报", exact: true }).click();
    await confirmResponse;
    await expect(page.getByText("每日简报 · 已确认", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "编辑简报", exact: true }).click();
    const editedTitle = `E2E 已编辑简报 ${suffix}`;
    const editedSectionTitle = `E2E 金融板块 ${suffix}`;
    const editedSummary = `E2E 已编辑任务摘要 ${suffix}`;
    await page.getByLabel("简报标题", { exact: true }).fill(editedTitle);
    await page.getByLabel("第 1 个简报板块标题", { exact: true }).fill(editedSectionTitle);
    await page.getByLabel("简报任务摘要", { exact: true }).fill(editedSummary);
    const briefSaved = page.waitForResponse((response) => response.url().endsWith(`/api/v1/briefs/${briefId}`) && response.request().method() === "PATCH" && response.status() === 200);
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await briefSaved;
    await expect(page.getByLabel("简报任务摘要", { exact: true })).toHaveValue(editedSummary);

    await page.reload();
    await page.locator(".app-rail").getByRole("button", { name: "复盘", exact: true }).click();
    await expect(page.locator(".review-stream").getByText(message, { exact: true })).toBeVisible();
    await expect(page.getByText("每日简报 · 已确认", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: editedTitle, exact: true })).toBeVisible();
    await expect(page.getByLabel("简报任务摘要", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("简报任务摘要", { exact: true })).toHaveValue(editedSummary);
    await expect(page.getByLabel("简报来源", { exact: true })).toContainText("复盘正文与本项目任务数据");

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出简报", exact: true }).click();
    expect((await download).suggestedFilename()).toBe(`${localDate}-daily-brief.txt`);

    const persistedMessage = await db.select({ id: reviewMessages.id }).from(reviewMessages).where(eq(reviewMessages.reviewSessionId, ids.review));
    const persistedBrief = await db.select({ id: dailyBriefs.id, state: dailyBriefs.state, content: dailyBriefs.content }).from(dailyBriefs).where(eq(dailyBriefs.id, briefId));
    expect(persistedMessage).toHaveLength(1);
    expect(persistedBrief).toHaveLength(1);
    expect(persistedBrief[0]?.state).toBe("confirmed");
    const persistedContent = persistedBrief[0]?.content as { title: string; taskSummary: string; sections: Array<{ title: string }> };
    expect(persistedContent).toMatchObject({ title: editedTitle, taskSummary: editedSummary });
    expect(persistedContent.sections[0]?.title).toBe(editedSectionTitle);
    expect(persistedContent.sections.some((section) => section.title === "给今天的一句话")).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator(".mobile-nav").getByRole("button", { name: "复盘", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(page.locator(".review-stream").getByText(message, { exact: true })).toBeVisible();
    await expect(page.getByText("每日简报 · 已确认", { exact: true })).toBeVisible();
  } finally {
    await db.delete(cyberDiaries).where(eq(cyberDiaries.reviewSessionId, ids.review));
    if (briefId) await db.delete(dailyBriefs).where(eq(dailyBriefs.id, briefId));
    await db.delete(taskFeedback).where(eq(taskFeedback.id, ids.feedback));
    await db.delete(taskOutcomes).where(eq(taskOutcomes.id, ids.outcome));
    await db.delete(focusSessions).where(eq(focusSessions.id, ids.focus));
    await db.delete(tasks).where(eq(tasks.id, ids.task));
    await db.delete(reviewMessages).where(eq(reviewMessages.reviewSessionId, ids.review));
    await db.delete(reviewSessions).where(eq(reviewSessions.id, ids.review));
    await client.end();
  }
});
