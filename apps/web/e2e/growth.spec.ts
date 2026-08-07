import { expect, test } from "@playwright/test";

const apiBase = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:3100";
const shanghaiToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

test("成长页使用真实 API 展示年度折线趋势与 365 天状态，并在 390px 下不溢出", async ({ page, request }) => {
  const apiResponse = await request.get(`${apiBase}/api/v1/growth/summary?endDate=${shanghaiToday()}&days=365`);
  expect(apiResponse.status()).toBe(200);
  const apiBody = await apiResponse.json() as { summary: { days: unknown[]; focusTrend: { granularity: string; points: unknown[] } } };
  expect(apiBody.summary.days).toHaveLength(365);
  expect(apiBody.summary.focusTrend.granularity).toBe("month");
  expect(apiBody.summary.focusTrend.points.length).toBeGreaterThanOrEqual(12);
  expect(apiBody.summary.focusTrend.points.length).toBeLessThanOrEqual(13);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const growthButton = page.locator(".mobile-nav").getByRole("button", { name: "成长", exact: true });
  await expect(growthButton).toHaveCount(1);
  await growthButton.click();
  await expect(page.getByRole("heading", { name: "生长来自留下的数据。" })).toBeVisible();
  await expect(page.locator('.focus-line-chart[data-granularity="day"] .focus-line-point')).toHaveCount(7);

  const monthButton = page.getByRole("button", { name: "最近 30 天", exact: true });
  await expect(monthButton).toHaveCount(1);
  await monthButton.click();
  await expect(monthButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('.focus-line-chart[data-granularity="day"] .focus-line-point')).toHaveCount(30);
  await expect(page.locator(".state-grid.month-state-grid .state-cell")).toHaveCount(30);

  const yearButton = page.getByRole("button", { name: "最近 1 年", exact: true });
  await yearButton.click();
  await expect(yearButton).toHaveAttribute("aria-pressed", "true");
  const annualTrendPoints = page.locator('.focus-line-chart[data-granularity="month"] .focus-line-point');
  await expect(annualTrendPoints).toHaveCount(apiBody.summary.focusTrend.points.length);
  await expect(page.locator('.compact-state-grid[data-window-days="365"] .state-cell')).toHaveCount(365);
  await expect(page.getByText("一年状态图", { exact: true })).toBeVisible();
  await expect(page.locator(".radar-list > div")).toHaveCount(6);
  for (const label of ["主线推进", "总体执行", "专注质量", "精力状态", "身心维护", "成长获得"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByText(/绿色偏满意/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
