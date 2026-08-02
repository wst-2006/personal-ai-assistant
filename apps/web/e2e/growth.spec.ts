import { expect, test } from "@playwright/test";

const apiBase = "http://127.0.0.1:3000";
const shanghaiToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

test("成长页使用真实 API 切换七日与月度统计，并在 390px 下不溢出", async ({ page, request }) => {
  const apiResponse = await request.get(`${apiBase}/api/v1/growth/summary?endDate=${shanghaiToday()}&days=30`);
  expect(apiResponse.status()).toBe(200);
  const apiBody = await apiResponse.json() as { summary: { days: unknown[] } };
  expect(apiBody.summary.days).toHaveLength(30);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const growthButton = page.locator(".mobile-nav").getByRole("button", { name: "成长", exact: true });
  await expect(growthButton).toHaveCount(1);
  await growthButton.click();
  await expect(page.getByRole("heading", { name: "生长来自留下的数据。" })).toBeVisible();
  await expect(page.locator(".bar-chart .bar-day")).toHaveCount(7);

  const monthButton = page.getByRole("button", { name: "最近 30 天", exact: true });
  await expect(monthButton).toHaveCount(1);
  await monthButton.click();
  await expect(monthButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".bar-chart.month-chart .bar-day")).toHaveCount(30);
  await expect(page.locator(".state-grid.month-state-grid .state-cell")).toHaveCount(30);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
