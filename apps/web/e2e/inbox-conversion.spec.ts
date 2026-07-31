import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { inboxEntries, reminderJobs, taskConflictAcceptances, taskFeedback, taskLifecycleEvents, taskOutcomes, tasks } from "@personal-ai/db/schema";
import { eq, or } from "drizzle-orm";

test("想法确认转换为正式任务后保留 inbox 源记录并持久恢复", async ({ page }) => {
  test.setTimeout(60_000);
  const suffix = Date.now().toString(36);
  const localDate = `2099-12-${String(20 + (Date.now() % 8)).padStart(2, "0")}`;
  const sourceContent = `E2E 想法原文 ${suffix}`;
  const formalTitle = `E2E 转换后的正式任务 ${suffix}`;
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  let entryId: string | null = null;
  let taskId: string | null = null;

  try {
    await page.clock.setFixedTime(new Date(`${localDate}T09:00:00+08:00`));
    await page.goto("/");
    await page.getByRole("button", { name: "想法", exact: true }).click();
    await expect(page.locator(".quick-capture").getByText("预计投入", { exact: true })).toHaveCount(0);
    await page.getByLabel("快速记录内容", { exact: true }).fill(sourceContent);
    const entryCreated = page.waitForResponse((response) => response.url().endsWith("/api/v1/inbox-entries") && response.request().method() === "POST" && response.status() === 201);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    entryId = ((await (await entryCreated).json()) as { entry: { id: string } }).entry.id;
    await expect(page.locator(".inbox-list")).toContainText(sourceContent);

    const entry = page.locator(".inbox-list article").filter({ hasText: sourceContent });
    await entry.getByRole("button", { name: "转为任务", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "让这项安排足够清楚" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("从收件箱建立任务");
    await dialog.getByLabel("任务标题", { exact: true }).fill(formalTitle);
    await dialog.locator("select").nth(0).selectOption("exact");
    await dialog.locator('input[type="time"]').nth(0).fill("10:00");
    await dialog.locator('input[type="time"]').nth(1).fill("11:00");
    await dialog.locator('input[type="number"]').fill("90");
    await dialog.locator("select").nth(1).selectOption("high");
    await dialog.locator("label").filter({ hasText: "任务类型" }).locator("input").fill("阅读");
    await dialog.locator('input[type="checkbox"]').check();
    await dialog.locator("label.field-wide").last().locator("textarea").fill(`E2E 转换备注 ${suffix}`);

    const converted = page.waitForResponse((response) => response.url().endsWith(`/api/v1/inbox-entries/${entryId}/convert-to-task`) && response.request().method() === "POST" && response.status() === 201);
    await dialog.getByRole("button", { name: "确认并转为任务", exact: true }).click();
    const conversion = (await (await converted).json()) as { entry: { id: string; convertedAt: string | null }; task: { id: string; sourceInboxEntryId: string | null; scheduleKind: string; localDate: string | null; startAt: string | null; endAt: string | null; plannedEffortMinutes: number | null; difficulty: string | null; taskType: string | null; requiresContinuousFocus: boolean | null } };
    taskId = conversion.task.id;
    expect(conversion.entry.id).toBe(entryId);
    expect(conversion.entry.convertedAt).toBeTruthy();
    expect(conversion.task.sourceInboxEntryId).toBe(entryId);
    expect(conversion.task.scheduleKind).toBe("exact");
    expect(conversion.task.localDate).toBe(localDate);
    expect(conversion.task.startAt).toContain("02:00:00.000Z");
    expect(conversion.task.endAt).toContain("03:00:00.000Z");
    expect(conversion.task.plannedEffortMinutes).toBe(90);
    expect(conversion.task.difficulty).toBe("high");
    expect(conversion.task.taskType).toBe("阅读");
    expect(conversion.task.requiresContinuousFocus).toBe(true);

    await expect(page.locator(`[data-task-id="${taskId}"]`)).toContainText(formalTitle);
    await page.reload();
    await expect(page.locator(`[data-task-id="${taskId}"]`)).toContainText("10:00–11:00");
    await expect(page.locator(`[data-task-id="${taskId}"]`)).toContainText(formalTitle);
    await expect(page.locator(".inbox-list").getByText(sourceContent, { exact: true })).toHaveCount(0);

    const persistedEntry = await db.select().from(inboxEntries).where(eq(inboxEntries.id, entryId));
    const persistedTask = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(persistedEntry).toHaveLength(1);
    expect(persistedEntry[0]?.deletedAt).toBeNull();
    expect(persistedEntry[0]?.convertedAt).not.toBeNull();
    expect(persistedTask).toHaveLength(1);
    expect(persistedTask[0]?.sourceInboxEntryId).toBe(entryId);
  } finally {
    if (taskId) {
      await db.delete(taskConflictAcceptances).where(or(eq(taskConflictAcceptances.taskIdLow, taskId), eq(taskConflictAcceptances.taskIdHigh, taskId)));
      await db.delete(reminderJobs).where(eq(reminderJobs.taskId, taskId));
      await db.delete(taskFeedback).where(eq(taskFeedback.taskId, taskId));
      await db.delete(taskOutcomes).where(eq(taskOutcomes.taskId, taskId));
      await db.delete(taskLifecycleEvents).where(eq(taskLifecycleEvents.taskId, taskId));
      await db.delete(tasks).where(eq(tasks.id, taskId));
    }
    if (entryId) await db.delete(inboxEntries).where(eq(inboxEntries.id, entryId));
    await client.end();
  }
});

test("转换时发现 inbox 版本过期会保留表单并给出明确提示", async ({ page }) => {
  test.setTimeout(60_000);
  const suffix = Date.now().toString(36);
  const localDate = `2099-12-${String(20 + (Date.now() % 8)).padStart(2, "0")}`;
  const sourceContent = `E2E 过期想法 ${suffix}`;
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  let entryId: string | null = null;

  try {
    await page.clock.setFixedTime(new Date(`${localDate}T09:00:00+08:00`));
    await page.goto("/");
    await page.getByRole("button", { name: "想法", exact: true }).click();
    await page.getByLabel("快速记录内容", { exact: true }).fill(sourceContent);
    const entryCreated = page.waitForResponse((response) => response.url().endsWith("/api/v1/inbox-entries") && response.request().method() === "POST" && response.status() === 201);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    entryId = ((await (await entryCreated).json()) as { entry: { id: string } }).entry.id;

    const entry = page.locator(".inbox-list article").filter({ hasText: sourceContent });
    await entry.getByRole("button", { name: "转为任务", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "让这项安排足够清楚" });
    await expect(dialog).toBeVisible();
    await db.update(inboxEntries).set({ version: 2, updatedAt: new Date() }).where(eq(inboxEntries.id, entryId));

    const rejected = page.waitForResponse((response) => response.url().endsWith(`/api/v1/inbox-entries/${entryId}/convert-to-task`) && response.request().method() === "POST" && response.status() === 409);
    await dialog.getByRole("button", { name: "确认并转为任务", exact: true }).click();
    await rejected;
    await expect(page.getByText("这条想法已被其他位置更新或转换，请刷新后重新整理。", { exact: true })).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("任务标题", { exact: true })).toHaveValue(sourceContent);

    const persistedEntry = await db.select().from(inboxEntries).where(eq(inboxEntries.id, entryId));
    expect(persistedEntry).toHaveLength(1);
    expect(persistedEntry[0]?.convertedAt).toBeNull();
    expect(persistedEntry[0]?.version).toBe(2);
  } finally {
    if (entryId) await db.delete(inboxEntries).where(eq(inboxEntries.id, entryId));
    await client.end();
  }
});
