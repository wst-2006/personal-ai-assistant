import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { cyberDiaries, dailyBriefs, focusSessions, reviewMessages, reviewSessions, taskFeedback, taskOutcomes, tasks } from "@personal-ai/db/schema";
import { eq } from "drizzle-orm";

test("赛博日记读取真实日数据、持久保存、刷新恢复并导出", async ({ page }) => {
  const suffix = Date.now().toString(36);
  const localDate = `2098-07-${String(10 + Number(BigInt(Date.now()) % 10n)).padStart(2, "0")}`;
  const previousMonthDate = new Date(`${localDate}T12:00:00Z`);
  previousMonthDate.setUTCMonth(previousMonthDate.getUTCMonth() - 1);
  const previousMonth = previousMonthDate.toISOString().slice(0, 7);
  const ids = { review: randomUUID(), message: randomUUID(), brief: randomUUID(), task: randomUUID(), focus: randomUUID(), outcome: randomUUID(), feedback: randomUUID() };
  let diaryId: string | null = null;
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  try {
    await db.transaction(async (transaction) => {
      await transaction.insert(reviewSessions).values({ id: ids.review, localDate, state: "review_has_message" });
      await transaction.insert(reviewMessages).values({ id: ids.message, reviewSessionId: ids.review, source: "app", content: `E2E 复盘 ${suffix}` });
      await transaction.insert(dailyBriefs).values({
        id: ids.brief, localDate, reviewSessionId: ids.review, state: "confirmed",
        content: { title: `${localDate} 的每日简报`, reflection: `E2E 复盘 ${suffix}`, taskSummary: "完成了一项深度任务。", sections: [], location: { name: "上海", latitude: 31.23, longitude: 121.47, timeZone: "Asia/Shanghai" }, weather: { temperatureCelsius: 26, apparentTemperatureCelsius: 27, weatherCode: 1, observedAt: `${localDate}T10:00:00+08:00` } },
        sources: [{ kind: "personal_record", label: "E2E 隔离数据" }]
      });
      await transaction.insert(tasks).values({ id: ids.task, title: `E2E 日记任务 ${suffix}`, lifecycleStatus: "closed", currentOutcome: "complete", scheduleKind: "none", localDate });
      await transaction.insert(focusSessions).values({ id: ids.focus, taskId: ids.task, state: "evaluated", rawActiveSeconds: 4200, effectiveFocusSeconds: 3600 });
      await transaction.insert(taskOutcomes).values({ id: ids.outcome, taskId: ids.task, focusSessionId: ids.focus, outcome: "complete", progressPercent: 100, source: "app" });
      await transaction.insert(taskFeedback).values({ id: ids.feedback, taskId: ids.task, focusSessionId: ids.focus, satisfaction: "satisfied" });
    });

    await page.clock.setFixedTime(new Date(`${localDate}T10:00:00+08:00`));
    await page.goto("/");
    await page.locator(".app-rail").getByRole("button", { name: "日记", exact: true }).click();
    await expect(page.getByRole("region", { name: `${localDate.slice(0, 7)} 日记月视图` })).toBeVisible();
    await expect(page.getByRole("button", { name: `查看 ${localDate} 日记`, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("region", { name: "今日真实数据" })).toContainText("60m");
    await expect(page.getByText(`E2E 日记任务 ${suffix}`, { exact: true })).toBeVisible();
    await expect(page.getByText("上海", { exact: true })).toBeVisible();
    await expect(page.getByText("常青树", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "整理为草稿", exact: true }).click();
    await page.getByLabel("日记正文", { exact: true }).fill(`E2E 持久正文 ${suffix}`);
    const saved = page.waitForResponse((response) => response.url().endsWith(`/api/v1/diaries/${localDate}`) && response.request().method() === "PUT" && response.status() === 200);
    await page.getByRole("button", { name: "保存日记", exact: true }).click();
    diaryId = ((await (await saved).json()) as { diary: { id: string } }).diary.id;
    await page.reload();
    await page.locator(".app-rail").getByRole("button", { name: "日记", exact: true }).click();
    await expect(page.getByLabel("日记正文", { exact: true })).toHaveValue(`E2E 持久正文 ${suffix}`);
    await expect(page.getByRole("button", { name: `查看 ${localDate} 日记`, exact: true })).toHaveClass(/has-diary/);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出日记", exact: true }).click();
    expect((await download).suggestedFilename()).toBe(`${localDate}-cyber-diary.txt`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator(".mobile-nav").getByRole("button", { name: "日记", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(page.getByRole("region", { name: "今日真实数据" })).toBeVisible();
    await page.getByRole("button", { name: "上个月", exact: true }).click();
    await expect(page.getByRole("region", { name: `${previousMonth} 日记月视图` })).toBeVisible();
    await page.getByRole("button", { name: "下个月", exact: true }).click();
    await expect(page.getByRole("button", { name: `查看 ${localDate} 日记`, exact: true })).toHaveAttribute("aria-pressed", "true");
  } finally {
    if (diaryId) await db.delete(cyberDiaries).where(eq(cyberDiaries.id, diaryId));
    await db.delete(taskFeedback).where(eq(taskFeedback.id, ids.feedback));
    await db.delete(taskOutcomes).where(eq(taskOutcomes.id, ids.outcome));
    await db.delete(focusSessions).where(eq(focusSessions.id, ids.focus));
    await db.delete(tasks).where(eq(tasks.id, ids.task));
    await db.delete(dailyBriefs).where(eq(dailyBriefs.id, ids.brief));
    await db.delete(reviewMessages).where(eq(reviewMessages.id, ids.message));
    await db.delete(reviewSessions).where(eq(reviewSessions.id, ids.review));
    await client.end();
  }
});
