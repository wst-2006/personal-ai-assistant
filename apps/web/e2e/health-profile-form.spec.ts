import { expect, test } from "@playwright/test";

const weekStart = "2099-01-18";
const profile = {
  id: "3a1c7d0c-86ed-4e5f-b9fb-4b7df5bf93e1", version: 1,
  profile: {
    city: null, basics: { sex: "male", age: 20, heightCm: 175, weightKg: 65, bodyFatPercent: 16, waistCm: 71.5 }, goals: ["增肌"],
    stageWeightGoal: { minimumKg: 66, maximumKg: 67 }, considerations: ["左膝不适"],
    activity: { sessionsPerWeek: 5, usualDurationMinutes: { minimum: 60, maximum: 120 }, preferredActivities: ["力量训练", "骑行"], avoidHighRisk: true },
    food: { mealContext: "食堂或外卖", mealTimes: { breakfast: "07:30", lunch: "12:00", dinner: "18:30" }, dislikes: ["海鲜"], commonFoods: ["番茄炒鸡蛋"] },
    supplements: { current: ["维生素 D"], considering: ["肌酸"], avoids: ["蛋白粉"] }, notes: "不需要每日打卡。"
  }
};

const activePlan = {
  id: "00000000-0000-4000-8000-000000000020", weekStart, state: "active", source: "template", city: null, solarTerm: "大寒", overview: "本周参考。",
  supplements: ["查看标签。"], version: 1, basedOnPlanId: null, basedOnPlanVersion: null, sourceSleepAnalysisId: null, revisionReason: null,
  days: Array.from({ length: 7 }, (_, dayIndex) => ({
    id: `00000000-0000-4000-8000-0000000002${dayIndex}`, localDate: `2099-01-${String(18 + dayIndex).padStart(2, "0")}`, dayIndex,
    content: {
      nutritionDirection: "维持正常餐盘结构。", proteinRangeGrams: { minimum: 90, maximum: 120 }, plateGuidance: ["每餐有蛋白质来源。"], seasonalVegetables: ["番茄"],
      movement: { category: "recovery", durationMinutes: { minimum: 20, maximum: 30 }, intensity: "low", highIntensity: false, safetyReminder: "按实际舒适度决定。" }
    }
  }))
};

test("完整健康资料表单保存所有用户主动维护的字段", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2099-01-18T10:00:00+08:00"));
  let saved: Record<string, unknown> | null = null;
  await page.route("**/api/v1/health/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/profile")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ profile }) });
    if (request.method() === "GET" && url.pathname.endsWith(`/weeks/${weekStart}`)) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ active: activePlan, candidate: null }) });
    if (request.method() === "GET" && url.pathname.includes("/sleep-analyses/")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ analyses: [] }) });
    if (request.method() === "PUT" && url.pathname.endsWith("/profile")) {
      saved = request.postDataJSON() as Record<string, unknown>;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ profile: { ...profile, version: 2, profile: (saved as { profile: unknown }).profile } }) });
    }
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "unexpected_health_request" }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "健康", exact: true }).click();
  await page.getByRole("button", { name: "查看或修改资料", exact: true }).click();
  await expect(page.getByText("基础资料", { exact: true })).toBeVisible();
  await expect(page.getByText("活动偏好", { exact: true })).toBeVisible();
  await expect(page.getByText("饮食与补充剂", { exact: true })).toBeVisible();
  await page.getByLabel("当前城市（可留空）").fill("示例城市");
  await page.getByLabel("年龄").fill("21");
  await page.getByLabel("身高（cm）").fill("176");
  await page.getByLabel("当前体重（kg）").fill("66");
  await page.getByLabel("每周活动次数").fill("4");
  await page.getByLabel("用餐场景").fill("食堂、外卖或外出时自行选择。");
  await page.getByLabel("当前补充剂").fill("鱼油，维生素 D");
  await page.getByLabel("避免高风险或容易受伤的活动建议").uncheck();
  await page.getByRole("button", { name: "保存我主动填写的资料", exact: true }).click();

  await expect.poll(() => saved).not.toBeNull();
  expect(saved).toMatchObject({
    expectedVersion: 1,
    profile: {
      city: "示例城市",
      basics: { sex: "male", age: 21, heightCm: 176, weightKg: 66, bodyFatPercent: 16, waistCm: 71.5 },
      stageWeightGoal: { minimumKg: 66, maximumKg: 67 },
      activity: { sessionsPerWeek: 4, usualDurationMinutes: { minimum: 60, maximum: 120 }, preferredActivities: ["力量训练", "骑行"], avoidHighRisk: false },
      food: { mealContext: "食堂、外卖或外出时自行选择。", mealTimes: { breakfast: "07:30", lunch: "12:00", dinner: "18:30" } },
      supplements: { current: ["鱼油", "维生素 D"], considering: ["肌酸"], avoids: ["蛋白粉"] }
    }
  });
  await expect(page.getByText("176 cm · 66 kg · 增肌", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
