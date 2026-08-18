import { expect, test } from "@playwright/test";

const apiBase = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:3100";

test("当前时间线在页面静置时仍按真实时钟自动前进", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-08-14T10:14:10+08:00") });
  await page.route(`${apiBase}/api/v1/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const body = pathname === "/api/v1/inbox-entries"
      ? []
      : pathname === "/api/v1/tasks/trash"
        ? { tasks: [] }
        : pathname.startsWith("/api/v1/health/days/")
          ? { reference: null }
          : pathname === "/api/v1/user-profile"
            ? { profile: { recycleRetentionDays: 3 } }
            : pathname === "/api/v1/tasks"
              ? { tasks: [], blockingConflicts: [], historicalOverlaps: [] }
              : {};
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto("/");
  const nowLine = page.locator('.day-grid[data-surface-id="morning"] .now-line');
  await expect(nowLine).toBeVisible();
  const before = Number.parseFloat((await nowLine.getAttribute("style"))?.match(/top:\s*([\d.]+)px/)?.[1] ?? "0");

  await page.clock.fastForward(51_000);

  await expect.poll(async () => Number.parseFloat((await nowLine.getAttribute("style"))?.match(/top:\s*([\d.]+)px/)?.[1] ?? "0")).toBeGreaterThan(before);
  const after = Number.parseFloat((await nowLine.getAttribute("style"))?.match(/top:\s*([\d.]+)px/)?.[1] ?? "0");
  expect(after - before).toBeCloseTo(1.2, 1);
});
