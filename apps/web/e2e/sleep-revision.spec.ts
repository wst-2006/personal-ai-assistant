import { expect, test, type Page } from "@playwright/test";

const weekStart = "2099-01-18";
const basePlanId = "00000000-0000-4000-8000-000000000010";
const candidateId = "00000000-0000-4000-8000-000000000011";
const sleepId = "00000000-0000-4000-8000-000000000012";

const profile = {
  id: "3a1c7d0c-86ed-4e5f-b9fb-4b7df5bf93e1", version: 1,
  profile: {
    city: null, basics: { sex: "male", age: 20, heightCm: 175, weightKg: 65, bodyFatPercent: 16, waistCm: 71.5 }, goals: ["增肌"],
    stageWeightGoal: { minimumKg: 66, maximumKg: 67 }, considerations: ["左膝不适"],
    activity: { sessionsPerWeek: 5, usualDurationMinutes: { minimum: 60, maximum: 120 }, preferredActivities: ["力量训练"], avoidHighRisk: true },
    food: { mealContext: "食堂或外卖", mealTimes: { breakfast: "07:30", lunch: "12:00", dinner: "18:30" }, dislikes: ["海鲜"], commonFoods: ["番茄炒鸡蛋"] },
    supplements: { current: ["维生素 D"], considering: [], avoids: ["蛋白粉"] }, notes: null
  }
};

function plan(id: string, state: "active" | "candidate", recovery = false) {
  return {
    id, weekStart, state, source: "ai", city: null, solarTerm: "大寒", overview: recovery ? "本次只提供待确认的睡眠修订候选。" : "原本周参考保持稳定。",
    supplements: ["查看标签，避免成分重复。"], version: state === "active" ? 2 : 1,
    basedOnPlanId: recovery ? basePlanId : null, basedOnPlanVersion: recovery ? 2 : null,
    sourceSleepAnalysisId: recovery ? sleepId : null,
    revisionReason: recovery ? "基于你主动上传的 2099-01-18 睡眠截图（总睡眠 360 分钟、深睡 60 分钟）生成本次修订候选。它不会修改健康资料；确认前，原本周参考保持不变。" : null,
    days: Array.from({ length: 7 }, (_, dayIndex) => ({
      id: `00000000-0000-4000-8000-0000000001${dayIndex}`, localDate: `2099-01-${String(18 + dayIndex).padStart(2, "0")}`, dayIndex,
      content: {
        nutritionDirection: recovery && dayIndex === 0 ? "今天保持常规餐盘并优先正常进食。" : "维持正常餐盘结构。",
        proteinRangeGrams: { minimum: 90, maximum: 120 }, plateGuidance: ["每餐有主要蛋白质来源。"], seasonalVegetables: ["番茄"],
        movement: recovery && dayIndex === 0
          ? { category: "recovery", durationMinutes: { minimum: 20, maximum: 30 }, intensity: "low", highIntensity: false, safetyReminder: "按当天实际舒适度决定。" }
          : { category: "strength", durationMinutes: { minimum: 60, maximum: 90 }, intensity: "moderate", highIntensity: false, safetyReminder: "以舒适范围为先。" }
      }
    }))
  };
}

async function openHealthRevisionPage(page: Page) {
  await page.clock.setFixedTime(new Date("2099-01-18T10:00:00+08:00"));
  const active = plan(basePlanId, "active");
  const candidate = plan(candidateId, "candidate", true);
  const analysis = {
    id: sleepId, localDate: "2099-01-18", originalFileName: "sleep.png", mimeType: "image/png", createdAt: "2099-01-18T02:00:00.000Z",
    analysis: {
      totalSleepMinutes: 360, deepSleepMinutes: 60, lightSleepMinutes: null, remSleepMinutes: null, awakeCount: 3, sleepStart: null, wakeTime: null, deviceScore: 72,
      deviceNotes: null, visibleMetrics: ["总睡眠", "深睡"], interpretation: ["截图中显示睡眠时长。"], limitations: ["仅基于截图中可见信息。"]
    }
  };
  await page.route("**/api/v1/health/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/profile")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ profile }) });
    if (request.method() === "GET" && url.pathname.endsWith(`/weeks/${weekStart}`)) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ active, candidate: null }) });
    if (request.method() === "GET" && url.pathname.includes("/sleep-analyses/")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ analyses: [analysis] }) });
    if (request.method() === "POST" && url.pathname.endsWith("/sleep-revision-candidates")) return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ plan: candidate }) });
    if (request.method() === "POST" && url.pathname.endsWith(`/weeks/${candidateId}/confirm`)) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ plan: { ...candidate, state: "active", version: 2 } }) });
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "unexpected_health_request" }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "健康", exact: true }).click();
}

async function createRevisionCandidateInUi(page: Page) {
  await expect(page.getByRole("button", { name: "根据这次睡眠生成修订候选", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "根据这次睡眠生成修订候选", exact: true }).click();
  await expect(page.getByText("本次修订依据", { exact: true })).toBeVisible();
  await expect(page.getByLabel("睡眠修订前后差异").getByText("候选尚未生效", { exact: true })).toBeVisible();
  await expect(page.getByText(/运动：力量训练 60–90 分钟 -> 轻量恢复 20–30 分钟/)).toBeVisible();
}

test("睡眠截图只能在用户明确请求后生成可比较的修订候选", async ({ page }) => {
  await openHealthRevisionPage(page);
  await createRevisionCandidateInUi(page);
  await page.getByRole("button", { name: "确认并使用", exact: true }).click();
  await expect(page.getByText("本周生效版本", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("390px 下可查看睡眠修订差异并保留确认入口", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openHealthRevisionPage(page);
  await createRevisionCandidateInUi(page);
  await expect(page.getByRole("button", { name: "确认并使用", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
