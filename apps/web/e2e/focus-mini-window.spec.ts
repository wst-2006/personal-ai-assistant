import { expect, test, type Page } from "@playwright/test";

const apiBase = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:3100";

function snapshot(
  state: "preparing" | "armed" | "running" | "ended",
  options: { now?: number; remainingSeconds?: number } = {},
) {
  const now = options.now ?? Date.now();
  const runningRemainingMs = (options.remainingSeconds ?? 25 * 60) * 1_000;
  const preparing = state === "preparing" || state === "armed";
  return {
    serverNow: new Date(now).toISOString(),
    serverNowEpochMs: now,
    session: {
      id: "00000000-0000-4000-8000-000000000101",
      taskId: "00000000-0000-4000-8000-000000000102",
      state,
      version: state === "ended" ? 4 : state === "running" ? 3 : state === "armed" ? 2 : 1,
      plannedStartAt: preparing ? new Date(now + 45_000).toISOString() : new Date(now - 20 * 60_000).toISOString(),
      plannedEndAt: new Date(now + runningRemainingMs).toISOString(),
      pausedAt: null,
      rawActiveSeconds: 1_200,
    },
    task: {
      id: "00000000-0000-4000-8000-000000000102",
      title: "完成专注窗口结构验收",
      timeZone: "Asia/Shanghai",
      startAt: preparing ? new Date(now + 45_000).toISOString() : new Date(now - 20 * 60_000).toISOString(),
      endAt: new Date(now + runningRemainingMs).toISOString(),
    },
    phase: state === "ended" ? "ended" : state === "preparing" ? "preparation" : state === "armed" ? "armed" : "focus",
    phaseStartedAt: preparing ? new Date(now - 15_000).toISOString() : new Date(now - 20 * 60_000).toISOString(),
    phaseEndsAt: state === "ended" ? null : preparing ? new Date(now + 45_000).toISOString() : new Date(now + runningRemainingMs).toISOString(),
    phaseEndsAtEpochMs: state === "ended" ? null : preparing ? now + 45_000 : now + runningRemainingMs,
    sessionEndsAt: new Date(now + runningRemainingMs).toISOString(),
    sessionEndsAtEpochMs: now + runningRemainingMs,
    currentSegment: state === "ended" || preparing ? null : {
      position: 0,
      segmentType: "focus",
      durationMinutes: 45,
      startsAt: new Date(now - 20 * 60_000).toISOString(),
      endsAt: new Date(now + runningRemainingMs).toISOString(),
    },
    nextSegment: null,
    segments: [],
  };
}

async function routeProfile(page: Page, focusTheme: "ink" | "flip" | "nixie" | "vapor" | "cyber" = "ink") {
  await page.route(`${apiBase}/api/v1/user-profile`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      profile: {
        focusTheme,
        desktopFocusEnabled: true,
        focusPreparationWindowEnabled: true,
        focusTimerWindowEnabled: true,
        focusEvaluationEnabled: true,
      },
    }),
  }));
}

test.describe("独立专注窗口", () => {
  test("置顶与锁定固定在标题栏，底部只保留明确的计时动作", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 236 });
    await routeProfile(page);
    await page.route(`${apiBase}/api/v1/focus-sessions/current`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ session: snapshot("running").session, snapshot: snapshot("running") }),
    }));

    await page.goto("/?focus-mini=1");

    const titlebar = page.locator(".focus-mini-titlebar");
    await expect(titlebar.getByRole("button", { name: "始终置顶" })).toBeVisible();
    await expect(titlebar.getByRole("button", { name: "锁定窗口位置" })).toBeVisible();
    await expect(titlebar.getByRole("button", { name: "最小化专注窗口" })).toBeVisible();
    await expect(titlebar.getByRole("button", { name: "关闭专注窗口" })).toBeVisible();
    await expect(page.getByTitle("打开主界面")).toHaveCount(0);

    const actions = page.locator(".focus-mini-controls");
    await expect(actions.getByRole("button")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("T-1 在桌面显示开始确认，并在任一端确认后共享已确认状态", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 236 });
    await routeProfile(page);
    let confirmed = false;
    let confirmCount = 0;
    await page.route(`${apiBase}/api/v1/focus-sessions/current`, (route) => {
      const value = snapshot(confirmed ? "armed" : "preparing");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ session: value.session, snapshot: value }),
      });
    });
    await page.route(`${apiBase}/api/v1/focus-sessions/*/skip-preparation`, async (route) => {
      confirmCount += 1;
      confirmed = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ session: snapshot("armed").session }),
      });
    });

    await page.goto("/?focus-mini=1");
    await expect(page.getByRole("button", { name: "开始任务" })).toBeVisible();
    await expect(page.getByText("桌面或飞书确认一次即可")).toBeVisible();
    await page.getByRole("button", { name: "开始任务" }).click();
    await expect(page.getByText("已确认", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "开始任务" })).toHaveCount(0);
    expect(confirmCount).toBe(1);
  });

  test("结束后使用独立评价构图并分别保存客观结果与主观感受", async ({ page }) => {
    await page.setViewportSize({ width: 540, height: 620 });
    await routeProfile(page);
    let evaluated = false;
    let payload: Record<string, unknown> | null = null;
    await page.route(`${apiBase}/api/v1/focus-sessions/current`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(evaluated
        ? { session: null, snapshot: null }
        : { session: snapshot("ended").session, snapshot: snapshot("ended") }),
    }));
    await page.route(`${apiBase}/api/v1/focus-sessions/*/evaluate`, async (route) => {
      payload = route.request().postDataJSON() as Record<string, unknown>;
      evaluated = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ session: { ...snapshot("ended").session, state: "evaluated", version: 5 } }),
      });
    });

    await page.goto("/?focus-mini=1");
    await expect(page.getByRole("heading", { name: "为这一段留下真实记录" })).toBeVisible();
    await expect(page.getByText("完成专注窗口结构验收", { exact: true })).toBeVisible();

    const satisfied = page.getByRole("button", { name: "满意", exact: true });
    const neutral = page.getByRole("button", { name: "一般", exact: true });
    const dissatisfied = page.getByRole("button", { name: "不满意", exact: true });
    await expect(satisfied).toHaveClass(/feeling-satisfied/);
    await expect(neutral).toHaveClass(/feeling-neutral/);
    await expect(dissatisfied).toHaveClass(/feeling-dissatisfied/);

    await page.getByRole("button", { name: "部分完成" }).click();
    await page.getByLabel("实际完成进度").fill("63");
    await neutral.click();
    await page.getByLabel("专注过程与原因").fill("中途处理了一次临时事项。\n剩余部分明天继续。");
    await page.getByRole("button", { name: "保存本次专注" }).click();

    await expect(page.getByText("记录已经保存")).toBeVisible();
    expect(payload).toMatchObject({
      outcome: "partial",
      progressPercent: 63,
      satisfaction: "neutral",
      note: "中途处理了一次临时事项。\n剩余部分明天继续。",
    });
    expect(payload).toHaveProperty("commandId");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("液晶七段数字完整统一，多个时间组合都保留双点冒号", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 236 });
    const fixedNow = new Date("2026-08-17T12:00:00.000Z");
    await page.clock.install();
    await page.clock.setFixedTime(fixedNow);
    await routeProfile(page, "ink");
    let remainingSeconds = 42;
    await page.route(`${apiBase}/api/v1/focus-sessions/current`, (route) => {
      const value = snapshot("running", { now: fixedNow.getTime(), remainingSeconds });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ session: value.session, snapshot: value }),
      });
    });

    const cases = [
      { seconds: 42, label: "00:42" },
      { seconds: 23 * 60 + 54, label: "23:54" },
      { seconds: 4 * 60 + 32, label: "04:32" },
    ];
    for (const [index, item] of cases.entries()) {
      remainingSeconds = item.seconds;
      if (index === 0) await page.goto("/?focus-mini=1");
      else await page.reload();
      const clock = page.locator(`svg.lcd-clock[aria-label="${item.label}"]`);
      await expect(clock).toBeVisible();
      const clockBounds = await clock.boundingBox();
      expect(clockBounds?.width).toBeLessThanOrEqual(160);
      await expect(clock.locator(".lcd-digit")).toHaveCount(4);
      await expect(clock.locator(".lcd-digit .lcd-segment")).toHaveCount(28);
      await expect(clock.locator(".lcd-colon circle")).toHaveCount(2);
      await expect(clock.locator(".ink-stamp-blot, .ink-stamp-ring, linearGradient, radialGradient, feDropShadow")).toHaveCount(0);
      expect(await clock.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
      const activeStyle = await clock.locator(".lcd-segment.active").first().evaluate((node) => {
        const style = getComputedStyle(node);
        return { fill: style.fill, opacity: Number(style.opacity) };
      });
      expect(activeStyle.fill).toBe("rgb(32, 40, 50)");
      expect(activeStyle.opacity).toBe(1);
      const quote = page.locator(".focus-mini-quote");
      await expect(quote).toBeVisible();
      await expect(quote.locator("cite")).toContainText("《");
      await expect(quote).not.toContainText("一念收束");
      const digitSizes = await clock.locator(".lcd-digit").evaluateAll((nodes) => nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }));
      expect(Math.max(...digitSizes.map((size) => size.width)) - Math.min(...digitSizes.map((size) => size.width))).toBeLessThan(1);
      expect(Math.max(...digitSizes.map((size) => size.height)) - Math.min(...digitSizes.map((size) => size.height))).toBeLessThan(1);
      const bounds = await clock.evaluate((svg) => {
        const frame = svg.getBoundingClientRect();
        const marks = Array.from(svg.querySelectorAll<SVGGraphicsElement>(".lcd-segment, .lcd-colon circle"));
        return marks.map((mark) => {
          const rect = mark.getBoundingClientRect();
          return {
            left: rect.left - frame.left,
            top: rect.top - frame.top,
            right: frame.right - rect.right,
            bottom: frame.bottom - rect.bottom,
          };
        });
      });
      expect(bounds.length).toBeGreaterThan(4);
      for (const bound of bounds) {
        expect(bound.left).toBeGreaterThanOrEqual(0);
        expect(bound.top).toBeGreaterThanOrEqual(0);
        expect(bound.right).toBeGreaterThanOrEqual(0);
        expect(bound.bottom).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("赛博评价支持方向键选择、回车推进和快捷键保存", async ({ page }) => {
    await page.setViewportSize({ width: 540, height: 620 });
    await routeProfile(page, "cyber");
    let payload: Record<string, unknown> | null = null;
    await page.route(`${apiBase}/api/v1/focus-sessions/current`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ session: snapshot("ended").session, snapshot: snapshot("ended") }),
    }));
    await page.route(`${apiBase}/api/v1/focus-sessions/*/evaluate`, async (route) => {
      payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ session: { ...snapshot("ended").session, state: "evaluated", version: 5 } }),
      });
    });

    await page.goto("/?focus-mini=1");
    await expect(page.locator(".focus-mini")).toHaveClass(/focus-theme-cyber/);
    const objective = page.getByRole("listbox", { name: "客观完成情况" });
    await expect(objective).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("option", { name: /部分完成/ })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    const progress = page.getByLabel("实际完成进度");
    await expect(progress).toBeFocused();
    await progress.fill("63");
    await page.keyboard.press("Enter");

    const feeling = page.getByRole("listbox", { name: "主观感受" });
    await expect(feeling).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("option", { name: /一般/ })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");

    const note = page.getByLabel("专注过程与原因");
    await expect(note).toBeFocused();
    await note.fill("终端键盘交互已完成。");
    await page.keyboard.press("Control+Enter");
    await expect(page.getByText("记录已经保存")).toBeVisible();
    expect(payload).toMatchObject({
      outcome: "partial",
      progressPercent: 63,
      satisfaction: "neutral",
      note: "终端键盘交互已完成。",
    });
  });
});
