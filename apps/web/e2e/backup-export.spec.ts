import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import { longRangePlanMilestones, longRangePlanTaskTreeCandidates, longRangePlans, taskLifecycleEvents, tasks, userProfiles } from "@personal-ai/db/schema";
import { eq } from "drizzle-orm";

const apiBase = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:3100";

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      collectKeys(item, keys);
    }
  }
  return keys;
}

test("下载完整逻辑备份，包含真实任务且不导出配置字段", async ({ page, request }) => {
  test.setTimeout(60_000);
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  const title = `E2E 备份任务 ${Date.now().toString(36)}`;
  const planTitle = `E2E 备份规划 ${Date.now().toString(36)}`;
  const planId = randomUUID();
  const milestoneId = randomUUID();
  const candidateId = randomUUID();
  let taskId: string | null = null;

  try {
    await db.transaction(async (transaction) => {
      await transaction.insert(longRangePlans).values({ id: planId, scope: "month", title: planTitle, periodStart: "2099-12-01", periodEnd: "2099-12-31", description: "验证长期规划也进入逻辑备份。" });
      await transaction.insert(longRangePlanMilestones).values({ id: milestoneId, longRangePlanId: planId, title: "备份里程碑", targetDate: "2099-12-15", notes: null, position: 0 });
      await transaction.insert(longRangePlanTaskTreeCandidates).values({
        id: candidateId,
        longRangePlanId: planId,
        longRangePlanVersion: 1,
        instructions: "仅用于备份验收",
        proposal: { summary: "备份候选摘要", tasks: [{ title: "备份候选任务", targetDate: null, notes: null }] }
      });
    });

    const created = await request.post(`${apiBase}/api/v1/tasks`, {
      data: { title, scheduleKind: "none", localDate: "2099-12-31", timeZone: "Asia/Shanghai" }
    });
    expect(created.ok()).toBe(true);
    taskId = (await created.json()).task.id as string;

    await page.goto("/");
    const downloadPromise = page.waitForEvent("download");
    await page.getByLabel("备份所有数据").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^personal-ai-assistant-backup-\d{8}T\d{9}Z\.json$/);
    const backupPath = await download.path();
    expect(backupPath).not.toBeNull();
    const backup = JSON.parse(await readFile(backupPath!, "utf8")) as {
      format: string;
      formatVersion: number;
      exportedAt: string;
      data: {
        tasks: Array<{ id: string; title: string }>;
        healthProfiles: Array<{ id: string; profile: unknown }>;
        longRangePlans: Array<{ id: string; title: string }>;
        longRangePlanMilestones: Array<{ id: string; longRangePlanId: string }>;
        longRangePlanTaskTreeCandidates: Array<{ id: string; longRangePlanId: string }>;
        userProfiles: Array<{ id: number }>;
      };
    };

    expect(backup).toMatchObject({ format: "personal-ai-assistant.backup", formatVersion: 8 });
    expect(new Date(backup.exportedAt).toString()).not.toBe("Invalid Date");
    expect(backup.data.tasks).toContainEqual(expect.objectContaining({ id: taskId, title }));
    expect(backup.data.healthProfiles.length).toBeGreaterThan(0);
    expect(backup.data.longRangePlans).toContainEqual(expect.objectContaining({ id: planId, title: planTitle }));
    expect(backup.data.longRangePlanMilestones).toContainEqual(expect.objectContaining({ id: milestoneId, longRangePlanId: planId }));
    expect(backup.data.longRangePlanTaskTreeCandidates).toContainEqual(expect.objectContaining({ id: candidateId, longRangePlanId: planId }));
    expect(backup.data.userProfiles).toContainEqual(expect.objectContaining({ id: 1 }));
    const keys = collectKeys(backup);
    expect([...keys]).not.toEqual(expect.arrayContaining([
      "DATABASE_URL", "databaseUrl", "DEEPSEEK_API_KEY", "FEISHU_APP_SECRET", "TAVILY_SEARCH_API_KEY"
    ]));
  } finally {
    await db.transaction(async (transaction) => {
      if (taskId) {
        await transaction.delete(taskLifecycleEvents).where(eq(taskLifecycleEvents.taskId, taskId!));
        await transaction.delete(tasks).where(eq(tasks.id, taskId!));
      }
      await transaction.delete(longRangePlanTaskTreeCandidates).where(eq(longRangePlanTaskTreeCandidates.id, candidateId));
      await transaction.delete(longRangePlanMilestones).where(eq(longRangePlanMilestones.id, milestoneId));
      await transaction.delete(longRangePlans).where(eq(longRangePlans.id, planId));
    });
    await client.end();
  }
});

test("390px 移动端仍显示真实备份入口", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByLabel("备份所有数据")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
