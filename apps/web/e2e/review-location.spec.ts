import { expect, test } from "@playwright/test";

test("复盘页允许按当天输入地点且移动端不溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator(".mobile-nav").getByRole("button", { name: "复盘", exact: true }).click();

  const location = page.getByLabel("今日地点", { exact: true });
  await expect(location).toBeVisible();
  await location.fill("杭州");
  await expect(location).toHaveValue("杭州");
  await expect(page.getByRole("button", { name: "结束今日复盘并生成简报" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
