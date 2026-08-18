import { expect, test } from "@playwright/test";

const apiBase = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:3100";
const shanghaiToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

test("成长页使用真实 API 展示年度折线趋势与 365 天状态，并在 390px 下不溢出", async ({ page, request }) => {
  const apiResponse = await request.get(`${apiBase}/api/v1/growth/summary?endDate=${shanghaiToday()}&days=365`);
  expect(apiResponse.status()).toBe(200);
  const apiBody = await apiResponse.json() as { summary: { days: Array<{localDate:string;plannedTasks:number;closedTasks:number}>; plannedTasks: number; closedTasks: number; focusTrend: { granularity: string; points: unknown[] }; satisfaction: { satisfied: number; neutral: number; dissatisfied: number }; garden: { growthPercent: number } } };
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
  await expect(page.locator('.workspace-layer.current[data-layer-view="growth"]')).toHaveCount(1, { timeout: 1800 });
  await expect(page.locator("canvas.growth-bamboo")).toHaveCount(1);
  await expect(page.locator(".growth-bamboo")).toHaveCSS("pointer-events", "none");
  await expect(page.locator(".growth-bamboo")).toHaveAttribute("data-motion-model", "pbd-bamboo-wind-field");
  const growthPercent = apiBody.summary.garden.growthPercent;
  const expectedStage = growthPercent < 33 ? "shoots" : growthPercent <= 66 ? "mixed" : "grove";
  const expectedStalkCount = expectedStage === "grove" ? "4" : expectedStage === "mixed" ? "2" : "0";
  const expectedShootCount = expectedStage === "grove" ? "0" : expectedStage === "mixed" ? "2" : "4";
  await expect(page.locator(".growth-bamboo")).toHaveAttribute("data-growth-stage", expectedStage);
  await expect(page.locator(".growth-bamboo")).toHaveAttribute("data-stalk-count", expectedStalkCount);
  await expect(page.locator(".growth-bamboo")).toHaveAttribute("data-shoot-count", expectedShootCount);
  await expect(page.locator(".growth-bamboo")).toHaveAttribute("data-node-range", "6-8");
  await expect(page.locator(".growth-bamboo")).toHaveAttribute("data-leaf-shape", "bezier-lanceolate");
  await expect(page.locator(".growth-bamboo")).toHaveAttribute("data-tone-order", "bottom-to-top");
  await expect(page.locator(".growth-bamboo")).toHaveAttribute("data-leaf-response", "greater-than-stalk");
  await expect(page.locator(".growth-bamboo")).toHaveAttribute("data-gust-hold-ms", "900");
  await expect(page.locator("canvas.growth-willow,.growth-willow")).toHaveCount(0);
  await expect(page.locator(".willow-strand,.willow-strand-line,.willow-leaf,.willow-trunk,.willow-branch")).toHaveCount(0);
  const bamboo = page.locator(".growth-bamboo");
  const bambooBox = await bamboo.boundingBox();
  expect(bambooBox).not.toBeNull();
  const landscapeBox = await page.locator(".growth-landscape").boundingBox();
  expect(landscapeBox).not.toBeNull();
  const rightMetricBox = await page.locator(".growth-scene-metrics > div").nth(2).boundingBox();
  expect(rightMetricBox).not.toBeNull();
  expect(Math.abs((bambooBox!.x + bambooBox!.width) - (rightMetricBox!.x + rightMetricBox!.width))).toBeLessThanOrEqual(8);
  expect(bambooBox!.x + bambooBox!.width * .42).toBeGreaterThanOrEqual(rightMetricBox!.x - 8);
  expect(bambooBox!.width).toBeLessThanOrEqual(landscapeBox!.width * .62);
  expect(bambooBox!.height).toBeLessThanOrEqual(200);
  const bambooBottom = bambooBox!.y + bambooBox!.height;
  expect(bambooBottom).toBeGreaterThanOrEqual(rightMetricBox!.y - 28);
  expect(bambooBottom).toBeLessThanOrEqual(rightMetricBox!.y + 24);
  const backingSize = await bamboo.evaluate((element) => ({ width: (element as HTMLCanvasElement).width, height: (element as HTMLCanvasElement).height }));
  expect(backingSize.width).toBeGreaterThan(0);
  expect(backingSize.height).toBeGreaterThan(0);
  const paintedPixels = await bamboo.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context) return 0;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index]! > 4) count += 1;
    return count;
  });
  expect(paintedPixels).toBeGreaterThan(80);
  if(expectedStage!=="shoots"){
    const initialGustCount = Number(await bamboo.getAttribute("data-gust-count"));
    const initialEnergy = Number(await bamboo.getAttribute("data-motion-energy"));
    await page.mouse.move(bambooBox!.x + bambooBox!.width * .38, bambooBox!.y + bambooBox!.height * .5);
    await page.mouse.move(bambooBox!.x + bambooBox!.width * .88, bambooBox!.y + bambooBox!.height * .46, { steps: 14 });
    await expect.poll(async () => Number(await bamboo.getAttribute("data-gust-count"))).toBeGreaterThan(initialGustCount);
    await expect.poll(async () => Number(await bamboo.getAttribute("data-motion-energy"))).toBeGreaterThan(initialEnergy);
    await expect(bamboo).toHaveAttribute("data-gust-phase", "active");
    await expect.poll(async () => bamboo.getAttribute("data-gust-phase"), { timeout: 1800 }).toBe("settling");
    await expect.poll(async () => bamboo.getAttribute("data-gust-phase"), { timeout: 3000 }).toBe("idle");
  }else{
    await expect(bamboo).toHaveAttribute("data-gust-phase","idle");
  }
  await expect(page.locator('.focus-line-chart[data-granularity="day"] .focus-line-point')).toHaveCount(7);
  await expect(page.locator(".growth-scene-metrics")).toBeVisible();
  await expect(page.locator(".growth-scene-metrics > div")).toHaveCount(3);
  await expect(page.locator(".growth-scene-metrics")).toContainText("有效专注");
  await expect(page.locator(".growth-scene-metrics")).toContainText("任务收束");
  await expect(page.locator(".growth-scene-metrics")).toContainText("生长进度");

  const monthButton = page.getByRole("button", { name: "一月", exact: true });
  await expect(monthButton).toHaveCount(1);
  await monthButton.click();
  await expect(monthButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('.focus-line-chart[data-granularity="day"] .focus-line-point')).toHaveCount(30);
  await expect(page.locator(".state-grid.month-state-grid .state-cell")).toHaveCount(30);

  const yearButton = page.getByRole("button", { name: "一年", exact: true });
  await yearButton.click();
  await expect(yearButton).toHaveAttribute("aria-pressed", "true");
  const annualTrendPoints = page.locator('.focus-line-chart[data-granularity="month"] .focus-line-point');
  await expect(annualTrendPoints).toHaveCount(apiBody.summary.focusTrend.points.length);
  await expect(page.locator('.compact-state-grid[data-window-days="365"] .state-cell')).toHaveCount(365);
  await expect(page.getByText("一年状态图", { exact: true })).toBeVisible();
  await expect(page.locator(".radar-list > div")).toHaveCount(6);
  await expect(page.locator(".feeling-row")).toHaveCount(0);
  await expect(page.locator(".feeling-traces .feeling-trace")).toHaveCount(3);
  await expect(page.locator(".feeling-trace.satisfied > strong")).toHaveText(String(apiBody.summary.satisfaction.satisfied));
  await expect(page.locator(".feeling-trace.neutral > strong")).toHaveText(String(apiBody.summary.satisfaction.neutral));
  await expect(page.locator(".feeling-trace.dissatisfied > strong")).toHaveText(String(apiBody.summary.satisfaction.dissatisfied));
  const feelingTotal = apiBody.summary.satisfaction.satisfied + apiBody.summary.satisfaction.neutral + apiBody.summary.satisfaction.dissatisfied;
  if (feelingTotal === 0) await expect(page.getByText("本周还没有留下主观反馈", { exact: true })).toBeVisible();
  for (const label of ["主线推进", "总体执行", "专注质量", "精力状态", "身心维护", "成长获得"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByText(/绿色偏满意/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
