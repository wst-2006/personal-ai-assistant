import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { connectVerifiedDatabase } from "@personal-ai/db/client";
import { loadDatabaseConfig } from "@personal-ai/db/config";
import {
  desktopCommandRequests,
  focusSessionSegmentRuns,
  focusSessions,
  focusStructureSegments,
  focusStructures,
  focusTimerJobs,
  inboxEntries,
  reminderJobs,
  taskConflictAcceptances,
  taskFeedback,
  taskLegacyMetadata,
  taskLifecycleEvents,
  taskOutcomes,
  tasks
} from "@personal-ai/db/schema";
import { eq, inArray, or } from "drizzle-orm";

const apiBase = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:3100";

type ParsedCandidate = {
  title: string;
  entryType: "task" | "idea" | "question";
  date: string | null;
  startAt: string | null;
  endAt: string | null;
  schedulePrecision: "exact" | "morning" | "afternoon" | "evening" | null;
  notes: string | null;
  missingFields: string[];
};

async function mockCandidateParser(page: Page, candidate: ParsedCandidate) {
  await page.route("**/api/v1/ai/tasks/parse", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ candidate })
    });
  });
}

async function openCandidate(page: Page, originalText: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "与 AI 一起整理", exact: true }).click();
  await page.getByLabel("AI 输入内容").fill(originalText);
  await page.getByRole("button", { name: "整理成候选", exact: true }).click();
  await expect(page.getByRole("heading", { name: "逐项确认后再保存", exact: true })).toBeVisible();
}

async function hardDeleteTask(id: string) {
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());
  try {
    await db.transaction(async (transaction) => {
      await transaction.delete(desktopCommandRequests).where(eq(desktopCommandRequests.taskId, id));
      await transaction.delete(reminderJobs).where(eq(reminderJobs.taskId, id));
      await transaction.delete(taskConflictAcceptances).where(or(eq(taskConflictAcceptances.taskIdLow, id), eq(taskConflictAcceptances.taskIdHigh, id)));
      await transaction.delete(taskFeedback).where(eq(taskFeedback.taskId, id));
      await transaction.delete(taskOutcomes).where(eq(taskOutcomes.taskId, id));

      const sessions = await transaction.select({ id: focusSessions.id }).from(focusSessions).where(eq(focusSessions.taskId, id));
      if (sessions.length > 0) {
        const sessionIds = sessions.map((session) => session.id);
        await transaction.delete(focusTimerJobs).where(inArray(focusTimerJobs.focusSessionId, sessionIds));
        await transaction.delete(focusSessionSegmentRuns).where(inArray(focusSessionSegmentRuns.focusSessionId, sessionIds));
        await transaction.delete(focusSessions).where(inArray(focusSessions.id, sessionIds));
      }

      const structures = await transaction.select({ id: focusStructures.id }).from(focusStructures).where(eq(focusStructures.taskId, id));
      if (structures.length > 0) {
        const structureIds = structures.map((structure) => structure.id);
        await transaction.delete(focusStructureSegments).where(inArray(focusStructureSegments.focusStructureId, structureIds));
        await transaction.delete(focusStructures).where(inArray(focusStructures.id, structureIds));
      }

      await transaction.delete(taskLegacyMetadata).where(eq(taskLegacyMetadata.taskId, id));
      await transaction.delete(taskLifecycleEvents).where(eq(taskLifecycleEvents.taskId, id));
      await transaction.delete(tasks).where(eq(tasks.id, id));
    });
  } finally {
    await client.end();
  }
}

async function findAvailableExactDate(request: APIRequestContext): Promise<string> {
  const cursor = new Date("2090-03-18T00:00:00.000Z");
  for (let offset = 0; offset < 366; offset += 1) {
    const date = cursor.toISOString().slice(0, 10);
    const response = await request.get(`${apiBase}/api/v1/tasks?date=${date}`);
    if (!response.ok()) throw new Error(`Unable to inspect candidate test date ${date}.`);
    const body = await response.json() as { tasks: Array<{
      lifecycleStatus: string;
      scheduleKind: string;
      startAt: string | null;
      endAt: string | null;
    }> };
    const incomingStart = new Date(`${date}T06:00:00.000Z`).getTime();
    const incomingEnd = new Date(`${date}T07:00:00.000Z`).getTime();
    const blocked = body.tasks.some((task) => task.scheduleKind === "exact"
      && ["open", "active", "awaiting_outcome"].includes(task.lifecycleStatus)
      && task.startAt !== null
      && task.endAt !== null
      && new Date(task.startAt).getTime() < incomingEnd
      && new Date(task.endAt).getTime() > incomingStart);
    if (!blocked) return date;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  throw new Error("No non-conflicting exact candidate date was available in the test range.");
}

test("AI 任务候选在确认前不写入，编辑后通过真实任务 API 持久化", async ({ page, request }) => {
  test.setTimeout(60_000);
  const suffix = Date.now().toString(36);
  const originalTitle = `E2E AI 原始任务 ${suffix}`;
  const editedTitle = `E2E AI 已确认任务 ${suffix}`;
  const editedNotes = `E2E AI 编辑备注 ${suffix}`;
  const editedDate = await findAvailableExactDate(request);
  let taskId: string | null = null;
  let taskWrites = 0;
  let inboxWrites = 0;

  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (request.url() === `${apiBase}/api/v1/tasks`) taskWrites += 1;
    if (request.url() === `${apiBase}/api/v1/inbox-entries`) inboxWrites += 1;
  });

  await mockCandidateParser(page, {
    title: originalTitle,
    entryType: "task",
    date: "2090-03-16",
    startAt: "2090-03-17T05:00:00.000Z",
    endAt: "2090-03-17T06:00:00.000Z",
    schedulePrecision: "exact",
    notes: "模型原始备注",
    missingFields: []
  });

  try {
    await openCandidate(page, "请在 2090 年安排一项任务");
    expect(taskWrites).toBe(0);
    expect(inboxWrites).toBe(0);
    await expect(page.getByLabel("候选日期")).toHaveValue("2090-03-17");
    await expect(page.getByLabel("候选开始时间")).toHaveAttribute("min", "07:00");
    await expect(page.getByLabel("候选开始时间")).toHaveAttribute("max", "22:30");
    await expect(page.getByLabel("候选结束时间")).toHaveAttribute("min", "07:30");
    await expect(page.getByLabel("候选结束时间")).toHaveAttribute("max", "23:00");

    await page.getByLabel("候选开始时间").fill("06:30");
    expect(await page.getByLabel("候选开始时间").evaluate((input) => (input as HTMLInputElement).validity.rangeUnderflow)).toBe(true);
    await page.getByLabel("候选开始时间").fill("14:00");
    await page.getByLabel("候选结束时间").fill("23:30");
    expect(await page.getByLabel("候选结束时间").evaluate((input) => (input as HTMLInputElement).validity.rangeOverflow)).toBe(true);
    await page.getByLabel("候选结束时间").fill("15:00");

    await page.getByLabel("候选标题").fill(editedTitle);
    await page.getByLabel("候选日期").fill(editedDate);
    await page.getByLabel("候选开始时间").fill("14:00");
    await page.getByLabel("候选结束时间").fill("15:00");
    await page.getByLabel("候选备注").fill(editedNotes);

    const [response] = await Promise.all([
      page.waitForResponse((candidateResponse) => candidateResponse.url() === `${apiBase}/api/v1/tasks`
        && candidateResponse.request().method() === "POST"),
      page.getByRole("button", { name: "确认并保存任务", exact: true }).click()
    ]);
    if (response.status() !== 201) {
      throw new Error(`Task candidate save returned ${response.status()}: ${await response.text()}`);
    }
    const task = (await response.json()).task as {
      id: string;
      title: string;
      scheduleKind: string;
      localDate: string;
      startAt: string;
      endAt: string;
      notes: string | null;
    };
    taskId = task.id;

    expect(taskWrites).toBe(1);
    expect(inboxWrites).toBe(0);
    expect(task).toMatchObject({
      title: editedTitle,
      scheduleKind: "exact",
      localDate: editedDate,
      startAt: `${editedDate}T06:00:00.000Z`,
      endAt: `${editedDate}T07:00:00.000Z`,
      notes: editedNotes
    });

    const persisted = await request.get(`${apiBase}/api/v1/tasks/${task.id}`);
    expect(persisted.status()).toBe(200);
    expect((await persisted.json()).task).toMatchObject({
      id: task.id,
      title: editedTitle,
      scheduleKind: "exact",
      localDate: editedDate,
      notes: editedNotes
    });

    await page.getByLabel("时间轴日期").fill(editedDate);
    await expect(page.locator(`[data-task-id="${task.id}"]`)).toContainText(editedTitle);
    await page.reload();
    await page.getByLabel("时间轴日期").fill(editedDate);
    await expect(page.locator(`[data-task-id="${task.id}"]`)).toContainText("14:00–15:00");
  } finally {
    if (taskId) await hardDeleteTask(taskId);
  }
});

test("AI 服务失败时保留原句且不写入，明确重试后才允许确认落库", async ({ page, request }) => {
  test.setTimeout(60_000);
  const suffix = Date.now().toString(36);
  const originalText = `明天整理 E2E 恢复任务 ${suffix}`;
  const title = `E2E AI 恢复任务 ${suffix}`;
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  let parseAttempts = 0;
  let taskWrites = 0;
  let inboxWrites = 0;
  let taskId: string | null = null;

  await page.route("**/api/v1/ai/tasks/parse", async (route) => {
    parseAttempts += 1;
    if (parseAttempts === 1) {
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "ai_unavailable", message: "AI 暂时无法整理这条内容，原始输入没有丢失。" })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidate: {
          title, entryType: "task", date: localDate, startAt: null, endAt: null,
          schedulePrecision: null, notes: "来自恢复后的候选", missingFields: []
        }
      })
    });
  });
  page.on("request", (browserRequest) => {
    if (browserRequest.method() !== "POST") return;
    if (browserRequest.url() === `${apiBase}/api/v1/tasks`) taskWrites += 1;
    if (browserRequest.url() === `${apiBase}/api/v1/inbox-entries`) inboxWrites += 1;
  });

  try {
    await page.goto("/");
    await page.getByRole("button", { name: "与 AI 一起整理", exact: true }).click();
    await page.getByLabel("AI 输入内容").fill(originalText);
    await page.getByRole("button", { name: "整理成候选", exact: true }).click();

    await expect(page.getByRole("alert")).toContainText("这次没有生成候选");
    await expect(page.getByRole("alert")).toContainText("没有创建任务、想法或问题");
    await expect(page.getByLabel("AI 输入内容")).toHaveValue(originalText);
    await expect(page.getByRole("heading", { name: "逐项确认后再保存", exact: true })).toHaveCount(0);
    expect(taskWrites).toBe(0);
    expect(inboxWrites).toBe(0);

    await page.getByRole("button", { name: "重新整理", exact: true }).click();
    await expect(page.getByRole("heading", { name: "逐项确认后再保存", exact: true })).toBeVisible();
    await expect(page.getByLabel("候选标题")).toHaveValue(title);
    expect(parseAttempts).toBe(2);
    expect(taskWrites).toBe(0);
    expect(inboxWrites).toBe(0);

    const created = page.waitForResponse((response) => response.url() === `${apiBase}/api/v1/tasks`
      && response.request().method() === "POST");
    await page.getByRole("button", { name: "确认并保存任务", exact: true }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    const task = (await response.json()).task as { id: string; title: string; localDate: string | null; scheduleKind: string };
    taskId = task.id;
    expect(task).toMatchObject({ title, localDate, scheduleKind: "none" });
    expect(taskWrites).toBe(1);
    expect(inboxWrites).toBe(0);

    await page.reload();
    await expect(page.locator(`[data-task-id="${task.id}"]`)).toContainText(title);
    const persisted = await request.get(`${apiBase}/api/v1/tasks/${task.id}`);
    expect(persisted.status()).toBe(200);
    expect((await persisted.json()).task).toMatchObject({ id: task.id, title, localDate, scheduleKind: "none" });
  } finally {
    if (taskId) await hardDeleteTask(taskId);
  }
});

test("AI 候选遇到冲突时返回调整不写入也不误报失败，修改时间后可正常保存", async ({ page, request }) => {
  test.setTimeout(60_000);
  const suffix = Date.now().toString(36);
  const date = await findAvailableExactDate(request);
  const existingTitle = `E2E AI 冲突基准 ${suffix}`;
  const candidateTitle = `E2E AI 冲突候选 ${suffix}`;
  const ids: string[] = [];
  let taskWrites = 0;

  const existingResponse = await request.post(`${apiBase}/api/v1/tasks`, {
    data: {
      title: existingTitle,
      scheduleKind: "exact",
      startAt: `${date}T06:00:00.000Z`,
      endAt: `${date}T07:00:00.000Z`,
      timeZone: "Asia/Shanghai"
    }
  });
  expect(existingResponse.status()).toBe(201);
  ids.push(((await existingResponse.json()).task as { id: string }).id);

  await mockCandidateParser(page, {
    title: candidateTitle,
    entryType: "task",
    date,
    startAt: `${date}T06:00:00.000Z`,
    endAt: `${date}T07:00:00.000Z`,
    schedulePrecision: "exact",
    notes: "冲突候选仍需用户决定",
    missingFields: []
  });
  page.on("request", (browserRequest) => {
    if (browserRequest.method() === "POST" && browserRequest.url() === `${apiBase}/api/v1/tasks`) taskWrites += 1;
  });

  try {
    await openCandidate(page, "安排一项与现有任务重叠的候选");
    await page.getByRole("button", { name: "确认并保存任务", exact: true }).click();
    const conflictDialog = page.getByRole("alertdialog", { name: "这项候选与现有任务重叠" });
    await expect(conflictDialog).toBeVisible();
    await expect(conflictDialog).toContainText(existingTitle);
    await expect(conflictDialog).toContainText("14:00–15:00");
    await conflictDialog.getByRole("button", { name: "返回调整", exact: true }).click();

    await expect(conflictDialog).toBeHidden();
    await expect(page.getByRole("heading", { name: "逐项确认后再保存", exact: true })).toBeVisible();
    await expect(page.getByLabel("候选标题")).toHaveValue(candidateTitle);
    await expect(page.getByLabel("候选开始时间")).toHaveValue("14:00");
    await expect(page.getByLabel("候选结束时间")).toHaveValue("15:00");
    await expect(page.getByText("确认保存失败，候选内容仍保留在 AI 侧边层。")).toHaveCount(0);
    expect(taskWrites).toBe(1);

    const beforeRetry = await request.get(`${apiBase}/api/v1/tasks?date=${date}`);
    const beforeTasks = (await beforeRetry.json()).tasks as Array<{ id: string; title: string }>;
    expect(beforeTasks.map((task) => task.title)).not.toContain(candidateTitle);

    await page.getByLabel("候选开始时间").fill("15:00");
    await page.getByLabel("候选结束时间").fill("16:00");
    const created = page.waitForResponse((response) => response.url() === `${apiBase}/api/v1/tasks`
      && response.request().method() === "POST" && response.status() === 201);
    await page.getByRole("button", { name: "确认并保存任务", exact: true }).click();
    const task = (await (await created).json()).task as { id: string; startAt: string; endAt: string };
    ids.push(task.id);
    expect(taskWrites).toBe(2);
    expect(task.startAt).toBe(`${date}T07:00:00.000Z`);
    expect(task.endAt).toBe(`${date}T08:00:00.000Z`);

    await page.getByLabel("时间轴日期").fill(date);
    await expect(page.locator(`[data-task-id="${task.id}"]`)).toContainText(candidateTitle);
  } finally {
    for (const id of ids.reverse()) await hardDeleteTask(id);
  }
});

test("AI 想法候选不显示任务排期字段，并只写入独立 inbox", async ({ page }) => {
  test.setTimeout(60_000);
  const suffix = Date.now().toString(36);
  const originalContent = `E2E AI 原始想法 ${suffix}`;
  const editedContent = `E2E AI 已确认想法 ${suffix}`;
  const editedNotes = `E2E AI 想法备注 ${suffix}`;
  let entryId: string | null = null;
  let taskWrites = 0;
  let inboxWrites = 0;
  const { client, db } = await connectVerifiedDatabase(loadDatabaseConfig());

  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (request.url() === `${apiBase}/api/v1/tasks`) taskWrites += 1;
    if (request.url() === `${apiBase}/api/v1/inbox-entries`) inboxWrites += 1;
  });

  await mockCandidateParser(page, {
    title: originalContent,
    entryType: "idea",
    date: null,
    startAt: null,
    endAt: null,
    schedulePrecision: null,
    notes: "模型原始想法备注",
    missingFields: []
  });

  try {
    await openCandidate(page, "我有个想法");
    await expect(page.getByLabel("候选排期方式")).toHaveCount(0);
    await expect(page.getByLabel("候选日期")).toHaveCount(0);
    await expect(page.getByLabel("候选开始时间")).toHaveCount(0);
    await expect(page.getByLabel("候选结束时间")).toHaveCount(0);
    expect(taskWrites).toBe(0);
    expect(inboxWrites).toBe(0);

    await page.getByLabel("候选标题").fill(editedContent);
    await page.getByLabel("候选备注").fill(editedNotes);
    const created = page.waitForResponse((response) => response.url() === `${apiBase}/api/v1/inbox-entries`
      && response.request().method() === "POST" && response.status() === 201);
    await page.getByRole("button", { name: "确认并保存想法", exact: true }).click();
    const entry = (await (await created).json()).entry as { id: string; entryKind: string; content: string; notes: string | null };
    entryId = entry.id;

    expect(taskWrites).toBe(0);
    expect(inboxWrites).toBe(1);
    expect(entry).toMatchObject({ entryKind: "idea", content: editedContent, notes: editedNotes });
    const [persisted] = await db.select().from(inboxEntries).where(eq(inboxEntries.id, entry.id));
    expect(persisted).toMatchObject({ id: entry.id, entryKind: "idea", content: editedContent, notes: editedNotes, convertedAt: null });
  } finally {
    if (entryId) await db.delete(inboxEntries).where(eq(inboxEntries.id, entryId));
    await client.end();
  }
});

test("390px 下可编辑精确任务候选且不发生横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockCandidateParser(page, {
    title: "E2E 移动 AI 候选",
    entryType: "task",
    date: "2090-04-01",
    startAt: "2090-04-01T01:00:00.000Z",
    endAt: "2090-04-01T02:00:00.000Z",
    schedulePrecision: "exact",
    notes: null,
    missingFields: []
  });

  await openCandidate(page, "安排移动端候选");
  await expect(page.getByLabel("候选开始时间")).toHaveAttribute("step", "1800");
  await expect(page.getByLabel("候选结束时间")).toHaveAttribute("step", "1800");
  await expect(page.getByLabel("候选开始时间")).toHaveAttribute("min", "07:00");
  await expect(page.getByLabel("候选开始时间")).toHaveAttribute("max", "22:30");
  await expect(page.getByLabel("候选结束时间")).toHaveAttribute("min", "07:30");
  await expect(page.getByLabel("候选结束时间")).toHaveAttribute("max", "23:00");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
