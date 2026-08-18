import { expect, test } from "@playwright/test";

const apiBase = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:3100";

type UserProfile = {
  id: number;
  personalContext: string;
  aiGuidance: string;
  shareWithAi: boolean;
  responseStyle: "concise" | "balanced" | "detailed";
  unscheduledTaskPolicy: "carry_forward" | "delete_at_day_end";
  recycleRetentionDays: number;
  focusFlipSoundEnabled: boolean;
  focusStartSoundEnabled: boolean;
  breakStartSoundEnabled: boolean;
  breakEndSoundEnabled: boolean;
  focusEndSoundEnabled: boolean;
  focusTheme: "ink" | "flip" | "nixie" | "vapor" | "cyber";
  desktopFocusEnabled: boolean;
  focusPreparationWindowEnabled: boolean;
  focusTimerWindowEnabled: boolean;
  focusEvaluationEnabled: boolean;
  feishuTaskCardsEnabled: boolean;
  feishuT15Enabled: boolean;
  healthPageEnabled: boolean;
  version: number;
};

test("个人画像和 AI 偏好通过真实 API 持久化、刷新恢复并可恢复原值", async ({ page, request }) => {
  test.setTimeout(60_000);
  const originalResponse = await request.get(`${apiBase}/api/v1/user-profile`);
  expect(originalResponse.status()).toBe(200);
  const original = (await originalResponse.json()).profile as UserProfile;
  const suffix = Date.now().toString(36);
  let currentVersion = original.version;
  try {
    await page.goto("/");
    const settingsButton = page.locator(".rail-settings-button");
    await expect(settingsButton).toHaveCount(1);
    await settingsButton.click();
    await expect(page.getByRole("heading", { name: "让工具顺着你的习惯安静下来。" })).toBeVisible();
    await page.locator(".theme-choice").filter({ hasText: "赛博终端" }).click();
    await page.getByLabel("任务结束评价", { exact: true }).uncheck();
    await page.getByLabel("提前十五分钟提醒", { exact: true }).uncheck();
    await page.getByLabel("显示健康参考页面", { exact: true }).uncheck();
    await page.getByLabel("个人背景", { exact: true }).fill(`用户主动填写的背景 ${suffix}`);
    await page.getByLabel("AI 协作指引", { exact: true }).fill("先给结构，再给可选方案；不替我做决定。");
    await page.getByLabel("回复详略", { exact: true }).selectOption("concise");
    await page.getByLabel("顺移到下一天", { exact: true }).check();
    await page.getByLabel("回收站保留时间", { exact: true }).selectOption("3");
    await page.getByLabel("计时刻度", { exact: true }).uncheck();
    const saveResponse = page.waitForResponse((response) => response.url() === `${apiBase}/api/v1/user-profile`
      && response.request().method() === "PUT" && response.status() === 200);
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    const savedProfile = (await (await saveResponse).json()).profile as UserProfile;
    currentVersion = savedProfile.version;
    await expect(page.getByRole("status")).toContainText("已保存");

    const persistedResponse = await request.get(`${apiBase}/api/v1/user-profile`);
    expect((await persistedResponse.json()).profile).toMatchObject({
      personalContext: `用户主动填写的背景 ${suffix}`,
      aiGuidance: "先给结构，再给可选方案；不替我做决定。",
      responseStyle: "concise",
      unscheduledTaskPolicy: "carry_forward",
      recycleRetentionDays: 3,
      focusFlipSoundEnabled: false,
      focusTheme: "cyber",
      focusEvaluationEnabled: false,
      feishuT15Enabled: false,
      healthPageEnabled: false,
    });
    await page.reload();
    await page.locator(".rail-settings-button").click();
    await expect(page.getByLabel("个人背景", { exact: true })).toHaveValue(`用户主动填写的背景 ${suffix}`);
    await expect(page.getByLabel("AI 协作指引", { exact: true })).toHaveValue("先给结构，再给可选方案；不替我做决定。");
    await expect(page.locator(".theme-choice").filter({ hasText: "赛博终端" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("任务结束评价", { exact: true })).not.toBeChecked();
    await expect(page.getByLabel("提前十五分钟提醒", { exact: true })).not.toBeChecked();
    await expect(page.getByLabel("显示健康参考页面", { exact: true })).not.toBeChecked();
  } finally {
    const restore = await request.put(`${apiBase}/api/v1/user-profile`, {
      data: {
        expectedVersion: currentVersion,
        personalContext: original.personalContext,
        aiGuidance: original.aiGuidance,
        shareWithAi: original.shareWithAi,
        responseStyle: original.responseStyle,
        unscheduledTaskPolicy: original.unscheduledTaskPolicy,
        recycleRetentionDays: original.recycleRetentionDays,
        focusSounds: {
          flip: original.focusFlipSoundEnabled,
          focusStart: original.focusStartSoundEnabled,
          breakStart: original.breakStartSoundEnabled,
          breakEnd: original.breakEndSoundEnabled,
          focusEnd: original.focusEndSoundEnabled
        },
        focusTheme: original.focusTheme,
        desktopFocusEnabled: original.desktopFocusEnabled,
        focusPreparationWindowEnabled: original.focusPreparationWindowEnabled,
        focusTimerWindowEnabled: original.focusTimerWindowEnabled,
        focusEvaluationEnabled: original.focusEvaluationEnabled,
        feishuTaskCardsEnabled: original.feishuTaskCardsEnabled,
        feishuT15Enabled: original.feishuT15Enabled,
        healthPageEnabled: original.healthPageEnabled,
      }
    });
    expect(restore.status()).toBe(200);
  }
});

test("390px 下个人设置可用且不发生横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator(".mobile-settings-shortcut").click();
  await expect(page.getByRole("heading", { name: "让工具顺着你的习惯安静下来。" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
