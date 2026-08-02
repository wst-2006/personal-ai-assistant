import { expect, test } from "@playwright/test";

const apiBase = "http://127.0.0.1:3000";

type UserProfile = {
  id: number;
  personalContext: string;
  aiGuidance: string;
  shareWithAi: boolean;
  responseStyle: "concise" | "balanced" | "detailed";
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
    const settingsButton = page.getByRole("button", { name: "个人设置", exact: true });
    await expect(settingsButton).toHaveCount(1);
    await settingsButton.click();
    await expect(page.getByRole("dialog", { name: "把背景留给自己，也交代给 AI。" })).toBeVisible();
    await page.getByLabel("个人背景", { exact: true }).fill(`用户主动填写的背景 ${suffix}`);
    await page.getByLabel("AI 协作指引", { exact: true }).fill("先给结构，再给可选方案；不替我做决定。");
    await page.getByLabel("回复详略", { exact: true }).selectOption("concise");
    const saveResponse = page.waitForResponse((response) => response.url() === `${apiBase}/api/v1/user-profile`
      && response.request().method() === "PUT" && response.status() === 200);
    await page.getByRole("button", { name: "保存个人设置", exact: true }).click();
    const savedProfile = (await (await saveResponse).json()).profile as UserProfile;
    currentVersion = savedProfile.version;
    await expect(page.getByRole("status")).toContainText("已保存");

    const persistedResponse = await request.get(`${apiBase}/api/v1/user-profile`);
    expect((await persistedResponse.json()).profile).toMatchObject({
      personalContext: `用户主动填写的背景 ${suffix}`,
      aiGuidance: "先给结构，再给可选方案；不替我做决定。",
      responseStyle: "concise"
    });
    await page.reload();
    await page.getByRole("button", { name: "个人设置", exact: true }).click();
    await expect(page.getByLabel("个人背景", { exact: true })).toHaveValue(`用户主动填写的背景 ${suffix}`);
    await expect(page.getByLabel("AI 协作指引", { exact: true })).toHaveValue("先给结构，再给可选方案；不替我做决定。");
  } finally {
    const restore = await request.put(`${apiBase}/api/v1/user-profile`, {
      data: {
        expectedVersion: currentVersion,
        personalContext: original.personalContext,
        aiGuidance: original.aiGuidance,
        shareWithAi: original.shareWithAi,
        responseStyle: original.responseStyle
      }
    });
    expect(restore.status()).toBe(200);
  }
});

test("390px 下个人设置可用且不发生横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "个人设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "把背景留给自己，也交代给 AI。" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
