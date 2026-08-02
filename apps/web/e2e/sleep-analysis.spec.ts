import { expect, test } from "@playwright/test";

test("用户主动上传睡眠截图后只显示结构化可见结果", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2099-01-18T10:00:00+08:00"));
  const record = {
    id: "00000000-0000-4000-8000-000000000001",
    localDate: "2099-01-18",
    originalFileName: "huawei-sleep.png",
    mimeType: "image/png",
    createdAt: "2099-01-18T02:00:00.000Z",
    analysis: {
      totalSleepMinutes: 420, deepSleepMinutes: 90, lightSleepMinutes: null, remSleepMinutes: null,
      awakeCount: 2, sleepStart: "23:40", wakeTime: "06:40", deviceScore: 82,
      deviceNotes: "设备显示睡眠评分。", visibleMetrics: ["总睡眠", "深睡", "评分"],
      interpretation: ["截图中显示总睡眠约 7 小时。"], limitations: ["仅基于这张截图中可见的信息，不能替代专业医疗建议。"]
    }
  };
  await page.route("**/api/v1/health/sleep-analyses", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ analysis: record }) });
    } else {
      await route.continue();
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "健康", exact: true }).click();
  await expect(page.getByText("睡眠截图", { exact: true })).toBeVisible();
  await page.getByLabel("选择睡眠截图").setInputFiles({ name: "huawei-sleep.png", mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
  await expect(page.getByText("huawei-sleep.png", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "上传并分析", exact: true }).click();
  await expect(page.getByText("总睡眠", { exact: true })).toBeVisible();
  await expect(page.getByText("截图中显示总睡眠约 7 小时。", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
