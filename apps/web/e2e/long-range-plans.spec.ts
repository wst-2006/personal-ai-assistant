import { expect, test, type APIRequestContext } from "@playwright/test";
import { inArray } from "drizzle-orm";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { longRangePlanMilestones, longRangePlans } from "@personal-ai/db/schema";

const apiBase = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:3100";

async function cleanupPlans(ids: string[]) {
  if (!ids.length) return;
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  try {
    await db.transaction(async (transaction) => {
      await transaction.delete(longRangePlanMilestones).where(inArray(longRangePlanMilestones.longRangePlanId, ids));
      await transaction.delete(longRangePlans).where(inArray(longRangePlans.id, ids));
    });
  } finally {
    await client.end();
  }
}

async function updateThroughApi(request: APIRequestContext, id: string, version: number, title: string) {
  const response = await request.put(`${apiBase}/api/v1/long-range-plans/${id}`, {
    data: {
      expectedVersion: version,
      scope: "month",
      title,
      periodStart: "2099-04-01",
      periodEnd: "2099-04-30",
      description: "来自浏览器验收的版本冲突检查。",
      milestones: [{ title: "资料收集", targetDate: "2099-04-08", notes: "先整理来源" }]
    }
  });
  expect(response.status()).toBe(200);
  return (await response.json()).plan as { version: number };
}

test("月度规划通过真实 API 持久化、编辑、提示过期版本、归档并恢复", async ({ page, request }) => {
  test.setTimeout(60_000);
  const suffix = Date.now().toString(36);
  const title = `E2E 月度主线 ${suffix}`;
  const editedTitle = `E2E 月度主线已编辑 ${suffix}`;
  const ids: string[] = [];
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "规划", exact: true }).click();
    await expect(page.getByRole("heading", { name: "把目光放远，也把决定留在自己手里。" })).toBeVisible();
    await page.getByRole("button", { name: "新建规划", exact: true }).click();
    await page.getByLabel("规划标题").fill(title);
    await page.getByRole("combobox", { name: "规划范围", exact: true }).selectOption("month");
    await page.getByLabel("开始日期").fill("2099-04-01");
    await page.getByLabel("结束日期").fill("2099-04-30");
    await page.getByLabel("规划说明").fill("浏览器验收的月度主线不会自动创建任务。");
    await page.getByRole("button", { name: "添加节点", exact: true }).click();
    await page.getByLabel("里程碑 1", { exact: true }).fill("资料收集");
    await page.getByLabel("里程碑 1 目标日期", { exact: true }).fill("2099-04-08");
    await page.getByLabel("里程碑 1 说明", { exact: true }).fill("先整理来源");
    let taskWrites = 0;
    page.on("request", (browserRequest) => {
      if (browserRequest.url().endsWith("/api/v1/tasks") && browserRequest.method() === "POST") taskWrites += 1;
    });
    const created = page.waitForResponse((response) => response.url() === `${apiBase}/api/v1/long-range-plans` && response.request().method() === "POST" && response.status() === 201);
    await page.getByRole("button", { name: "保存规划", exact: true }).click();
    const createdPlan = (await (await created).json()).plan as { id: string; version: number };
    ids.push(createdPlan.id);
    expect(taskWrites).toBe(0);
    await expect(page.getByLabel("里程碑 1", { exact: true })).toHaveValue("资料收集");

    await page.reload();
    await page.getByRole("button", { name: "规划", exact: true }).click();
    await page.locator(".long-range-item").filter({ hasText: title }).click();
    await expect(page.getByLabel("规划说明")).toHaveValue("浏览器验收的月度主线不会自动创建任务。");
    await expect(page.getByLabel("里程碑 1", { exact: true })).toHaveValue("资料收集");

    const saved = page.waitForResponse((response) => response.url().endsWith(`/api/v1/long-range-plans/${createdPlan.id}`) && response.request().method() === "PUT" && response.status() === 200);
    await page.getByLabel("规划标题").fill(editedTitle);
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    const savedPlan = (await (await saved).json()).plan as { version: number };
    await expect(page.locator(".long-range-item").filter({ hasText: editedTitle })).toBeVisible();

    await updateThroughApi(request, createdPlan.id, savedPlan.version, `${editedTitle} 已在另一处保存`);
    await page.getByLabel("规划说明").fill("这个本地草稿不能静默覆盖服务器上的新版本。");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("这份规划已经在另一处更新");
    await expect(page.getByLabel("规划说明")).toHaveValue("这个本地草稿不能静默覆盖服务器上的新版本。");

    await page.reload();
    await page.getByRole("button", { name: "规划", exact: true }).click();
    await page.locator(".long-range-item").filter({ hasText: `${editedTitle} 已在另一处保存` }).click();
    const archived = page.waitForResponse((response) => response.url().endsWith(`/api/v1/long-range-plans/${createdPlan.id}/status`) && response.status() === 200);
    await page.getByRole("button", { name: "归档规划", exact: true }).click();
    await archived;
    await expect(page.getByRole("button", { name: "恢复规划", exact: true })).toBeVisible();
    const restored = page.waitForResponse((response) => response.url().endsWith(`/api/v1/long-range-plans/${createdPlan.id}/status`) && response.status() === 200);
    await page.getByRole("button", { name: "恢复规划", exact: true }).click();
    await restored;
    await expect(page.getByRole("button", { name: "归档规划", exact: true })).toBeVisible();
  } finally {
    await cleanupPlans(ids);
  }
});

test("390px 下可查看并创建长期规划，不产生横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "规划", exact: true }).click();
  await expect(page.getByRole("heading", { name: "把目光放远，也把决定留在自己手里。" })).toBeVisible();
  await page.getByRole("button", { name: "新建规划", exact: true }).click();
  await expect(page.getByLabel("规划标题")).toBeVisible();
  await page.getByRole("button", { name: "添加节点", exact: true }).click();
  await expect(page.getByLabel("里程碑 1", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
