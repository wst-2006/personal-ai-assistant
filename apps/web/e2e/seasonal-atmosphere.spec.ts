import { expect, test } from "@playwright/test";
import { SOLAR_TERM_MOTIFS, resolveSolarTerm, shanghaiDateKey, solarTermStart } from "../src/solar-terms";

test("全年 24 节气按真实太阳黄经顺序解析并覆盖跨年边界", () => {
  expect(SOLAR_TERM_MOTIFS).toHaveLength(24);
  expect(SOLAR_TERM_MOTIFS.map((motif) => motif.term)).toEqual([
    "小寒", "大寒", "立春", "雨水", "惊蛰", "春分", "清明", "谷雨",
    "立夏", "小满", "芒种", "夏至", "小暑", "大暑", "立秋", "处暑",
    "白露", "秋分", "寒露", "霜降", "立冬", "小雪", "大雪", "冬至",
  ]);

  const starts = SOLAR_TERM_MOTIFS.map((_, index) => solarTermStart(2026, index));
  for (let index = 1; index < starts.length; index += 1) {
    const intervalDays = (starts[index]!.getTime() - starts[index - 1]!.getTime()) / 86_400_000;
    expect(intervalDays).toBeGreaterThan(14);
    expect(intervalDays).toBeLessThan(17);
  }
  expect(shanghaiDateKey(starts[0]!)).toBe("2026-01-05");
  expect(shanghaiDateKey(starts[3]!)).toBe("2026-02-18");
  expect(shanghaiDateKey(starts[10]!)).toBe("2026-06-05");
  expect(shanghaiDateKey(starts[14]!)).toBe("2026-08-07");
  expect(shanghaiDateKey(starts[23]!)).toBe("2026-12-22");

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!;
    expect(resolveSolarTerm(new Date(start.getTime() + 1_000)).term).toBe(SOLAR_TERM_MOTIFS[index]!.term);
    expect(resolveSolarTerm(new Date(start.getTime() - 1_000)).index).toBe((index + 23) % 24);
  }

  expect(resolveSolarTerm("2026-08-14").term).toBe("立秋");
  expect(resolveSolarTerm("2026-12-22")).toMatchObject({ term: "冬至", season: "冬", plant: "梅", note: "一阳初生", accent: "sun" });
});

test("今日页日期切换会同步更换节气题字、植物和气象印记", async ({ page }) => {
  await page.goto("/");
  const datePicker = page.getByLabel("时间轴日期");
  await expect(datePicker).toBeVisible();
  const datePickerIcon = page.locator(".date-picker-icon");
  await expect(datePickerIcon).toHaveCount(1);
  await expect(datePickerIcon).toHaveCSS("pointer-events", "none");
  await datePicker.hover();
  await expect(datePickerIcon).toHaveCSS("opacity", "1");
  const seasonal = page.locator(".seasonal-corner");
  const cases = [
    { date: "2026-02-18", term: "雨水", season: "春", plant: "兰", accent: "rain" },
    { date: "2026-06-21", term: "夏至", season: "夏", plant: "荷", accent: "sun" },
    { date: "2026-08-23", term: "处暑", season: "秋", plant: "菊", accent: "breeze" },
    { date: "2026-09-23", term: "秋分", season: "秋", plant: "菊", accent: "balance" },
    { date: "2026-12-22", term: "冬至", season: "冬", plant: "梅", accent: "sun" },
  ];
  for (const item of cases) {
    await datePicker.fill(item.date);
    await expect(seasonal).toHaveAttribute("data-solar-term", item.term);
    await expect(seasonal).toHaveAttribute("data-season", item.season);
    await expect(seasonal).toHaveAttribute("data-plant", item.plant);
    await expect(seasonal).toHaveAttribute("data-accent", item.accent);
    await expect(seasonal.locator(".seasonal-caption")).toContainText(item.term);
    await expect(seasonal.locator(".seasonal-caption")).toContainText(item.plant);
  }
});

test("专注页与复盘页各自展示一株带动效的案头植物", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "专注" }).click();
  const focusPlant = page.locator(".focus-page-plant");
  await expect(focusPlant).toHaveAttribute("data-plant", "兰");
  await expect(focusPlant).toHaveAttribute("data-accent", "rain");
  await expect(focusPlant).toHaveAttribute("aria-label", /幽兰自守/u);

  await page.getByRole("button", { name: "复盘" }).click();
  const reviewPlant = page.locator(".review-page-plant");
  await expect(reviewPlant).toHaveAttribute("data-plant", "梅");
  await expect(reviewPlant).toHaveAttribute("data-accent", "frost");
  await expect(reviewPlant).toHaveAttribute("aria-label", /疏影留白/u);
});

test("页面会在上海午夜自动进入新的一天", async ({ page }) => {
  await page.addInitScript(() => {
    const RealDate = Date;
    const base = RealDate.parse("2026-08-23T15:59:58.500Z");
    const startedAt = performance.now();
    const now = () => base + (performance.now() - startedAt);
    class MidnightDate extends RealDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        if (args.length === 0) {
          super(now());
        } else {
          super(...args);
        }
      }

      static now() {
        return now();
      }
    }
    Object.defineProperty(window, "Date", { configurable: true, value: MidnightDate });
  });

  await page.goto("/");
  const datePicker = page.getByLabel("时间轴日期");
  await expect(datePicker).toHaveValue("2026-08-23");
  await expect.poll(() => datePicker.inputValue(), { timeout: 7_000 }).toBe("2026-08-24");
  await expect(page.locator(".seasonal-corner")).toHaveAttribute("data-solar-term", "处暑");
});
