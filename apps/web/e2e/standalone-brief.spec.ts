import { expect, test } from "@playwright/test";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { cyberDiaries, dailyBriefs, reviewSessions } from "@personal-ai/db/schema";
import { eq } from "drizzle-orm";

test("普通对话显式生成独立简报，刷新后保留且不创建复盘日记", async ({ page }) => {
  test.setTimeout(120_000);
  const suffix = Date.now().toString(36);
  const localDate = `2099-11-${String(10 + (Date.now() % 10)).padStart(2, "0")}`;
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  let briefId: string | null = null;
  try {
    await page.clock.setFixedTime(new Date(`${localDate}T10:00:00+08:00`));
    await page.goto("/");
    const openDrawer = page.getByRole("button", { name: "与 AI 一起整理", exact: true });
    await expect(openDrawer).toHaveCount(1);
    await openDrawer.click();
    const input = page.getByLabel("AI 输入内容", { exact: true });
    await expect(input).toBeVisible();
    await input.fill(`E2E 独立简报内容 ${suffix}：整理今天读到的研究想法。`);
    const create = page.waitForResponse((response) => response.url().endsWith("/api/v1/briefs/standalone") && response.request().method() === "POST" && response.status() === 201);
    await page.getByRole("button", { name: "用这段话生成独立简报", exact: true }).click();
    const created = (await (await create).json()) as { brief: { id: string; reviewSessionId: string | null; state: string; sources: Array<{ provider?: string }> } };
    briefId = created.brief.id;
    expect(created.brief.reviewSessionId).toBeNull();
    expect(created.brief.state).toBe("confirmed");
    if (process.env.TAVILY_SEARCH_API_KEY?.trim()) {
      expect(created.brief.sources.some((source) => source.provider === "tavily_search")).toBe(true);
    }
    await expect(page.getByText("独立简报 · 已保存", { exact: true })).toBeVisible();
    await expect(page.getByText(`E2E 独立简报内容 ${suffix}`, { exact: false })).toBeVisible();

    await page.reload();
    await page.getByRole("button", { name: "与 AI 一起整理", exact: true }).click();
    await expect(page.getByRole("heading", { name: "今日独立简报", exact: true })).toBeVisible();
    await expect(page.getByText(`E2E 独立简报内容 ${suffix}`, { exact: false })).toBeVisible();

    const reviewRows = await db.select({ id: reviewSessions.id }).from(reviewSessions).where(eq(reviewSessions.localDate, localDate));
    const diaryRows = await db.select({ id: cyberDiaries.id }).from(cyberDiaries).where(eq(cyberDiaries.localDate, localDate));
    expect(reviewRows).toHaveLength(0);
    expect(diaryRows).toHaveLength(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByRole("button", { name: "与 AI 一起整理", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(page.getByRole("heading", { name: "今日独立简报", exact: true })).toBeVisible();
  } finally {
    if (briefId) await db.delete(dailyBriefs).where(eq(dailyBriefs.id, briefId));
    await client.end();
  }
});
