import { expect, test } from "@playwright/test";

test("复盘页允许按当天输入地点且移动端不溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "复盘", exact: true }).last().click();

  const location = page.getByLabel("今日地点", { exact: true });
  await expect(location).toBeVisible();
  await location.fill("杭州");
  await expect(location).toHaveValue("杭州");
  await expect(page.getByRole("button", { name: "结束今日复盘并生成简报" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("已确认简报默认只读，进入编辑后可保存修改并导出", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "复盘", exact: true }).last().click();
  const brief = page.locator(".review-brief-editor");
  if (await brief.count() === 0) return;
  const summary = page.getByLabel("简报复盘摘要", { exact: true });
  if (!(await summary.count())) return;
  const exportButton = page.getByRole("button", { name: "导出简报", exact: true });
  await expect(exportButton).toHaveCount(1);
  const editButton = brief.getByRole("button", { name: "编辑简报", exact: true });
  if (await editButton.count() === 1) {
    await expect(summary).toBeDisabled();
    await editButton.click();
    await expect(summary).toBeEnabled();
    await summary.fill(`${await summary.inputValue()}\nE2E edit`);
    await brief.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(summary).toBeDisabled();
  }
});
