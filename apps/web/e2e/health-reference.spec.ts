import { expect, test, type Page } from "@playwright/test";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { healthDailyReferences, healthWeekPlans, reminderJobs, taskConflictAcceptances, taskFeedback, taskLifecycleEvents, taskOutcomes, tasks } from "@personal-ai/db/schema";
import { and, eq, inArray, or } from "drizzle-orm";

const apiBase = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:3100";
const healthContent = (overview = "这是等待用户确认的测试健康参考。") => ({
  overview,
  supplements: ["仅供查看，不自动改变任何安排。"],
  days: Array.from({ length: 7 }, () => ({
    nutritionDirection: "维持正常餐盘结构，并按当天实际情况选择。",
    proteinRangeGrams: { minimum: 90, maximum: 120 },
    plateGuidance: ["每餐有主要蛋白质来源。"],
    seasonalVegetables: ["番茄"],
    seasonalGuidance: "结合当天实际天气和体感，自主决定外出与活动强度。",
    seasonalPoem: { title: "山居秋暝", author: "王维", excerpt: "空山新雨后，天气晚来秋。", relevance: "只作为真实诗词的时令阅读候选。" },
    movement: { category: "strength", durationMinutes: { minimum: 30, maximum: 60 }, intensity: "moderate", highIntensity: false, safetyReminder: "按当天实际舒适度决定。" }
  }))
});

async function seedCandidate(page: Page, weekStart: string) {
  await cleanupWeek(weekStart);
  const response = await page.request.post(`${apiBase}/api/v1/health/weeks/manual-candidates`, { data: { weekStart, content: healthContent() } });
  expect(response.status()).toBe(201);
}

async function cleanupWeek(weekStart: string) {
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  try {
    const plans = await db.select({ id: healthWeekPlans.id }).from(healthWeekPlans).where(eq(healthWeekPlans.weekStart, weekStart));
    if (plans.length) {
      await db.transaction(async (transaction) => {
        await transaction.delete(healthDailyReferences).where(inArray(healthDailyReferences.healthWeekPlanId, plans.map((plan) => plan.id)));
        await transaction.delete(healthWeekPlans).where(eq(healthWeekPlans.weekStart, weekStart));
      });
    }
  } finally { await client.end(); }
}

async function cleanupTask(taskId: string | null) {
  if (!taskId) return;
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  try {
    await db.delete(taskConflictAcceptances).where(or(eq(taskConflictAcceptances.taskIdLow, taskId), eq(taskConflictAcceptances.taskIdHigh, taskId)));
    await db.delete(reminderJobs).where(eq(reminderJobs.taskId, taskId));
    await db.delete(taskFeedback).where(eq(taskFeedback.taskId, taskId));
    await db.delete(taskOutcomes).where(eq(taskOutcomes.taskId, taskId));
    await db.delete(taskLifecycleEvents).where(eq(taskLifecycleEvents.taskId, taskId));
    await db.delete(tasks).where(eq(tasks.id, taskId));
  } finally { await client.end(); }
}

test("健康参考候选经确认后持久化，且不创建任务", async ({ page }) => {
  test.setTimeout(60_000);
  const weekStart = "2099-01-04";
  let taskWrites = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/v1/tasks") && request.method() === "POST") taskWrites += 1; });

  try {
    await page.clock.setFixedTime(new Date("2099-01-04T10:00:00+08:00"));
    await seedCandidate(page, weekStart);
    await page.goto("/");
    await page.getByRole("button", { name: "健康", exact: true }).click();
    await expect(page.getByText("候选尚未生效", { exact: true })).toBeVisible();
    await expect(page.getByText("蛋白质约 90–120 g / 天", { exact: true })).toBeVisible();
    expect(taskWrites).toBe(0);

    await page.getByRole("button", { name: "确认并使用", exact: true }).click();
    await expect(page.getByText("本周生效版本", { exact: true })).toBeVisible();
    expect(taskWrites).toBe(0);

    await page.reload();
    await page.getByRole("button", { name: "健康", exact: true }).click();
    await expect(page.getByText("本周生效版本", { exact: true })).toBeVisible();
    await expect(page.getByText("本周参考不会因一天睡眠或运动变化自动改写。", { exact: true })).toBeVisible();
  } finally { await cleanupWeek(weekStart); }
});

test("390px 移动端可查看健康候选且不发生横向溢出", async ({ page }) => {
  const weekStart = "2099-01-11";
  try {
    await page.clock.setFixedTime(new Date("2099-01-11T10:00:00+08:00"));
    await seedCandidate(page, weekStart);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: "健康", exact: true }).click();
    await expect(page.getByText("候选尚未生效", { exact: true })).toBeVisible();
    await expect(page.getByLabel("本周健康特殊情况")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally { await cleanupWeek(weekStart); }
});

test("手动编辑周参考会持久化为待确认候选，并只在确认后替换生效版本", async ({ page }) => {
  test.setTimeout(60_000);
  const weekStart = "2099-02-01";
  const revisedOverview = "这是用户手动调整后、等待确认的本周健康参考。";
  const revisedSundayDirection = "周日优先按舒适度安排进食与轻量活动。";
  const writes: Array<{ method: string; url: string }> = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/health/weeks/")) writes.push({ method: request.method(), url: request.url() });
  });

  try {
    await page.clock.setFixedTime(new Date("2099-02-01T10:00:00+08:00"));
    await seedCandidate(page, weekStart);
    await page.goto("/");
    await page.getByRole("button", { name: "健康", exact: true }).click();
    await expect(page.getByText("候选尚未生效", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "手动编辑候选", exact: true }).click();
    await expect(page.getByText("手动周参考候选", { exact: true })).toBeVisible();
    await page.getByLabel("本周概览").fill(revisedOverview);
    await page.getByLabel("周日饮食方向").fill(revisedSundayDirection);
    await page.getByRole("button", { name: "保存为待确认候选", exact: true }).click();
    await expect(page.getByText("由你手动编辑的候选，确认后才会替换本周参考。", { exact: true })).toBeVisible();
    expect(writes.some((write) => write.method === "PUT" && write.url.endsWith("/manual-candidate"))).toBe(true);

    await page.reload();
    await page.getByRole("button", { name: "健康", exact: true }).click();
    await expect(page.getByText(revisedOverview, { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: /周日/ }).click();
    await expect(page.getByText(revisedSundayDirection, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "确认并使用", exact: true }).click();
    await expect(page.getByText("本周生效版本", { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "健康", exact: true }).click();
    await expect(page.getByText("本周生效版本", { exact: true })).toBeVisible();
    await expect(page.getByText(revisedOverview, { exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "手动编辑候选", exact: true }).click();
    await expect(page.getByText("手动周参考候选", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally { await cleanupWeek(weekStart); }
});

test("今日摘要、健康问答和转任务流程都保持用户确认边界", async ({ page }) => {
  test.setTimeout(75_000);
  const weekStart = "2099-06-07";
  let taskId: string | null = null;
  let taskWrites = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/v1/tasks") && request.method() === "POST") taskWrites += 1; });
  try {
    await page.clock.setFixedTime(new Date("2099-06-07T09:00:00+08:00"));
    await seedCandidate(page, weekStart);
    await page.goto("/");
    await page.getByRole("button", { name: "健康", exact: true }).click();
    await expect(page.getByText("候选尚未生效", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "确认并使用", exact: true }).click();
    await expect(page.getByText("本周生效版本", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "今日", exact: true }).click();
    const summary = page.getByLabel("今日健康参考摘要");
    await expect(summary).toContainText("力量训练");
    await summary.getByRole("button", { name: /今日健康参考/ }).click();
    await expect(summary).toContainText("蛋白质来源");
    await summary.getByRole("button", { name: "打开完整健康参考", exact: true }).click();

    await page.getByRole("button", { name: "询问具体饮食", exact: true }).click();
    await expect(page.getByLabel("AI 输入内容")).toHaveValue(/不要自动修改本周健康参考/);
    await page.getByRole("complementary", { name: "AI 助手" }).getByLabel("关闭 AI 助手").click();

    await page.getByRole("button", { name: "转为任务并重新排期", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "重新确认任务的开始和结束时间" });
    await expect(dialog).toContainText("原健康参考会继续保留");
    expect(taskWrites).toBe(0);
    await expect(dialog.getByLabel("开始时间")).toHaveValue("");
    await expect(dialog.getByLabel("结束时间")).toHaveValue("");
    await dialog.getByLabel("开始时间").fill("12:00");
    await dialog.getByLabel("结束时间").fill("13:00");
    const created = page.waitForResponse((response) => response.url().endsWith("/api/v1/tasks") && response.request().method() === "POST" && response.status() === 201);
    await dialog.getByRole("button", { name: "确认时间并创建任务", exact: true }).click();
    taskId = ((await (await created).json()) as { task: { id: string } }).task.id;
    expect(taskWrites).toBe(1);
    await expect(page.locator(`[data-task-id="${taskId}"]`)).toContainText("力量训练（健康参考）");

    await page.reload();
    await expect(page.locator(`[data-task-id="${taskId}"]`)).toContainText("12:00–13:00");
    await page.getByRole("button", { name: "健康", exact: true }).click();
    await expect(page.getByText("本周生效版本", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "今日", exact: true }).click();
    await page.getByLabel("今日健康参考摘要").getByRole("button", { name: /今日健康参考/ }).click();
    await expect(page.getByLabel("今日健康参考摘要")).toContainText("打开完整健康参考");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
    try {
      expect(await db.select().from(tasks).where(eq(tasks.id, taskId))).toHaveLength(1);
      expect((await db.select().from(healthWeekPlans).where(andWeek(weekStart, "active"))).length).toBe(1);
    } finally { await client.end(); }
  } finally {
    await cleanupTask(taskId);
    await cleanupWeek(weekStart);
  }
});

function andWeek(weekStart: string, state: string) {
  return and(eq(healthWeekPlans.weekStart, weekStart), eq(healthWeekPlans.state, state));
}
