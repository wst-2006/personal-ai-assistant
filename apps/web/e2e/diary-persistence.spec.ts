import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { cyberDiaries, dailyBriefs, focusSessions, reviewMessages, reviewSessions, taskFeedback, taskOutcomes, tasks } from "@personal-ai/db/schema";
import { eq } from "drizzle-orm";

test("赛博日记读取真实日数据、持久保存、刷新恢复并导出", async ({ page }) => {
  const suffix = Date.now().toString(36);
  const dateSeed = randomUUID().replaceAll("-", "");
  const localDate = `${2200 + (Number.parseInt(dateSeed.slice(0, 4), 16) % 500)}-${String(1 + (Number.parseInt(dateSeed.slice(4, 6), 16) % 12)).padStart(2, "0")}-${String(1 + (Number.parseInt(dateSeed.slice(6, 8), 16) % 28)).padStart(2, "0")}`;
  const previousMonthDate = new Date(`${localDate}T12:00:00Z`);
  previousMonthDate.setUTCMonth(previousMonthDate.getUTCMonth() - 1);
  const previousMonth = previousMonthDate.toISOString().slice(0, 7);
  const ids = { review: randomUUID(), message: randomUUID(), brief: randomUUID(), task: randomUUID(), focus: randomUUID(), outcome: randomUUID(), feedback: randomUUID() };
  const briefContent = { title: `${localDate} 的每日简报`, reflection: `E2E 复盘 ${suffix}`, taskSummary: "完成了一项深度任务。", sections: [], location: { name: "上海", latitude: 31.23, longitude: 121.47, timeZone: "Asia/Shanghai" }, weather: { temperatureCelsius: 26, apparentTemperatureCelsius: 27, weatherCode: 1, observedAt: `${localDate}T10:00:00+08:00` } };
  let diaryId: string | null = null;
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  try {
    await db.transaction(async (transaction) => {
      await transaction.insert(reviewSessions).values({ id: ids.review, localDate, state: "review_has_message" });
      await transaction.insert(reviewMessages).values({ id: ids.message, reviewSessionId: ids.review, source: "app", content: `E2E 复盘 ${suffix}` });
      await transaction.insert(dailyBriefs).values({
        id: ids.brief, localDate, reviewSessionId: ids.review, state: "confirmed",
        content: briefContent,
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
    await expect(page.getByText("主线推进", { exact: true })).toBeVisible();
    await expect(page.getByText("总体执行", { exact: true })).toBeVisible();
    await expect(page.getByText("专注质量", { exact: true })).toBeVisible();
    await expect(page.getByText("精力状态", { exact: true })).toBeVisible();
    const energyRow = page.locator(".diary-radar-row").filter({ hasText: "精力状态" });
    await energyRow.getByRole("button", { name: "填写", exact: true }).click();
    await page.getByLabel("精力状态评分", { exact: true }).fill("80");
    await page.getByLabel("总体执行评分", { exact: true }).fill("85");
    await page.getByRole("button", { name: "整理为草稿", exact: true }).click();
    await page.getByLabel("日记正文", { exact: true }).fill(`E2E 持久正文 ${suffix}`);
    const saved = page.waitForResponse((response) => response.url().endsWith(`/api/v1/diaries/${localDate}`) && response.request().method() === "PUT" && response.status() === 200);
    await page.getByRole("button", { name: "确认并保存赛博日记", exact: true }).click();
    diaryId = ((await (await saved).json()) as { diary: { id: string } }).diary.id;
    const storedDiary = (await db.select({ content: cyberDiaries.content }).from(cyberDiaries).where(eq(cyberDiaries.id, diaryId)))[0];
    const storedContent = storedDiary?.content as {
      radar?: { energyState?: number; overallExecution?: number };
      snapshot?: { version: number; capturedAt: string; dayData: { effectiveFocusMinutes: number; tasks: Array<{ title: string }> }; brief: { content: { location?: { name: string } } }; reviewMessages: unknown[]; taskFeedback: unknown[] };
    };
    expect(storedContent.radar).toMatchObject({ energyState: 80, overallExecution: 85 });
    expect(storedContent.snapshot).toMatchObject({ version: 1, dayData: { effectiveFocusMinutes: 60, tasks: [expect.objectContaining({ title: `E2E 日记任务 ${suffix}` })] }, brief: { content: { location: { name: "上海" } } } });
    expect(new Date(storedContent.snapshot!.capturedAt).toString()).not.toBe("Invalid Date");
    const initialSnapshotCapturedAt = storedContent.snapshot!.capturedAt;
    expect(storedContent.snapshot?.reviewMessages).toHaveLength(1);
    expect(storedContent.snapshot?.taskFeedback).toHaveLength(1);

    await db.transaction(async (transaction) => {
      await transaction.update(tasks).set({ title: `后续改动的任务 ${suffix}` }).where(eq(tasks.id, ids.task));
      await transaction.update(focusSessions).set({ rawActiveSeconds: 180, effectiveFocusSeconds: 120 }).where(eq(focusSessions.id, ids.focus));
      await transaction.update(dailyBriefs).set({
        content: { ...briefContent, location: { ...briefContent.location, name: "后续改动的城市" }, weather: { ...briefContent.weather, temperatureCelsius: 99 } },
        updatedAt: new Date()
      }).where(eq(dailyBriefs.id, ids.brief));
    });
    await page.reload();
    await page.locator(".app-rail").getByRole("button", { name: "日记", exact: true }).click();
    await expect(page.getByLabel("日记正文", { exact: true })).toHaveValue(`E2E 持久正文 ${suffix}`);
    await expect(page.getByLabel("精力状态评分", { exact: true })).toHaveValue("80");
    await expect(page.getByLabel("总体执行评分", { exact: true })).toHaveValue("85");
    await expect(page.getByRole("region", { name: "今日真实数据" })).toContainText("60m");
    await expect(page.getByText(`E2E 日记任务 ${suffix}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`后续改动的任务 ${suffix}`, { exact: true })).toHaveCount(0);
    await expect(page.getByText("上海", { exact: true })).toBeVisible();
    await expect(page.getByText("后续改动的城市", { exact: true })).toHaveCount(0);
    await page.getByLabel("日记正文", { exact: true }).fill(`E2E 二次编辑正文 ${suffix}`);
    const edited = page.waitForResponse((response) => response.url().endsWith(`/api/v1/diaries/${localDate}`) && response.request().method() === "PUT" && response.status() === 200);
    await page.getByRole("button", { name: "确认并保存赛博日记", exact: true }).click();
    await edited;
    const editedStoredDiary = (await db.select({ content: cyberDiaries.content }).from(cyberDiaries).where(eq(cyberDiaries.id, diaryId)))[0];
    const editedSnapshot = (editedStoredDiary?.content as { snapshot?: { capturedAt: string; dayData: { effectiveFocusMinutes: number }; brief: { content: { location?: { name: string } } } } }).snapshot;
    expect(editedSnapshot).toMatchObject({ capturedAt: initialSnapshotCapturedAt, dayData: { effectiveFocusMinutes: 60 }, brief: { content: { location: { name: "上海" } } } });
    const savedDayButton = page.getByRole("button", { name: `查看 ${localDate} 日记`, exact: true });
    await expect(savedDayButton).toHaveClass(/has-diary/);
    await expect(savedDayButton).toContainText("60m");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出日记", exact: true }).click();
    const exported = await download;
    expect(exported.suggestedFilename()).toBe(`${localDate}-cyber-diary.txt`);
    const exportedPath = await exported.path();
    expect(exportedPath).not.toBeNull();
    const exportedText = await readFile(exportedPath!, "utf8");
    expect(exportedText).toContain("六维回看");
    expect(exportedText).toContain("精力状态：80");
    expect(exportedText).toContain("有效专注：60 分钟");
    expect(exportedText).toContain("地点：上海");
    expect(exportedText).not.toContain("后续改动的城市");
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
