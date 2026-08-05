import { expect, test, type APIRequestContext } from "@playwright/test";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { longRangePlanMilestones, longRangePlanTaskTreeCandidates, longRangePlans, taskLifecycleEvents, tasks } from "@personal-ai/db/schema";

const apiBase = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:3100";

type Fixture = { planId: string; candidateId: string };

async function createFixture(request: APIRequestContext, suffix: string): Promise<Fixture> {
  const planResponse = await request.post(`${apiBase}/api/v1/long-range-plans`, {
    data: {
      scope: "month",
      title: `E2E 框架任务树 ${suffix}`,
      periodStart: "2099-06-01",
      periodEnd: "2099-06-30",
      description: "浏览器验收：候选不能在确认前创建任务。",
      milestones: [{ title: "确定框架范围", targetDate: "2099-06-08", notes: null }]
    }
  });
  expect(planResponse.status()).toBe(201);
  const plan = (await planResponse.json()).plan as { id: string; version: number };
  const candidateId = randomUUID();
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  try {
    await db.insert(longRangePlanTaskTreeCandidates).values({
      id: candidateId,
      longRangePlanId: plan.id,
      longRangePlanVersion: plan.version,
      state: "candidate",
      instructions: "只保留阶段成果。",
      proposal: {
        summary: "先整理范围，再提交阶段成果。",
        tasks: [
          { title: `E2E 整理范围 ${suffix}`, targetDate: "2099-06-08", notes: "用户可编辑" },
          { title: `E2E 提交成果 ${suffix}`, targetDate: null, notes: null }
        ]
      },
      createdTaskIds: [],
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date()
    });
  } finally {
    await client.end();
  }
  return { planId: plan.id, candidateId };
}

async function countCreatedTasks(planId: string) {
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  try {
    return await db.select().from(tasks).where(eq(tasks.sourceLongRangePlanId, planId));
  } finally {
    await client.end();
  }
}

async function cleanupFixture(fixture: Fixture) {
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  try {
    await db.transaction(async (transaction) => {
      const sourceTasks = await transaction.select({ id: tasks.id }).from(tasks)
        .where(eq(tasks.sourceLongRangePlanId, fixture.planId));
      const taskIds = sourceTasks.map((task) => task.id);
      if (taskIds.length) {
        await transaction.delete(taskLifecycleEvents).where(inArray(taskLifecycleEvents.taskId, taskIds));
        await transaction.delete(tasks).where(inArray(tasks.id, taskIds));
      }
      await transaction.delete(longRangePlanTaskTreeCandidates)
        .where(and(eq(longRangePlanTaskTreeCandidates.id, fixture.candidateId), eq(longRangePlanTaskTreeCandidates.longRangePlanId, fixture.planId)));
      await transaction.delete(longRangePlanMilestones).where(eq(longRangePlanMilestones.longRangePlanId, fixture.planId));
      await transaction.delete(longRangePlans).where(eq(longRangePlans.id, fixture.planId));
    });
  } finally {
    await client.end();
  }
}

async function openCandidate(page: import("@playwright/test").Page, title: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "规划", exact: true }).click();
  await page.locator(".long-range-item").filter({ hasText: title }).click();
  await expect(page.getByLabel("候选任务 1", { exact: true })).toBeVisible();
}

test("任务树候选必须先保存、再明确确认，任务才通过真实 API 持久化", async ({ page, request }) => {
  test.setTimeout(60_000);
  const suffix = Date.now().toString(36);
  const fixture = await createFixture(request, suffix);
  const planTitle = `E2E 框架任务树 ${suffix}`;
  const editedTitle = `E2E 确认后的阶段 ${suffix}`;
  try {
    await openCandidate(page, planTitle);
    expect(await countCreatedTasks(fixture.planId)).toHaveLength(0);
    await page.getByLabel("候选任务 1", { exact: true }).fill(editedTitle);
    await page.getByLabel("候选任务 1 日期", { exact: true }).fill("2099-06-10");
    const saved = page.waitForResponse((response) => response.url().endsWith(`/api/v1/task-tree-candidates/${fixture.candidateId}`)
      && response.request().method() === "PUT" && response.status() === 200);
    await page.getByRole("button", { name: "保存候选修改", exact: true }).click();
    await saved;
    expect(await countCreatedTasks(fixture.planId)).toHaveLength(0);

    await page.reload();
    await page.getByRole("button", { name: "规划", exact: true }).click();
    await page.locator(".long-range-item").filter({ hasText: planTitle }).click();
    await expect(page.getByLabel("候选任务 1", { exact: true })).toHaveValue(editedTitle);
    await expect(page.getByLabel("候选任务 1 日期", { exact: true })).toHaveValue("2099-06-10");

    const confirmed = page.waitForResponse((response) => response.url().endsWith(`/api/v1/task-tree-candidates/${fixture.candidateId}/confirm`)
      && response.request().method() === "POST" && response.status() === 200);
    await page.getByRole("button", { name: "确认并建立任务", exact: true }).click();
    await confirmed;
    await expect(page.getByText("已确认并建立任务", { exact: true })).toBeVisible();
    await expect(page.getByText("已创建 2 个未排期任务。它们不会自动进入具体时间轴。", { exact: true })).toBeVisible();

    const createdTasks = await countCreatedTasks(fixture.planId);
    expect(createdTasks).toHaveLength(2);
    expect(createdTasks.find((task) => task.title === editedTitle)).toMatchObject({
      scheduleKind: "none",
      lifecycleStatus: "open",
      localDate: "2099-06-10",
      sourceLongRangePlanId: fixture.planId
    });
    await page.reload();
    await page.getByRole("button", { name: "规划", exact: true }).click();
    await page.locator(".long-range-item").filter({ hasText: planTitle }).click();
    await expect(page.getByText("已确认并建立任务", { exact: true })).toBeVisible();
  } finally {
    await cleanupFixture(fixture);
  }
});

test("用户可放弃任务树候选，且放弃不会写入任务", async ({ page, request }) => {
  test.setTimeout(60_000);
  const suffix = `discard-${Date.now().toString(36)}`;
  const fixture = await createFixture(request, suffix);
  const planTitle = `E2E 框架任务树 ${suffix}`;
  try {
    await openCandidate(page, planTitle);
    const cancelled = page.waitForResponse((response) => response.url().endsWith(`/api/v1/task-tree-candidates/${fixture.candidateId}/cancel`)
      && response.request().method() === "POST" && response.status() === 200);
    await page.getByRole("button", { name: "放弃这份候选", exact: true }).click();
    await cancelled;
    expect(await countCreatedTasks(fixture.planId)).toHaveLength(0);
    await expect(page.getByText("这份候选已取消。", { exact: true })).toBeVisible();

    await page.reload();
    await page.getByRole("button", { name: "规划", exact: true }).click();
    await page.locator(".long-range-item").filter({ hasText: planTitle }).click();
    await expect(page.getByText("这份候选已取消。", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "重新生成候选", exact: true }).click();
    await expect(page.getByRole("button", { name: "生成 AI 候选", exact: true })).toBeVisible();
  } finally {
    await cleanupFixture(fixture);
  }
});

test("390px 下可查看候选任务树且不产生横向溢出", async ({ page, request }) => {
  const suffix = `mobile-${Date.now().toString(36)}`;
  const fixture = await createFixture(request, suffix);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openCandidate(page, `E2E 框架任务树 ${suffix}`);
    await expect(page.getByLabel("候选任务 1", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "确认并建立任务", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally {
    await cleanupFixture(fixture);
  }
});
